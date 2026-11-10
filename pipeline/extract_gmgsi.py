import os
import sys
import json
import glob
import datetime
import numpy as np
import xarray as xr
import s3fs

# Define the Indian regional bounding box (Arabian Sea, Bay of Bengal, Sri Lanka to below Equator)
LAT_MIN = -10.0
LAT_MAX = 38.5
LON_MIN = 50.0
LON_MAX = 105.0

PRODUCTS = {
    'LW': 'GMGSI_LW',   # Longwave IR (10.8 µm)
    'WV': 'GMGSI_WV',   # Water Vapor (6.7 µm)
    'VIS': 'GMGSI_VIS', # Visible (0.6 µm)
    'SW': 'GMGSI_SW'    # Shortwave IR (3.9 µm)
}

HOURS_TO_KEEP = 24

def get_recent_hours(hours_back=12):
    now = datetime.datetime.now(datetime.timezone.utc)
    return [now - datetime.timedelta(hours=i) for i in reversed(range(hours_back))]

def find_s3_file(fs, product_dir, dt):
    prefix = f"noaa-gmgsi-pds/{product_dir}/{dt.strftime('%Y/%m/%d/%H')}/"
    try:
        files = fs.ls(prefix)
        nc_files = [f for f in files if f.endswith('.nc')]
        if nc_files:
            return nc_files[-1]
    except Exception:
        pass
    return None

def process_file(fs, file_path):
    with fs.open(file_path) as f:
        ds = xr.open_dataset(f)
        lats = ds.lat[:, 0].values
        lons = ds.lon[0, :].values

        lat_mask = (lats >= LAT_MIN) & (lats <= LAT_MAX)
        lon_mask = (lons >= LON_MIN) & (lons <= LON_MAX)

        lat_idx = np.where(lat_mask)[0]
        lon_idx = np.where(lon_mask)[0]

        sub_data = ds['data'].values[0, lat_idx.min():lat_idx.max()+1, lon_idx.min():lon_idx.max()+1]
        
        # Normalize and convert to uint8
        sub_data = np.nan_to_num(sub_data, nan=0.0)
        sub_data = np.clip(sub_data, 0, 255).astype(np.uint8)

        lat_bounds = [float(lats[lat_idx.max()]), float(lats[lat_idx.min()])]
        lon_bounds = [float(lons[lon_idx.min()]), float(lons[lon_idx.max()])]

        return sub_data, lat_bounds, lon_bounds, sub_data.shape

def prune_old_frames(frames_dir, valid_filenames):
    for f in glob.glob(os.path.join(frames_dir, '*.bin')):
        basename = os.path.basename(f)
        if basename not in valid_filenames:
            try:
                os.remove(f)
                print(f"Pruned older frame: {basename}")
            except Exception as e:
                print(f"Could not remove {basename}: {e}")

def main():
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    data_dir = os.path.join(base_dir, 'data')
    frames_dir = os.path.join(data_dir, 'frames')
    os.makedirs(frames_dir, exist_ok=True)

    fs = s3fs.S3FileSystem(anon=True)
    recent_dts = get_recent_hours(hours_back=HOURS_TO_KEEP)

    frames_meta = []
    grid_meta = None
    all_created_files = set()

    print(f"Scanning NOAA GMGSI bucket for {len(recent_dts)} time windows...")

    for dt in recent_dts:
        dt_str = dt.strftime('%Y%m%d%H')
        iso_str = dt.strftime('%Y-%m-%dT%H:00:00Z')
        frame_entry = {
            'timestamp': iso_str,
            'id': dt_str,
            'products': {}
        }

        has_any = False
        for prod_key, prod_dir in PRODUCTS.items():
            bin_filename = f"{prod_key}_{dt_str}.bin"
            all_created_files.add(bin_filename)
            bin_path = os.path.join(frames_dir, bin_filename)
            
            if not os.path.exists(bin_path):
                s3_file = find_s3_file(fs, prod_dir, dt)
                if not s3_file:
                    continue

                print(f"Extracting {prod_key} for {dt_str} from {s3_file}...")
                try:
                    data_uint8, lat_b, lon_b, shape = process_file(fs, s3_file)
                    with open(bin_path, 'wb') as bf:
                        bf.write(data_uint8.tobytes())

                    if grid_meta is None:
                        grid_meta = {
                            'rows': int(shape[0]),
                            'cols': int(shape[1]),
                            'lat_min': lat_b[0],
                            'lat_max': lat_b[1],
                            'lon_min': lon_b[0],
                            'lon_max': lon_b[1]
                        }
                    has_any = True
                except Exception as e:
                    print(f"Error processing {s3_file}: {e}")
                    continue
            else:
                has_any = True

            frame_entry['products'][prod_key] = f"frames/{bin_filename}"

        if has_any:
            frames_meta.append(frame_entry)

    # Prune frames older than HOURS_TO_KEEP
    prune_old_frames(frames_dir, all_created_files)

    if grid_meta is None:
        grid_meta = {
            'rows': 720,
            'cols': 763,
            'lat_min': -9.959,
            'lat_max': 38.493,
            'lon_min': 50.068,
            'lon_max': 104.939
        }

    manifest = {
        'last_updated': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'grid': grid_meta,
        'available_products': list(PRODUCTS.keys()),
        'frames': frames_meta
    }

    manifest_path = os.path.join(data_dir, 'manifest.json')
    with open(manifest_path, 'w') as mf:
        json.dump(manifest, mf, indent=2)

    print(f"\nManifest updated at {manifest_path} with {len(frames_meta)} frames.")

if __name__ == '__main__':
    main()
