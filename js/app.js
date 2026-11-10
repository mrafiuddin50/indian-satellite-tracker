/**
 * Main Application Logic
 * Integrates Leaflet Map, WebAssembly Raster Engine, India State Shapefile, and Timeline Controller.
 */

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Initialize State
    let manifest = null;
    let indiaGeoJSON = null;
    let wasmEngine = null;
    let currentProduct = 'LW';
    let currentPalette = 0; // 0 = BD Enhanced IR
    let currentFrameIdx = 0;
    let isPlaying = false;
    let playbackInterval = null;
    let playbackSpeed = 800; // ms per frame
    let rasterOverlay = null;
    let rawFrameCache = new Map(); // frame_id -> Uint8Array
    let isConvectionMode = false;
    let rasterOpacity = 0.85;

    // 2. Initialize Map
    const map = L.map('map', {
        center: [15.0, 78.0],
        zoom: 5,
        minZoom: 4,
        maxZoom: 9,
        zoomControl: false,
        attributionControl: false
    });

    // Free, open basemaps with NO API KEY required
    const basemapLayers = {
        'esri-dark': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 }),
        'esri-sat': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18 }),
        'osm': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }),
        'esri-ocean': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 13 })
    };
    let currentBasemap = basemapLayers['esri-dark'].addTo(map);

    const basemapSelect = document.getElementById('basemap-select');
    if (basemapSelect) {
        basemapSelect.addEventListener('change', (e) => {
            map.removeLayer(currentBasemap);
            currentBasemap = basemapLayers[e.target.value].addTo(map);
            if (rasterOverlay) rasterOverlay.bringToFront();
            if (stateLayer) stateLayer.bringToFront();
        });
    }

    // Zoom control at top-left below HUD
    L.control.zoom({ position: 'topleft' }).addTo(map);

    // 3. Initialize WebAssembly
    wasmEngine = new WasmRasterEngine();
    const wasmLoaded = await wasmEngine.init('wasm/raster_engine.wasm');
    if (!wasmLoaded) {
        alert("Failed to initialize WebAssembly raster engine.");
        return;
    }

    // 4. Load Manifest and India State Shapefile
    try {
        const [manifestRes, geoRes] = await Promise.all([
            fetch('data/manifest.json'),
            fetch('data/india_states.geojson')
        ]);

        manifest = await manifestRes.json();
        indiaGeoJSON = await geoRes.json();

        console.log(`Loaded manifest with ${manifest.frames.length} frames.`);
        console.log(`Loaded India GeoJSON with ${indiaGeoJSON.features.length} state boundaries.`);
    } catch (e) {
        console.error("Error loading manifest or GeoJSON:", e);
        return;
    }

    // 5. Render India State Boundaries Overlay
    const stateLayer = L.geoJSON(indiaGeoJSON, {
        style: {
            color: '#38bdf8',
            weight: 1.2,
            opacity: 0.85,
            fillColor: 'transparent',
            fillOpacity: 0.0,
            dashArray: '2, 3'
        },
        onEachFeature: (feature, layer) => {
            if (feature.properties && feature.properties.Name) {
                layer.bindTooltip(feature.properties.Name, {
                    sticky: true,
                    className: 'custom-state-tooltip'
                });
            }
        }
    }).addTo(map);

    // 6. Setup Clocks & Time Formatter
    function formatTimestampIST(isoString) {
        const d = new Date(isoString);
        const dateStr = d.toLocaleDateString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        });
        const timeStr = d.toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        });
        const utcTime = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' UTC';
        return `${dateStr}, ${timeStr} IST (${utcTime})`;
    }

    function updateClocks() {
        const now = new Date();
        document.getElementById('clock-ist').textContent = now.toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        }) + ' IST';
        document.getElementById('clock-utc').textContent = now.toUTCString().slice(17, 25) + ' UTC';
    }
    setInterval(updateClocks, 1000);
    updateClocks();

    // 7. Raster Rendering Engine
    const offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = manifest.grid.cols;
    offscreenCanvas.height = manifest.grid.rows;
    const offCtx = offscreenCanvas.getContext('2d');

    const rasterBounds = [
        [manifest.grid.lat_min, manifest.grid.lon_min],
        [manifest.grid.lat_max, manifest.grid.lon_max]
    ];

    // Fetch and cache a binary frame
    async function getFrameData(frameEntry, prodKey) {
        const path = frameEntry.products[prodKey];
        if (!path) return null;

        const cacheKey = `${prodKey}_${frameEntry.id}`;
        if (rawFrameCache.has(cacheKey)) {
            return rawFrameCache.get(cacheKey);
        }

        try {
            const res = await fetch(`data/${path}`);
            const buf = await res.arrayBuffer();
            const u8 = new Uint8Array(buf);
            rawFrameCache.set(cacheKey, u8);
            return u8;
        } catch (err) {
            console.error("Failed to load frame:", path, err);
            return null;
        }
    }

    // Render current frame with WebAssembly
    async function renderCurrentFrame() {
        if (!manifest || manifest.frames.length === 0) return;

        const frame = manifest.frames[currentFrameIdx];
        document.getElementById('frame-timestamp').textContent = formatTimestampIST(frame.timestamp);
        document.getElementById('timeline-slider').value = currentFrameIdx;

        const rawData = await getFrameData(frame, currentProduct);
        if (!rawData) return;

        // Process with WASM
        const imgData = wasmEngine.renderToImageData(
            rawData,
            manifest.grid.cols,
            manifest.grid.rows,
            {
                paletteId: currentPalette,
                brightness: parseFloat(document.getElementById('brightness-slider').value),
                contrast: parseFloat(document.getElementById('contrast-slider').value),
                threshMin: 0,
                threshMax: 255,
                highlightConvection: isConvectionMode ? 1 : 0
            }
        );

        if (!imgData) return;

        offCtx.putImageData(imgData, 0, 0);
        const dataUrl = offscreenCanvas.toDataURL();

        if (rasterOverlay) {
            rasterOverlay.setUrl(dataUrl);
            rasterOverlay.setOpacity(rasterOpacity);
        } else {
            rasterOverlay = L.imageOverlay(dataUrl, rasterBounds, {
                opacity: rasterOpacity,
                interactive: true
            }).addTo(map);

            // Re-order layers so state boundaries stay on top
            stateLayer.bringToFront();
        }
    }

    // 8. Timeline Controls
    const slider = document.getElementById('timeline-slider');
    slider.max = manifest.frames.length - 1;
    slider.value = currentFrameIdx;

    slider.addEventListener('input', (e) => {
        currentFrameIdx = parseInt(e.target.value);
        renderCurrentFrame();
    });

    const playBtn = document.getElementById('btn-play');
    function togglePlay() {
        isPlaying = !isPlaying;
        if (isPlaying) {
            playBtn.innerHTML = '&#10074;&#10074;';
            playBtn.classList.add('active');
            playbackInterval = setInterval(() => {
                currentFrameIdx = (currentFrameIdx + 1) % manifest.frames.length;
                renderCurrentFrame();
            }, playbackSpeed);
        } else {
            playBtn.innerHTML = '&#9654;';
            playBtn.classList.remove('active');
            clearInterval(playbackInterval);
        }
    }
    playBtn.addEventListener('click', togglePlay);

    document.getElementById('btn-prev').addEventListener('click', () => {
        if (isPlaying) togglePlay();
        currentFrameIdx = (currentFrameIdx - 1 + manifest.frames.length) % manifest.frames.length;
        renderCurrentFrame();
    });

    document.getElementById('btn-next').addEventListener('click', () => {
        if (isPlaying) togglePlay();
        currentFrameIdx = (currentFrameIdx + 1) % manifest.frames.length;
        renderCurrentFrame();
    });

    // 9. Product Selector (LW, WV, VIS)
    document.querySelectorAll('.btn-prod').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.btn-prod').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentProduct = e.target.getAttribute('data-prod');
            
            // Auto-switch default palette based on channel
            const paletteSelect = document.getElementById('palette-select');
            if (currentProduct === 'WV') {
                paletteSelect.value = "4";
                currentPalette = 4;
            } else if (currentProduct === 'VIS') {
                paletteSelect.value = "5";
                currentPalette = 5;
            } else if (currentProduct === 'SW') {
                paletteSelect.value = "1"; // White-Hot for Shortwave IR
                currentPalette = 1;
            } else {
                paletteSelect.value = "0";
                currentPalette = 0;
            }
            updateLegendGradient();
            renderCurrentFrame();
        });
    });

    // 10. Palette and Filter Controls
    const paletteSelect = document.getElementById('palette-select');
    paletteSelect.addEventListener('change', (e) => {
        currentPalette = parseInt(e.target.value);
        updateLegendGradient();
        renderCurrentFrame();
    });

    document.getElementById('brightness-slider').addEventListener('input', renderCurrentFrame);
    document.getElementById('contrast-slider').addEventListener('input', renderCurrentFrame);

    const opacitySlider = document.getElementById('opacity-slider');
    opacitySlider.addEventListener('input', (e) => {
        rasterOpacity = parseFloat(e.target.value);
        if (rasterOverlay) rasterOverlay.setOpacity(rasterOpacity);
    });

    const toggleConvection = document.getElementById('toggle-convection');
    toggleConvection.addEventListener('click', () => {
        isConvectionMode = !isConvectionMode;
        toggleConvection.classList.toggle('active', isConvectionMode);
        renderCurrentFrame();
    });

    const toggleBorders = document.getElementById('toggle-borders');
    toggleBorders.addEventListener('click', () => {
        if (map.hasLayer(stateLayer)) {
            map.removeLayer(stateLayer);
            toggleBorders.classList.remove('active');
        } else {
            map.addLayer(stateLayer);
            stateLayer.bringToFront();
            toggleBorders.classList.add('active');
        }
    });

    // Legend color gradient bar updates
    function updateLegendGradient() {
        const bar = document.getElementById('legend-gradient');
        const minL = document.getElementById('leg-min');
        const maxL = document.getElementById('leg-max');

        if (currentPalette === 0) { // BD Enhanced IR
            bar.style.background = 'linear-gradient(to right, #000, #b4b4b4 53%, #b4141e 64%, #e62814 75%, #ffb400 81%, #1ed232 86%, #00e1ff 92%, #143ce6 96%, #fff)';
            minL.textContent = '+40°C (Surface)';
            maxL.textContent = '-85°C (Severe Storm Core)';
        } else if (currentPalette === 1) { // White-Hot
            bar.style.background = 'linear-gradient(to right, #000, #fff)';
            minL.textContent = '+40°C';
            maxL.textContent = '-85°C';
        } else if (currentPalette === 2) { // Black-Hot
            bar.style.background = 'linear-gradient(to right, #fff, #000)';
            minL.textContent = '+40°C';
            maxL.textContent = '-85°C';
        } else if (currentPalette === 3) { // Rainbow
            bar.style.background = 'linear-gradient(to right, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000)';
            minL.textContent = 'Warm';
            maxL.textContent = 'Cold';
        } else if (currentPalette === 4) { // Water Vapor
            bar.style.background = 'linear-gradient(to right, #50143c, #0a2878 43%, #32b4e6 88%, #ffffff)';
            minL.textContent = 'Dry Air';
            maxL.textContent = 'Deep Moisture Plume';
        } else { // Visible
            bar.style.background = 'linear-gradient(to right, #111, #fff)';
            minL.textContent = '0% Albedo';
            maxL.textContent = '100% Cloud Reflection';
        }
    }
    updateLegendGradient();

    // 11. Mouse / Tap Hover Inspection (Physical Temperature Telemetry)
    map.on('mousemove', (e) => {
        const lat = e.latlng.lat;
        const lng = e.latlng.lng;

        document.getElementById('tel-lat').textContent = lat.toFixed(2) + '°';
        document.getElementById('tel-lon').textContent = lng.toFixed(2) + '°';

        if (lat < manifest.grid.lat_min || lat > manifest.grid.lat_max ||
            lng < manifest.grid.lon_min || lng > manifest.grid.lon_max) {
            document.getElementById('tel-temp').textContent = '--';
            document.getElementById('tel-raw').textContent = '--';
            document.getElementById('tel-convection').textContent = 'Outside Indian Ocean Coverage';
            return;
        }

        const frame = manifest.frames[currentFrameIdx];
        const cacheKey = `${currentProduct}_${frame.id}`;
        const rawData = rawFrameCache.get(cacheKey);

        if (!rawData) return;

        // Calculate raster coordinates (Lat is top-down: lat_max -> row 0)
        const row = Math.floor((manifest.grid.lat_max - lat) / (manifest.grid.lat_max - manifest.grid.lat_min) * manifest.grid.rows);
        const col = Math.floor((lng - manifest.grid.lon_min) / (manifest.grid.lon_max - manifest.grid.lon_min) * manifest.grid.cols);

        if (row >= 0 && row < manifest.grid.rows && col >= 0 && col < manifest.grid.cols) {
            const idx = row * manifest.grid.cols + col;
            const count = rawData[idx];
            document.getElementById('tel-raw').textContent = count;

            if (currentProduct === 'VIS') {
                const albedo = (count / 255.0 * 100).toFixed(0);
                document.getElementById('tel-temp').textContent = `${albedo}%`;
                document.getElementById('tel-convection').textContent = albedo > 50 ? 'Thick Cloud Deck' : 'Clear / Ground';
            } else if (currentProduct === 'SW') {
                const tempC = wasmEngine.getTempCelsius(count);
                const tempK = wasmEngine.getTempKelvin(count);
                document.getElementById('tel-temp').textContent = `${tempC.toFixed(1)}°C (${tempK.toFixed(0)}K)`;
                if (count > 200) {
                    document.getElementById('tel-convection').textContent = '🌙 Low Stratus / Fog / High Reflection';
                    document.getElementById('tel-convection').style.color = '#38bdf8';
                } else if (count < 60) {
                    document.getElementById('tel-convection').textContent = '🔥 Hotspot / Wildfire / High Radiance';
                    document.getElementById('tel-convection').style.color = '#f59e0b';
                } else {
                    document.getElementById('tel-convection').textContent = '🌫 Nighttime Surface / Clear Sky';
                    document.getElementById('tel-convection').style.color = '#9ca3af';
                }
            } else {
                const tempC = wasmEngine.getTempCelsius(count);
                const tempK = wasmEngine.getTempKelvin(count);
                document.getElementById('tel-temp').textContent = `${tempC.toFixed(1)}°C (${tempK.toFixed(0)}K)`;

                if (tempC < -70) {
                    document.getElementById('tel-convection').textContent = '⚡ Intense Convective Overshoot';
                    document.getElementById('tel-convection').style.color = '#f43f5e';
                } else if (tempC < -55) {
                    document.getElementById('tel-convection').textContent = '⛈ Deep Convective Storm Top';
                    document.getElementById('tel-convection').style.color = '#fbbf24';
                } else if (tempC < -30) {
                    document.getElementById('tel-convection').textContent = '☁ High Altitude Cirrus / Mid Cloud';
                    document.getElementById('tel-convection').style.color = '#38bdf8';
                } else {
                    document.getElementById('tel-convection').textContent = '🌊 Warm Sea / Land Surface';
                    document.getElementById('tel-convection').style.color = '#9ca3af';
                }
            }
        }
    });

    // Initial render
    currentFrameIdx = manifest.frames.length - 1; // Start at latest available frame
    await renderCurrentFrame();
});
