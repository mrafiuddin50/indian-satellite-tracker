/**
 * India Satellite Tracker - main application
 * Leaflet map + WebAssembly raster engine + live manifest polling.
 */
(() => {
    'use strict';

    const PRODUCT_NAMES = { LW: 'Infrared', WV: 'Water vapour', VIS: 'Visible', SW: 'Shortwave IR' };
    const PRODUCT_LEGEND = {
        LW: 'Cloud-top temperature',
        WV: 'Upper-level moisture (brightness temp.)',
        VIS: 'Reflectance (daylight only)',
        SW: 'Shortwave brightness temp.'
    };
    const DEFAULT_PALETTE = { LW: 0, WV: 4, VIS: 5, SW: 1 };
    const MANIFEST_REFRESH_MS = 4 * 60 * 1000;
    const PREFETCH_CONCURRENCY = 4;
    const FRESH_MIN = 105;   // NOAA publishes ~40 min after nominal time + up to 60 min until the next hour
    const DELAYED_MIN = 180;

    const $ = (id) => document.getElementById(id);

    const state = {
        manifest: null,
        product: 'LW',
        palette: 0,
        frameIdx: 0,
        playing: false,
        speed: 600,
        convection: false,
        opacity: 0.85,
        followLatest: true,
    };
    const frameCache = new Map();
    const inflight = new Map();
    let prefetchToken = 0;
    let renderToken = 0;
    let wasm = null;
    let overlay = null;

    // Canvas overlay: each frame is a putImageData() instead of PNG encode + reload.
    const CanvasOverlay = L.ImageOverlay.extend({
        _initImage: function () {
            const el = this._image = this._url;
            L.DomUtil.addClass(el, 'leaflet-image-layer');
            if (this._zoomAnimated) L.DomUtil.addClass(el, 'leaflet-zoom-animated');
            if (this.options.className) L.DomUtil.addClass(el, this.options.className);
            el.onselectstart = L.Util.falseFn;
            el.onmousemove = L.Util.falseFn;
        }
    });

    // ------------------------------------------------------------- helpers
    const frameKey = (prod, frame) => `${prod}_${frame.id}`;
    const fmtIST = (d, opts) => d.toLocaleString('en-IN', Object.assign({ timeZone: 'Asia/Kolkata' }, opts));
    const istTime = (d) => fmtIST(d, { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
    const istDate = (d) => fmtIST(d, { day: 'numeric', month: 'short' });
    const utcHM = (d) => String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    const countToC = (count) => 40.0 - 0.4902 * count;   // matches the WASM engine

    function ago(ms) {
        const m = Math.max(0, Math.round(ms / 60000));
        if (m < 60) return `${m} min ago`;
        const h = Math.floor(m / 60), r = m % 60;
        return r && h < 10 ? `${h} h ${r} min ago` : `${h} h ago`;
    }

    function setLoader(text, isError) {
        const el = $('loader');
        if (!text) { el.classList.add('hidden'); return; }
        el.classList.remove('hidden');
        el.classList.toggle('error', !!isError);
        $('loader-text').textContent = text;
    }

    let toastTimer = null;
    function toast(msg) {
        const el = $('toast');
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
    }

    function readHash() {
        const out = {};
        location.hash.replace(/^#/, '').split('&').forEach(kv => {
            const [k, v] = kv.split('=');
            if (k) out[k] = decodeURIComponent(v || '');
        });
        return out;
    }

    async function fetchManifest() {
        const res = await fetch(`data/manifest.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
        return res.json();
    }

    // ---------------------------------------------------------------- main
    document.addEventListener('DOMContentLoaded', async () => {
        const hash = readHash();

        // ---------------------------------------------------------- map
        const startLL = (hash.ll || '').split(',').map(Number);
        const map = L.map('map', {
            center: startLL.length === 2 && startLL.every(Number.isFinite) ? startLL : [17.0, 78.0],
            zoom: Number(hash.z) || (window.innerWidth < 720 ? 4 : 5),
            minZoom: 3,
            maxZoom: 10,
            zoomControl: false,
            attributionControl: true,
            worldCopyJump: true,
            zoomSnap: 0.5
        });
        map.attributionControl.setPrefix('');
        map.attributionControl.addAttribution('Imagery <a href="https://registry.opendata.aws/noaa-gmgsi/" target="_blank" rel="noopener">NOAA GMGSI</a>');
        L.control.zoom({ position: 'topleft' }).addTo(map);

        map.createPane('labels');
        map.getPane('labels').style.zIndex = 450;
        map.getPane('labels').style.pointerEvents = 'none';
        map.createPane('borders');
        map.getPane('borders').style.zIndex = 420;

        const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
        const esriAttr = 'Basemap &copy; Esri';
        const basemaps = {
            'esri-dark': L.tileLayer(esri + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: esriAttr }),
            'esri-sat': L.tileLayer(esri + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: esriAttr }),
            'esri-ocean': L.tileLayer(esri + 'Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 13, attribution: esriAttr }),
            'osm': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' })
        };
        const labelLayers = {
            dark: L.tileLayer(esri + 'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { pane: 'labels', maxZoom: 16, opacity: 0.9 }),
            light: L.tileLayer(esri + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { pane: 'labels', maxZoom: 16, opacity: 0.85 })
        };
        let basemapKey = 'esri-dark';
        let basemap = basemaps[basemapKey].addTo(map);
        let labels = null;

        function syncLabels() {
            if (labels) map.removeLayer(labels);
            labels = null;
            if (!$('toggle-labels').checked || basemapKey === 'osm') return;
            labels = (basemapKey === 'esri-dark' ? labelLayers.dark : labelLayers.light).addTo(map);
        }
        function setBasemap(key) {
            if (!basemaps[key] || key === basemapKey) return;
            map.removeLayer(basemap);
            basemapKey = key;
            basemap = basemaps[key].addTo(map);
            basemap.bringToBack();
            document.querySelectorAll('.bm').forEach(b => b.classList.toggle('active', b.dataset.basemap === key));
            syncLabels();
            writeHash();
        }
        document.querySelectorAll('.bm').forEach(b => b.addEventListener('click', () => setBasemap(b.dataset.basemap)));
        $('toggle-labels').addEventListener('change', syncLabels);

        // ------------------------------------------------- data loading
        setLoader('Loading satellite data…');
        wasm = new WasmRasterEngine();
        let geo = null;
        try {
            const [ok, manifest, geoJson] = await Promise.all([
                wasm.init('wasm/raster_engine.wasm'),
                fetchManifest(),
                fetch('data/india_states.geojson').then(r => r.ok ? r.json() : null).catch(() => null)
            ]);
            if (!ok) throw new Error('the WebAssembly engine failed to start');
            if (!manifest.frames || !manifest.frames.length) throw new Error('no frames are available yet');
            state.manifest = manifest;
            geo = geoJson;
        } catch (err) {
            console.error(err);
            setLoader(`Could not load the imagery: ${err.message}. Please reload in a minute.`, true);
            return;
        }

        const grid = state.manifest.grid;
        const canvas = document.createElement('canvas');
        canvas.width = grid.cols;
        canvas.height = grid.rows;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        overlay = new CanvasOverlay(canvas, [[grid.lat_min, grid.lon_min], [grid.lat_max, grid.lon_max]], {
            opacity: state.opacity, interactive: false, className: 'sat-canvas'
        }).addTo(map);

        let stateLayer = null;
        if (geo) {
            stateLayer = L.geoJSON(geo, {
                pane: 'borders',
                style: { color: '#e2e8f0', weight: 0.8, opacity: 0.55, fill: false },
                onEachFeature: (f, layer) => {
                    if (f.properties && f.properties.Name) {
                        layer.bindTooltip(f.properties.Name, { sticky: true, className: 'state-tip', direction: 'top', offset: [0, -8] });
                    }
                }
            }).addTo(map);
        } else {
            $('toggle-borders').checked = false;
            $('toggle-borders').disabled = true;
        }
        syncLabels();

        const pixelate = () => canvas.classList.toggle('pixelated', map.getZoom() >= 8);
        map.on('zoomend', pixelate);
        pixelate();

        let hashTimer = null;
        function writeHash() {
            clearTimeout(hashTimer);
            hashTimer = setTimeout(() => {
                const fr = state.manifest.frames[state.frameIdx];
                const c = map.getCenter();
                const parts = [
                    `p=${state.product}`, `pal=${state.palette}`,
                    `f=${state.followLatest || !fr ? 'latest' : fr.id}`,
                    `z=${map.getZoom()}`, `ll=${c.lat.toFixed(2)},${c.lng.toFixed(2)}`
                ];
                if (basemapKey !== 'esri-dark') parts.push(`bm=${basemapKey}`);
                if (state.convection) parts.push('cv=1');
                history.replaceState(null, '', '#' + parts.join('&'));
            }, 300);
        }

        // ------------------------------------------------- frame loading
        function loadFrame(prod, frame) {
            const path = frame.products[prod];
            if (!path) return Promise.resolve(null);
            const key = frameKey(prod, frame);
            if (frameCache.has(key)) return Promise.resolve(frameCache.get(key));
            if (inflight.has(key)) return inflight.get(key);
            const p = fetch(`data/${path}`)
                .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
                .then(buf => {
                    const u8 = new Uint8Array(buf);
                    if (u8.length !== grid.rows * grid.cols) throw new Error('unexpected frame size');
                    frameCache.set(key, u8);
                    updateBuffered();
                    return u8;
                })
                .catch(err => { console.warn('Frame load failed', path, err); return null; })
                .finally(() => inflight.delete(key));
            inflight.set(key, p);
            return p;
        }

        async function prefetchProduct(prod) {
            const token = ++prefetchToken;
            const frames = state.manifest.frames.slice().reverse();
            let i = 0;
            const worker = async () => {
                while (i < frames.length && token === prefetchToken) await loadFrame(prod, frames[i++]);
            };
            await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
        }

        // Timeline track: one segment per frame (buffered / missing / pending)
        function updateBuffered() {
            const frames = state.manifest.frames, n = frames.length;
            const stops = [];
            frames.forEach((f, i) => {
                const a = (i / n) * 100, b = ((i + 1) / n) * 100;
                const c = !f.products[state.product] ? 'rgba(251,191,36,0.45)'
                    : frameCache.has(frameKey(state.product, f)) ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.06)';
                stops.push(`${c} ${a}%`, `${c} ${b}%`);
            });
            $('tl-segs').style.background = `linear-gradient(to right, ${stops.join(',')})`;
        }

        // ----------------------------------------------------- rendering
        function render(u8) {
            const img = wasm.renderToImageData(u8, grid.cols, grid.rows, {
                paletteId: state.palette,
                highlightConvection: state.convection ? 1 : 0
            });
            if (img) ctx.putImageData(img, 0, 0);
        }

        function sliderPos(idx) {
            const n = state.manifest.frames.length;
            return n > 1 ? idx / (n - 1) : 1;
        }

        function updateFrameLabels() {
            const frames = state.manifest.frames;
            const fr = frames[state.frameIdx];
            const d = new Date(fr.timestamp);
            const [t, ampm] = istTime(d).split(' ');
            $('frame-time').innerHTML = `${t}<small>${ampm || ''} IST</small>`;
            const sub = $('frame-sub');
            if (!fr.products[state.product]) {
                sub.textContent = `${istDate(d)} · no ${PRODUCT_NAMES[state.product].toLowerCase()} data`;
                sub.classList.add('missing');
            } else {
                sub.textContent = `${istDate(d)} · ${utcHM(d)} UTC · ${ago(Date.now() - d.getTime())}`;
                sub.classList.remove('missing');
            }
            $('timeline-slider').value = state.frameIdx;
            $('tl-progress').style.width = `${sliderPos(state.frameIdx) * 100}%`;
            $('btn-latest').classList.toggle('at-latest', state.frameIdx === frames.length - 1);
            document.querySelectorAll('.chan').forEach(b => b.classList.toggle('unavailable', !fr.products[b.dataset.prod]));
        }

        async function showFrame(idx) {
            const frames = state.manifest.frames;
            state.frameIdx = Math.max(0, Math.min(frames.length - 1, idx));
            state.followLatest = state.frameIdx === frames.length - 1;
            updateFrameLabels();
            writeHash();
            const token = ++renderToken;
            const fr = frames[state.frameIdx];
            const key = frameKey(state.product, fr);
            const slow = !frameCache.has(key) && fr.products[state.product];
            if (slow) $('frame-time').parentElement.classList.add('loading');
            const u8 = await loadFrame(state.product, fr);
            if (token !== renderToken) return;
            $('frame-time').parentElement.classList.remove('loading');
            if (!u8) { overlay.setOpacity(0); probeRefresh(); return; }
            render(u8);
            overlay.setOpacity(state.opacity);
            probeRefresh();
        }
        const rerender = () => showFrame(state.frameIdx);

        // --------------------------------------------------------- legend
        const legendCanvas = $('legend-canvas');
        const legendCtx = legendCanvas.getContext('2d');
        function updateLegend() {
            const ramp = new Uint8Array(256 * 1);
            for (let i = 0; i < 256; i++) ramp[i] = i;
            const img = wasm.renderToImageData(ramp, 256, 1, { paletteId: state.palette, highlightConvection: state.convection ? 1 : 0 });
            if (img) legendCtx.putImageData(img, 0, 0);

            $('legend-title').textContent = PRODUCT_LEGEND[state.product];
            const ticks = $('legend-ticks');
            ticks.innerHTML = '';
            const add = (pos, text) => {
                const s = document.createElement('span');
                s.textContent = text;
                s.style.left = `${pos * 100}%`;
                if (pos < 0.04) s.className = 'edge-l';
                if (pos > 0.96) s.className = 'edge-r';
                ticks.appendChild(s);
            };
            if (state.product === 'VIS') {
                [0, 25, 50, 75, 100].forEach(p => add(p / 100, `${p}%`));
            } else {
                const temps = window.innerWidth < 720 ? [40, 0, -40, -80] : [40, 20, 0, -20, -40, -60, -80];
                temps.forEach(tc => {
                    const pos = ((40 - tc) / 0.4902) / 255;
                    if (pos >= 0 && pos <= 1) add(pos, `${tc > 0 ? '+' : tc < 0 ? '\u2212' : ''}${Math.abs(tc)}°`);
                });
            }
        }

        // ------------------------------------------------------- timeline
        const slider = $('timeline-slider');
        function buildTimeline() {
            const frames = state.manifest.frames, n = frames.length;
            slider.max = n - 1;
            const ticks = $('timeline-ticks');
            ticks.innerHTML = '';
            const w = $('timeline').clientWidth || 600;
            const step = w < 360 ? 8 : w < 560 ? 6 : 3;
            const idxs = [];
            for (let i = n - 1; i >= 0; i -= step) idxs.unshift(i);
            let prevDay = null;
            idxs.forEach(i => {
                const d = new Date(frames[i].timestamp);
                const p = sliderPos(i);
                const day = istDate(d);
                const s = document.createElement('span');
                s.className = 'tick';
                if (prevDay && day !== prevDay) { s.textContent = day; s.classList.add('day'); }
                else s.textContent = fmtIST(d, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '').toLowerCase();
                prevDay = day;
                s.style.left = `${p * 100}%`;
                if (p > 0.97) s.style.transform = 'translateX(-85%)';
                if (p < 0.03) s.style.transform = 'translateX(-15%)';
                ticks.appendChild(s);
            });
            updateBuffered();
        }

        slider.addEventListener('input', (e) => { if (state.playing) togglePlay(); showFrame(parseInt(e.target.value, 10)); });

        const hover = $('tl-hover');
        $('timeline').addEventListener('pointermove', (e) => {
            const r = $('timeline').getBoundingClientRect();
            const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            const frames = state.manifest.frames;
            const i = Math.round(p * (frames.length - 1));
            const d = new Date(frames[i].timestamp);
            hover.textContent = `${istDate(d)}, ${istTime(d)}`;
            hover.style.left = `${sliderPos(i) * 100}%`;
            hover.hidden = false;
        });
        $('timeline').addEventListener('pointerleave', () => { hover.hidden = true; });

        let playTimer = null;
        async function playStep() {
            if (!state.playing) return;
            const t0 = performance.now();
            const frames = state.manifest.frames;
            await showFrame((state.frameIdx + 1) % frames.length);
            if (!state.playing) return;
            const dwell = state.frameIdx === frames.length - 1 ? state.speed * 2.5 : state.speed;
            playTimer = setTimeout(playStep, Math.max(0, dwell - (performance.now() - t0)));
        }
        function togglePlay() {
            state.playing = !state.playing;
            $('icon-play').hidden = state.playing;
            $('icon-pause').hidden = !state.playing;
            $('btn-play').setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
            clearTimeout(playTimer);
            if (state.playing) playStep();
        }
        const stopAnd = (fn) => () => { if (state.playing) togglePlay(); fn(); };
        $('btn-play').addEventListener('click', togglePlay);
        $('btn-prev').addEventListener('click', stopAnd(() => showFrame(state.frameIdx - 1)));
        $('btn-next').addEventListener('click', stopAnd(() => showFrame(state.frameIdx + 1)));
        $('btn-latest').addEventListener('click', stopAnd(() => showFrame(state.manifest.frames.length - 1)));
        $('speed-select').addEventListener('change', (e) => { state.speed = parseInt(e.target.value, 10); });

        // ------------------------------------------------------- controls
        function setProduct(prod, keepPalette) {
            state.product = prod;
            document.querySelectorAll('.chan').forEach(b => b.classList.toggle('active', b.dataset.prod === prod));
            if (!keepPalette) {
                state.palette = DEFAULT_PALETTE[prod];
                $('palette-select').value = String(state.palette);
            }
            updateLegend();
            updateBuffered();
            rerender();
            prefetchProduct(prod);
        }
        document.querySelectorAll('.chan').forEach(btn => btn.addEventListener('click', () => setProduct(btn.dataset.prod)));

        $('palette-select').addEventListener('change', (e) => {
            state.palette = parseInt(e.target.value, 10);
            updateLegend();
            rerender();
        });

        $('opacity-slider').addEventListener('input', (e) => {
            state.opacity = parseFloat(e.target.value);
            $('opacity-val').textContent = `${Math.round(state.opacity * 100)}%`;
            overlay.setOpacity(state.opacity);
        });

        function setConvection(on) {
            state.convection = on;
            $('toggle-convection').checked = on;
            updateLegend();
            rerender();
            writeHash();
        }
        $('toggle-convection').addEventListener('change', (e) => setConvection(e.target.checked));

        function setBorders(on) {
            if (!stateLayer) return;
            $('toggle-borders').checked = on;
            if (on) stateLayer.addTo(map); else map.removeLayer(stateLayer);
        }
        $('toggle-borders').addEventListener('change', (e) => setBorders(e.target.checked));

        const layersBtn = $('btn-layers'), layersPanel = $('layers-panel');
        function setLayersOpen(open) {
            layersPanel.hidden = !open;
            layersBtn.setAttribute('aria-expanded', open);
            document.body.classList.toggle('layers-open', open);
        }
        layersBtn.addEventListener('click', () => setLayersOpen(layersPanel.hidden));
        map.on('click', () => { if (window.innerWidth < 720) setLayersOpen(false); });

        // ---------------------------------------------------------- probe
        let lastProbe = null;
        function probe(latlng) {
            lastProbe = latlng;
            const { lat, lng } = latlng;
            $('tel-coords').textContent = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`;
            const sw = $('tel-swatch');
            const set = (value, unit, cls, raw, color) => {
                $('tel-temp').textContent = value;
                $('tel-unit').textContent = unit;
                $('tel-class').textContent = cls;
                $('tel-raw').textContent = raw;
                sw.style.background = color || 'transparent';
            };
            if (lat < grid.lat_min || lat > grid.lat_max || lng < grid.lon_min || lng > grid.lon_max) {
                return set('--', '', 'Outside imagery extent', '');
            }
            const fr = state.manifest.frames[state.frameIdx];
            const u8 = frameCache.get(frameKey(state.product, fr));
            if (!u8) return set('--', '', 'No data for this frame', '');

            const row = Math.floor((grid.lat_max - lat) / (grid.lat_max - grid.lat_min) * grid.rows);
            const col = Math.floor((lng - grid.lon_min) / (grid.lon_max - grid.lon_min) * grid.cols);
            if (row < 0 || row >= grid.rows || col < 0 || col >= grid.cols) return set('--', '', 'Outside imagery extent', '');
            const count = u8[row * grid.cols + col];
            const px = ctx.getImageData(col, row, 1, 1).data;
            const color = `rgb(${px[0]},${px[1]},${px[2]})`;
            const raw = `DN ${count}`;

            if (state.product === 'VIS') {
                const pct = Math.round(count / 255 * 100);
                return set(`${pct}`, '% refl.', pct > 50 ? 'Bright, thick cloud' : pct > 25 ? 'Thin cloud / bright surface' : 'Clear, or night-time', raw, color);
            }
            const c = wasm.getTempCelsius(count), k = wasm.getTempKelvin(count);
            let cls;
            if (state.product === 'SW') {
                cls = count > 200 ? 'Low stratus / fog' : count < 60 ? 'Hotspot / high radiance' : 'Surface or clear sky';
            } else if (c < -70) cls = 'Intense convective overshoot';
            else if (c < -55) cls = 'Deep convective storm top';
            else if (c < -30) cls = 'High cirrus / mid-level cloud';
            else if (c < 0) cls = 'Low to mid-level cloud';
            else cls = 'Sea / land surface or low cloud';
            set(`${c > 0 ? '+' : c < 0 ? '\u2212' : ''}${Math.abs(c).toFixed(1)}`, `°C · ${k.toFixed(0)} K`, cls, raw, color);
        }
        function probeRefresh() { if (lastProbe) probe(lastProbe); }
        map.on('mousemove', (e) => probe(e.latlng));
        map.on('click', (e) => probe(e.latlng));

        // ------------------------------------------- freshness & refresh
        function updateStatus() {
            const m = state.manifest;
            const latest = new Date(m.frames[m.frames.length - 1].timestamp);
            const age = (Date.now() - latest.getTime()) / 60000;
            const chip = $('status-chip');
            chip.classList.remove('ok', 'warn', 'bad');
            let label;
            if (age <= FRESH_MIN) { chip.classList.add('ok'); label = 'LIVE'; }
            else if (age <= DELAYED_MIN) { chip.classList.add('warn'); label = 'DELAYED'; }
            else { chip.classList.add('bad'); label = 'STALE'; }
            $('status-text').innerHTML = `<b>${label}</b> · latest ${istTime(latest)} IST · ${ago(Date.now() - latest.getTime())}`;
            chip.title = age > DELAYED_MIN
                ? 'The update pipeline appears to be behind NOAA. Imagery shown may be several hours old.'
                : 'NOAA publishes each hourly mosaic about 40 minutes after its nominal time.';
            const up = m.last_updated ? new Date(m.last_updated) : null;
            $('dlg-meta').textContent = `${m.frames.length} hourly frames · newest ${istDate(latest)} ${istTime(latest)} IST (${utcHM(latest)} UTC)` +
                (up ? ` · site last checked NOAA ${ago(Date.now() - up.getTime())}` : '');
            if (!state.playing) updateFrameLabels();
        }

        async function refreshManifest() {
            let fresh;
            try { fresh = await fetchManifest(); } catch (e) { console.warn('Manifest refresh failed', e); return; }
            if (!fresh.frames || !fresh.frames.length) return;
            const old = state.manifest;
            const oldLatest = old.frames[old.frames.length - 1].id;
            const newLatest = fresh.frames[fresh.frames.length - 1].id;
            const same = JSON.stringify(old.frames.map(f => f.products)) === JSON.stringify(fresh.frames.map(f => f.products));
            if (newLatest === oldLatest && same) { state.manifest.last_updated = fresh.last_updated; updateStatus(); return; }

            const currentId = old.frames[state.frameIdx].id;
            state.manifest = fresh;
            const valid = new Set(fresh.frames.flatMap(f => Object.keys(f.products).map(p => `${p}_${f.id}`)));
            [...frameCache.keys()].forEach(k => { if (!valid.has(k)) frameCache.delete(k); });
            buildTimeline();
            let idx = fresh.frames.findIndex(f => f.id === currentId);
            if (state.followLatest || idx < 0) idx = fresh.frames.length - 1;
            if (!state.playing) await showFrame(idx); else state.frameIdx = Math.min(idx, fresh.frames.length - 1);
            updateStatus();
            prefetchProduct(state.product);
            if (newLatest !== oldLatest) toast(`New frame · ${istTime(new Date(fresh.frames[fresh.frames.length - 1].timestamp))} IST`);
        }
        setInterval(refreshManifest, MANIFEST_REFRESH_MS);
        setInterval(updateStatus, 30000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshManifest(); });

        // -------------------------------------------------- info & keys
        const dlg = $('info-dialog');
        const openInfo = () => { if (dlg.showModal && !dlg.open) dlg.showModal(); };
        $('btn-info').addEventListener('click', openInfo);
        $('status-chip').addEventListener('click', openInfo);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !layersPanel.hidden) { setLayersOpen(false); return; }
            if (e.target.matches('input:not([type="checkbox"]), select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === ' ' && e.target.matches('button, input')) return;
            if (dlg.open) return;
            const prods = { '1': 'LW', '2': 'WV', '3': 'VIS', '4': 'SW' };
            const k = e.key.toLowerCase();
            if (e.key === ' ') { e.preventDefault(); togglePlay(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); stopAnd(() => showFrame(state.frameIdx - 1))(); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); stopAnd(() => showFrame(state.frameIdx + 1))(); }
            else if (e.key === 'End') stopAnd(() => showFrame(state.manifest.frames.length - 1))();
            else if (prods[e.key]) setProduct(prods[e.key]);
            else if (k === 'c') setConvection(!state.convection);
            else if (k === 'b') setBorders(!$('toggle-borders').checked);
            else if (k === 'l') setLayersOpen(layersPanel.hidden);
            else if (k === 'i') openInfo();
        });

        map.on('moveend', writeHash);
        let resizeTimer = null;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => { buildTimeline(); updateLegend(); }, 150);
        });

        // --------------------------------------------------- first paint
        const startProduct = PRODUCT_NAMES[hash.p] ? hash.p : 'LW';
        const pal = parseInt(hash.pal, 10);
        state.palette = Number.isInteger(pal) && pal >= 0 && pal <= 5 ? pal : DEFAULT_PALETTE[startProduct];
        $('palette-select').value = String(state.palette);
        state.convection = hash.cv === '1';
        $('toggle-convection').checked = state.convection;
        if (hash.bm && basemaps[hash.bm]) setBasemap(hash.bm);

        state.product = startProduct;
        document.querySelectorAll('.chan').forEach(b => b.classList.toggle('active', b.dataset.prod === startProduct));
        buildTimeline();
        let startIdx = state.manifest.frames.length - 1;
        if (hash.f && hash.f !== 'latest') {
            const i = state.manifest.frames.findIndex(f => f.id === hash.f);
            if (i >= 0) startIdx = i;
        }
        updateLegend();
        updateStatus();
        await showFrame(startIdx);
        setLoader(null);
        prefetchProduct(state.product);
    });
})();
