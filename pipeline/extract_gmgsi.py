"""
NOAA GMGSI -> India regional frame extractor.

Pipeline steps (all optional flags, safe to run locally with no flags):

  1. --restore-from URL   Pull the frames that are already live on the website
                          (manifest + .bin files) so that history does not have
                          to be committed to git or re-downloaded from NOAA.
  2. --wait-minutes N     Poll the NOAA S3 bucket until the hour after the newest
                          frame we hold has been published (NOAA posts hour HH at
                          roughly HH:39 UTC), or until N minutes have passed.
  3. Extract every hour in the rolling window that is missing locally.
  4. Write data/manifest.json and (in GitHub Actions) a `changed` output.
"""
import os
import sys
import json
import glob
import time
import argparse
import datetime
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import xarray as xr
import s3fs

# Indian regional bounding box (Arabian Sea, Bay of Bengal, Sri Lanka to below the Equator)
LAT_MIN = -10.0
LAT_MAX = 38.5
LON_MIN = 50.0
LON_MAX = 105.0

BUCKET = 'noaa-gmgsi-pds'
PRODUCTS = {
    'LW': 'GMGSI_LW',   # Longwave IR (10.8 µm)
    'WV': 'GMGSI_WV',   # Water Vapour (6.7 µm)
    'VIS': 'GMGSI_VIS', # Visible (0.6 µm)
    'SW': 'GMGSI_SW'    # Shortwave IR (3.9 µm)
}
TRIGGER_PRODUCT = 'LW'   # a new hour is considered "published" once this product lands

HOURS_TO_KEEP = int(os.environ.get('HOURS_TO_KEEP', '24'))
POLL_SECONDS = 60
NOAA_PUBLISH_MINUTE = 36  # start polling a little before the usual HH:39 upload

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DATA_DIR = os.path.join(BASE_DIR, 'data')
FRAMES_DIR = os.path.join(DATA_DIR, 'frames')
MANIFEST_PATH = os.path.join(DATA_DIR, 'manifest.json')

DEFAULT_GRID = {
    'rows': 720, 'cols': 763,
    'lat_min': -9.958709716796875, 'lat_max': 38.492828369140625,
    'lon_min': 50.068233489990234, 'lon_max': 104.93905639648438
}


def log(msg):
    print(f"[{datetime.datetime.now(datetime.timezone.utc):%H:%M:%S}Z] {msg}", flush=True)


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc)


def floor_hour(dt):
    return dt.replace(minute=0, second=0, microsecond=0)


def window_hours(now=None):
    # One extra hour, because the current hour is normally not yet published.
    now = floor_hour(now or utc_now())
    return [now - datetime.timedelta(hours=i) for i in reversed(range(HOURS_TO_KEEP + 1))]


def hour_id(dt):
    return dt.strftime('%Y%m%d%H')


def parse_hour_id(s):
    return datetime.datetime.strptime(s, '%Y%m%d%H').replace(tzinfo=datetime.timezone.utc)


def bin_path(prod, hid):
    return os.path.join(FRAMES_DIR, f"{prod}_{hid}.bin")


def have(prod, hid):
    p = bin_path(prod, hid)
    return os.path.exists(p) and os.path.getsize(p) > 0


def load_manifest():
    if os.path.exists(MANIFEST_PATH):
        try:
            with open(MANIFEST_PATH) as f:
                return json.load(f)
        except Exception:
            pass
    return None


