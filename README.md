# 🛰️ India Satellite Tracker - GMGSI

High-performance WebAssembly (WASM) application to visualize real-time geostationary satellite imagery over the Indian subcontinent, Arabian Sea, Bay of Bengal, Sri Lanka, and equatorial Indian Ocean from NOAA's Global Mosaic of Geostationary Satellite Imagery ([NOAA GMGSI on AWS Open Data](https://registry.opendata.aws/noaa-gmgsi/)).

Designed to be hosted directly on **GitHub Pages** with **zero server dependencies** and **zero user installation**.

---

## 🌟 Key Features

* **⚡ Pure WebAssembly Raster Engine (2.4 KB):**
  * Sub-millisecond on-the-fly rendering and palette color mapping at 60 FPS.
  * Real-time meteorological color curves:
    * **BD Enhancement (Dvorak Tropical Cyclone Curve)** for convection, cloud tops, and tropical storm tracking.
    * **Water Vapor Dynamics** for upper-tropospheric moisture plumes and jet streams.
    * **Visible Daylight Enhanced** with gamma-corrected cloud reflectance.
    * **White-Hot / Black-Hot** standard thermal infrared grayscale.
    * **Turbo / Rainbow Spectrum** for multi-spectral temperature differentials.
  * **⚡ Convection Alert Mode:** Instant visual segmentation of severe storm overshoot tops ($T < -55^\circ\text{C}$ to $< -80^\circ\text{C}$).
* **🇮🇳 High-Precision India State Boundaries:**
  * Clean vector overlay of all 36 Indian States and Union Territories derived from local state boundary shapefiles.
  * Optimized topology with responsive state name tooltips.
* **🌡️ Interactive Telemetry & Pixel Probing:**
  * Cursor and touch probing with an approximate brightness temperature in **Celsius (°C)** and **Kelvin (K)** (linear conversion from 0–255 counts; indicative only).
* **⏱️ Smooth Timeline Player:**
  * Interactive 24-hour time scrubber with play, pause, and step-forward/backward animation loop controls.
* **🤖 Near-real-time updates (GitHub Actions):**
  * A self-chaining workflow waits for NOAA to publish each hourly mosaic (about HH:39 UTC), extracts the Indian Ocean slice and redeploys the site within minutes.
  * A freshness badge (LIVE / DELAYED / STALE) shows how old the newest frame is, and open pages pick up new frames automatically every few minutes.

---

## 🗺️ Spatial & Meteorological Coverage

| Parameter | Value |
| :--- | :--- |
| **Latitude Extent** | `-9.96° S` to `38.49° N` (Equatorial belt, Sri Lanka, Maldives up to Ladakh) |
| **Longitude Extent** | `50.07° E` to `104.94° E` (Arabian Sea, Gulf of Oman, Bay of Bengal, Andaman Sea) |
| **Grid Dimensions** | 720 Rows × 763 Columns (~549 KB per raw frame) |
| **Spectral Channels** | **LWIR (10.8 µm)**, **WV (6.7 µm)**, **VIS (0.6 µm)**, **SWIR (3.9 µm)** |
| **Update Cadence** | Hourly; each frame appears on the site ~40–45 min after its nominal time |

---

## 🚀 Quick Start / Local Testing

To test the application locally on your computer:

Generated imagery is not stored in git, so pull the current frames from the live site first:

```bash
cd gmgsi_india_satellite_app
pip install -r pipeline/requirements.txt
python pipeline/extract_gmgsi.py --restore-from https://mrafiuddin50.github.io/indian-satellite-tracker/
python -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000) in any browser (Chrome, Edge, Firefox, Safari).

---

## 🌐 Deploying to GitHub Pages (Step-by-Step)

### 1. Initialize Git and Push to GitHub

From `d:\aq_dashboard\thane_dashboard_data\gmgsi_india_satellite_app`:

```bash
git init
git add .
git commit -m "Initial commit: NOAA GMGSI Indian Ocean WebAssembly Satellite App"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo-name>.git
git push -u origin main
```

### 2. Enable GitHub Pages

In **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**. The workflow builds and deploys the site itself.

### 3. How the automatic updates work

[`.github/workflows/update_and_deploy.yml`](.github/workflows/update_and_deploy.yml):

1. Restores the frames that are already live on the site (the imagery is **not** committed to git, which keeps the repository small).
2. Waits until NOAA publishes the next hourly GMGSI mosaic on `s3://noaa-gmgsi-pds` (normally ~HH:39 UTC), extracts it and fills any gaps in the 24-hour window.
3. Deploys to GitHub Pages, then queues the next run with `workflow_dispatch`, so a run is always waiting for the next frame.

GitHub's `schedule` trigger is best-effort and was firing only every 4–8 hours on this repository, which is why the site used to lag. The cron entries are now only a safety net that restarts the chain. To switch the chain off (for example if you trigger the workflow from an external scheduler), add a repository variable `SELF_CHAIN` = `false`.

You can also run it manually from **Actions → Auto Update Satellite Imagery & Deploy to Pages → Run workflow** (set *wait_minutes* to `0` to deploy immediately).

---

## 🛠️ Project Structure

```
gmgsi_india_satellite_app/
├── index.html                   # Main web dashboard interface
├── css/
│   └── style.css                # Meteorological HUD styling
├── js/
│   ├── app.js                   # Application coordinator & Leaflet integration
│   └── wasm_engine.js           # WebAssembly JavaScript bridge
├── wasm/
│   └── raster_engine.wasm       # Compiled native WebAssembly binary (2.4 KB)
├── wasm_src/                    # Rust source code for the WASM engine
│   ├── Cargo.toml
│   └── src/lib.rs
├── data/
│   ├── india_states.geojson     # Optimized India state boundaries (EPSG:4326)
│   ├── manifest.json            # Generated: frame timestamps, bounds, product indices (not in git)
│   └── frames/                  # Generated: hourly uint8 raster slices LW/WV/VIS/SW_*.bin (not in git)
├── pipeline/
│   ├── extract_gmgsi.py         # NOAA GMGSI S3 ingestion & cropping script
│   └── requirements.txt         # Python dependencies (xarray, netCDF4, h5netcdf, s3fs, numpy)
└── .github/workflows/
    └── update_and_deploy.yml    # Wait-for-NOAA, extract, deploy, re-queue
```

---

## 🔬 WebAssembly Architecture

The raster compute engine is written in Rust (`no_std`) and compiled directly to the `wasm32-unknown-unknown` target. It directly operates on linear WebAssembly memory buffers:

* **Zero Garbage Collection Overhead:** Fixed memory layout with zero allocation during animation frames.
* **Instant Dynamic Colormapping:** Converts single-channel 8-bit satellite counts into 32-bit RGBA pixels in $< 1\text{ ms}$.
* **Temperature Formula (approximation, indicative only):** Inverts GMGSI digital counts ($DN$) to physical brightness temperature ($T_b$) via:
  $$T_b(^\circ\text{C}) \approx 40.0 - 0.4902 \times DN$$
  $$T_b(\text{K}) = T_b(^\circ\text{C}) + 273.15$$
