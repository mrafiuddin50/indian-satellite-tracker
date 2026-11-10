# 🛰️ NOAA GMGSI Real-Time Indian Ocean Satellite Radar

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
  * Real-time cursor and touch probing calculating exact physical brightness temperature in both **Celsius (°C)** and **Kelvin (K)**.
* **⏱️ Smooth Timeline Player:**
  * Interactive 24-hour time scrubber with play, pause, and step-forward/backward animation loop controls.
* **🤖 Automated Real-Time Cloud Updates (GitHub Actions):**
  * A GitHub Actions workflow runs every hour, fetches the latest NOAA GMGSI frame from AWS S3, extracts the Indian Ocean slice, and updates the live site automatically.

---

## 🗺️ Spatial & Meteorological Coverage

| Parameter | Value |
| :--- | :--- |
| **Latitude Extent** | `-9.96° S` to `38.49° N` (Equatorial belt, Sri Lanka, Maldives up to Ladakh) |
| **Longitude Extent** | `50.07° E` to `104.94° E` (Arabian Sea, Gulf of Oman, Bay of Bengal, Andaman Sea) |
| **Grid Dimensions** | 720 Rows × 763 Columns (~549 KB per raw frame) |
| **Spectral Channels** | **LWIR (10.8 µm)**, **WV (6.7 µm)**, **VIS (0.6 µm)**, **SWIR (3.9 µm)** |
| **Update Cadence** | Hourly |

---

## 🚀 Quick Start / Local Testing

To test the application locally on your computer:

```bash
cd gmgsi_india_satellite_app
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

1. In your GitHub repository, navigate to **Settings** > **Pages** (under "Code and automation").
2. Under **Build and deployment**:
   * **Source:** Select `Deploy from a branch`.
   * **Branch:** Select `main` and folder `/ (root)`.
3. Click **Save**.
4. In ~1 minute, your site will be live at:
   `https://<your-username>.github.io/<your-repo-name>/`

### 3. Automated Hourly Updates

The included workflow [`.github/workflows/update_imagery.yml`](.github/workflows/update_imagery.yml) will:
1. Automatically run every hour at minute 25.
2. Download the newest satellite frame from NOAA AWS S3 (`s3://noaa-gmgsi-pds`).
3. Commit the new frame to your repository, keeping your GitHub Pages dashboard permanently up to date in real-time.

You can also trigger it manually anytime under the **Actions** tab by selecting **Auto Update NOAA GMGSI Satellite Imagery** > **Run workflow**.

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
│   ├── manifest.json            # Frame timestamps, bounds, and product indices
│   └── frames/                  # Compact hourly binary raster slices
│       ├── LW_*.bin
│       ├── WV_*.bin
│       └── VIS_*.bin
├── pipeline/
│   ├── extract_gmgsi.py         # NOAA GMGSI S3 ingestion & cropping script
│   └── requirements.txt         # Python dependencies (xarray, netCDF4, s3fs, numpy)
└── .github/workflows/
    └── update_imagery.yml       # Hourly GitHub Actions cron workflow
```

---

## 🔬 WebAssembly Architecture

The raster compute engine is written in Rust (`no_std`) and compiled directly to the `wasm32-unknown-unknown` target. It directly operates on linear WebAssembly memory buffers:

* **Zero Garbage Collection Overhead:** Fixed memory layout with zero allocation during animation frames.
* **Instant Dynamic Colormapping:** Converts single-channel 8-bit satellite counts into 32-bit RGBA pixels in $< 1\text{ ms}$.
* **Temperature Formula:** Inverts GMGSI digital counts ($DN$) to physical brightness temperature ($T_b$) via:
  $$T_b(^\circ\text{C}) \approx 40.0 - 0.4902 \times DN$$
  $$T_b(\text{K}) = T_b(^\circ\text{C}) + 273.15$$