# ---------------------------------------------------------------- restore ---
def restore_from_site(base_url):
    """Download frames already published on the website (GitHub Pages)."""
    base_url = base_url.rstrip('/') + '/'
    url = f"{base_url}data/manifest.json?t={int(time.time())}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            live = json.load(r)
    except Exception as e:
        log(f"Restore: could not read live manifest ({e}); will rebuild from NOAA.")
        return None

    wanted = {hour_id(h) for h in window_hours()}
    jobs = []
    for fr in live.get('frames', []):
        if fr.get('id') not in wanted:
            continue
        for prod, rel in fr.get('products', {}).items():
            if not have(prod, fr['id']):
                jobs.append((f"{base_url}data/{rel}", bin_path(prod, fr['id'])))

    expected = DEFAULT_GRID['rows'] * DEFAULT_GRID['cols']
    grid = live.get('grid')
    if grid:
        expected = grid['rows'] * grid['cols']

    def fetch(job):
        src, dst = job
        try:
            with urllib.request.urlopen(src, timeout=60) as r:
                data = r.read()
            if len(data) != expected:
                return False
            tmp = dst + '.part'
            with open(tmp, 'wb') as f:
                f.write(data)
            os.replace(tmp, dst)
            return True
        except Exception:
            return False

    with ThreadPoolExecutor(max_workers=8) as ex:
        ok = sum(ex.map(fetch, jobs))
    log(f"Restore: {ok}/{len(jobs)} frame files copied from the live site.")
    return live


# ------------------------------------------------------------------- NOAA ---
def find_s3_file(fs, product_dir, dt, refresh=False):
    prefix = f"{BUCKET}/{product_dir}/{dt.strftime('%Y/%m/%d/%H')}/"
    try:
        files = fs.ls(prefix, refresh=refresh)
        nc_files = sorted(f for f in files if f.endswith('.nc'))
        if nc_files:
            return nc_files[-1]
    except FileNotFoundError:
        pass
    except Exception as e:
        log(f"S3 listing error for {prefix}: {e}")
    return None


def process_file(fs, file_path):
    with tempfile.NamedTemporaryFile(suffix='.nc', delete=False) as tmp:
        tmp_path = tmp.name
    try:
        fs.get(file_path, tmp_path)
        with xr.open_dataset(tmp_path) as ds:
            lats = ds.lat[:, 0].values
            lons = ds.lon[0, :].values
            lat_idx = np.where((lats >= LAT_MIN) & (lats <= LAT_MAX))[0]
            lon_idx = np.where((lons >= LON_MIN) & (lons <= LON_MAX))[0]
            sub = ds['data'].values[0, lat_idx.min():lat_idx.max() + 1, lon_idx.min():lon_idx.max() + 1]
            sub = np.clip(np.nan_to_num(sub, nan=0.0), 0, 255).astype(np.uint8)
            grid = {
                'rows': int(sub.shape[0]), 'cols': int(sub.shape[1]),
                'lat_min': float(lats[lat_idx.max()]), 'lat_max': float(lats[lat_idx.min()]),
                'lon_min': float(lons[lon_idx.min()]), 'lon_max': float(lons[lon_idx.max()])
            }
            return sub, grid
    finally:
        try:
            os.remove(tmp_path)
        except Exception:
            pass


def newest_local_hour():
    hours = [parse_hour_id(os.path.basename(p)[len(TRIGGER_PRODUCT) + 1:-4])
             for p in glob.glob(os.path.join(FRAMES_DIR, f"{TRIGGER_PRODUCT}_*.bin"))]
    return max(hours) if hours else None


def wait_for_next_hour(fs, wait_minutes):
    """Block until NOAA has published the hour after our newest frame (or timeout)."""
    if wait_minutes <= 0:
        return False
    newest = newest_local_hour()
    if newest is None:
        return True
    target = newest + datetime.timedelta(hours=1)
    deadline = time.time() + wait_minutes * 60
    log(f"Waiting for NOAA to publish {target:%Y-%m-%d %H}:00 UTC "
        f"(newest held: {newest:%H}:00 UTC, timeout {wait_minutes} min)")

    while True:
        if find_s3_file(fs, PRODUCTS[TRIGGER_PRODUCT], target, refresh=True):
            log(f"NOAA frame for {target:%H}:00 UTC is available.")
            return True
        now = utc_now()
        expected_at = target + datetime.timedelta(minutes=NOAA_PUBLISH_MINUTE)
        sleep_for = POLL_SECONDS
        if now < expected_at:
            sleep_for = max(POLL_SECONDS, (expected_at - now).total_seconds())
        if time.time() + sleep_for > deadline:
            remaining = deadline - time.time()
            if remaining <= 5:
                log("Wait timed out without a new NOAA frame.")
                return False
            sleep_for = remaining
        log(f"Not published yet; sleeping {int(sleep_for)} s")
        time.sleep(sleep_for)


# ------------------------------------------------------------------- main ---
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--restore-from', default=os.environ.get('RESTORE_FROM', ''))
    ap.add_argument('--wait-minutes', type=float, default=float(os.environ.get('WAIT_MINUTES', '0')))
    ap.add_argument('--build-sha', default=os.environ.get('BUILD_SHA', ''))
    args = ap.parse_args()

    os.makedirs(FRAMES_DIR, exist_ok=True)
    previous = load_manifest()
    live = restore_from_site(args.restore_from) if args.restore_from else None
    if live is not None:
        previous = live

    code_changed = bool(args.build_sha) and (previous or {}).get('build_sha') != args.build_sha
    if code_changed:
        log("Site code differs from the deployed build: deploying without waiting.")

    fs = s3fs.S3FileSystem(anon=True)
    if not code_changed:
        wait_for_next_hour(fs, args.wait_minutes)

    hours = window_hours()
    log(f"Scanning {len(hours)} hourly windows: {hours[0]:%d %b %H}:00 to {hours[-1]:%d %b %H}:00 UTC")

    grid = (previous or {}).get('grid') or DEFAULT_GRID
    frames, extracted = [], 0
    for dt in hours:
        hid = hour_id(dt)
        entry = {'timestamp': dt.strftime('%Y-%m-%dT%H:00:00Z'), 'id': hid, 'products': {}}
        for prod, prod_dir in PRODUCTS.items():
            if not have(prod, hid):
                s3_file = find_s3_file(fs, prod_dir, dt, refresh=True)
                if not s3_file:
                    continue
                log(f"Extracting {prod} {hid} <- {s3_file.split('/')[-1]}")
                try:
                    data, g = process_file(fs, s3_file)
                    with open(bin_path(prod, hid), 'wb') as f:
                        f.write(data.tobytes())
                    grid = g
                    extracted += 1
                except Exception as e:
                    log(f"Error processing {s3_file}: {e}")
                    if os.path.exists(bin_path(prod, hid)):
                        os.remove(bin_path(prod, hid))
                    continue
            entry['products'][prod] = f"frames/{prod}_{hid}.bin"
        if entry['products']:
            frames.append(entry)

    frames = frames[-HOURS_TO_KEEP:]

    # Prune files outside the rolling window (only when the window is reasonably full)
    keep = {os.path.basename(p) for fr in frames for p in fr['products'].values()}
    if len(frames) >= HOURS_TO_KEEP // 2:
        for f in glob.glob(os.path.join(FRAMES_DIR, '*.bin')):
            if os.path.basename(f) not in keep:
                os.remove(f)

    prev_ids = [(fr['id'], sorted(fr.get('products', {}))) for fr in (previous or {}).get('frames', [])]
    new_ids = [(fr['id'], sorted(fr['products'])) for fr in frames]
    data_changed = extracted > 0 or prev_ids != new_ids

    manifest = {
        'last_updated': utc_now().isoformat(timespec='seconds'),
        'latest_frame': frames[-1]['timestamp'] if frames else None,
        'build_sha': args.build_sha or (previous or {}).get('build_sha', ''),
        'source': f"s3://{BUCKET}",
        'grid': grid,
        'available_products': list(PRODUCTS.keys()),
        'frames': frames
    }
    with open(MANIFEST_PATH, 'w') as mf:
        json.dump(manifest, mf, indent=1)

    changed = data_changed or code_changed
    log(f"Manifest written: {len(frames)} frames, latest {manifest['latest_frame']}, "
        f"{extracted} new files, changed={changed}")

    gh_out = os.environ.get('GITHUB_OUTPUT')
    if gh_out:
        with open(gh_out, 'a') as f:
            f.write(f"changed={'true' if changed else 'false'}\n")
            f.write(f"frames={len(frames)}\n")
            f.write(f"latest={manifest['latest_frame']}\n")

    if not frames:
        log("No frames available at all; failing so the broken site is not deployed.")
        sys.exit(1)


if __name__ == '__main__':
    main()
