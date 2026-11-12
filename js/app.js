/**
 * India Satellite Tracker - main application
 * Leaflet map + WebAssembly raster engine + live manifest polling.
 */
(() => {
    'use strict';

    const PRODUCT_NAMES = { LW: 'Infrared', WV: 'Water Vapour', VIS: 'Visible', SW: 'Shortwave IR' };
    const DEFAULT_PALETTE = { LW: 0, WV: 4, VIS: 5, SW: 1 };
    const MANIFEST_REFRESH_MS = 4 * 60 * 1000;
    const PREFETCH_CONCURRENCY = 4;
    const FRESH_MIN = 105;   // NOAA publishes ~40 min after nominal time + up to 60 min until the next hour
    const DELAYED_MIN = 180;

    const $ = (id) => document.getElementById(id);

    // ---------------------------------------------------------------- state
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
    const frameCache = new Map();     // key -> Uint8Array
    const inflight = new Map();       // key -> Promise
    let prefetchToken = 0;
    let renderToken = 0;
    let wasm = null;
    let overlay = null;
    let stateLayer = null;

    // ------------------------------------------------- canvas image overlay
    // Draws straight onto a <canvas> positioned like an ImageOverlay, so each
    // frame is a putImageData() instead of a PNG encode + image reload.
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
    function frameKey(prod, frame) { return `${prod}_${frame.id}`; }

    function fmtIST(d, opts) {
        return d.toLocaleString('en-IN', Object.assign({ timeZone: 'Asia/Kolkata' }, opts));
    }
    function istTime(d) { return fmtIST(d, { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase(); }
    function istDate(d) { return fmtIST(d, { day: '2-digit', month: 'short' }); }
    function utcHM(d) { return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); }

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

    // URL hash: #p=LW&pal=0&f=2026111204&z=5&ll=15.00,78.00
    function readHash() {
        const out = {};
        location.hash.replace(/^#/, '').split('&').forEach(kv => {
            const [k, v] = kv.split('=');
            if (k) out[k] = decodeURIComponent(v || '');
        });
        return out;
    }
    let hashTimer = null;
    function writeHash(map) {
        clearTimeout(hashTimer);
        hashTimer = setTimeout(() => {
            const fr = state.manifest && state.manifest.frames[state.frameIdx];
            const c = map.getCenter();
            const parts = [
                `p=${state.product}`,
                `pal=${state.palette}`,
                `f=${state.followLatest || !fr ? 'latest' : fr.id}`,
                `z=${map.getZoom()}`,
                `ll=${c.lat.toFixed(2)},${c.lng.toFixed(2)}`
            ];
            if (state.convection) parts.push('cv=1');
            history.replaceState(null, '', '#' + parts.join('&'));
        }, 300);
    }

    async function fetchManifest() {
        const res = await fetch(`data/manifest.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
        return res.json();
    }

    // --------------------------------------------------------------- main
    document.addEventListener('DOMContentLoaded', async () => {
        const hash = readHash();

        // Map
        const startLL = (hash.ll || '').split(',').map(Number);
        const map = L.map('map', {
            center: startLL.length === 2 && startLL.every(Number.isFinite) ? startLL : [17.0, 78.0],
            zoom: Number(hash.z) || 5,
            minZoom: 3,
            maxZoom: 10,
            zoomControl: false,
            attributionControl: true,
            worldCopyJump: true
        });
        map.attributionControl.setPrefix('');
        map.attributionControl.addAttribution('Imagery: <a href="https://registry.opendata.aws/noaa-gmgsi/" target="_blank" rel="noopener">NOAA GMGSI</a>');
        L.control.zoom({ position: 'topleft' }).addTo(map);

        const esriAttr = 'Basemap &copy; Esri';
        const basemaps = {
            'esri-dark': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: esriAttr }),
            'esri-sat': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: esriAttr }),
            'osm': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }),
            'esri-ocean': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 13, attribution: esriAttr })
        };
        let basemap = basemaps['esri-dark'].addTo(map);
        $('basemap-select').addEventListener('change', (e) => {
            map.removeLayer(basemap);
            basemap = basemaps[e.target.value].addTo(map);
            basemap.bringToBack();
        });

        // Clocks
        function tickClocks() {
            const now = new Date();
            $('clock-ist').textContent = fmtIST(now, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).toUpperCase() + ' IST';
            $('clock-utc').textContent = now.toISOString().slice(11, 19) + ' UTC';
        }
        tickClocks();
        setInterval(tickClocks, 1000);

        // WASM + manifest + boundaries
        setLoader('Loading satellite data…');
        wasm = new WasmRasterEngine();
        let geo = null;
        try {
            const [ok, manifest, geoJson] = await Promise.all([
                wasm.init('wasm/raster_engine.wasm'),
                fetchManifest(),
                fetch('data/india_states.geojson').then(r => r.ok ? r.json() : null).catch(() => null)
            ]);
            if (!ok) throw new Error('WebAssembly engine failed to start');
            if (!manifest.frames || !manifest.frames.length) throw new Error('No frames are available yet');
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
        canvas.className = 'sat-canvas';
        const ctx = canvas.getContext('2d');
        overlay = new CanvasOverlay(canvas, [[grid.lat_min, grid.lon_min], [grid.lat_max, grid.lon_max]], {
            opacity: state.opacity, interactive: false
        }).addTo(map);

        if (geo) {
            stateLayer = L.geoJSON(geo, {
                style: { color: '#7dd3fc', weight: 1, opacity: 0.8, fill: false, dashArray: '2, 3' },
                onEachFeature: (f, layer) => {
                    if (f.properties && f.properties.Name) {
                        layer.bindTooltip(f.properties.Name, { sticky: true, className: 'custom-state-tooltip' });
                    }
                }
            }).addTo(map);
        } else {
            $('toggle-borders').disabled = true;
        }

        const pixelate = () => canvas.classList.toggle('pixelated', map.getZoom() >= 8);
        map.on('zoomend', pixelate);
        pixelate();

        // ------------------------------------------------ frame loading
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
            const frames = state.manifest.frames.slice().reverse(); // newest first
            let i = 0;
            const worker = async () => {
                while (i < frames.length && token === prefetchToken) {
                    await loadFrame(prod, frames[i++]);
                }
            };
            await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
        }

        // Slider background shows which frames are buffered
        function updateBuffered() {
            const frames = state.manifest.frames;
            const n = frames.length;
            if (n < 2) return;
            const stops = [];
            frames.forEach((f, i) => {
                const a = (i / n) * 100, b = ((i + 1) / n) * 100;
                const has = !f.products[state.product] ? 'rgba(245,158,11,0.35)'
                    : frameCache.has(frameKey(state.product, f)) ? 'rgba(56,189,248,0.55)' : 'rgba(255,255,255,0.16)';
                stops.push(`${has} ${a}%`, `${has} ${b}%`);
            });
            $('timeline-slider').style.background = `linear-gradient(to right, ${stops.join(',')})`;
        }

        // ----------------------------------------------------- rendering
        function render(u8) {
            const img = wasm.renderToImageData(u8, grid.cols, grid.rows, {
                paletteId: state.palette,
                highlightConvection: state.convection ? 1 : 0
            });
            if (img) ctx.putImageData(img, 0, 0);
        }

        function updateFrameLabels() {
            const frames = state.manifest.frames;
            const fr = frames[state.frameIdx];
            const d = new Date(fr.timestamp);
            $('frame-timestamp').textContent = `${istDate(d)}, ${istTime(d)} IST`;
            const sub = $('frame-sub');
            if (!fr.products[state.product]) {
                sub.textContent = `No ${PRODUCT_NAMES[state.product]} data for this hour`;
                sub.classList.add('missing');
            } else {
                sub.textContent = `${utcHM(d)} UTC · ${ago(Date.now() - d.getTime())}`;
                sub.classList.remove('missing');
            }
            $('timeline-slider').value = state.frameIdx;
            $('btn-latest').classList.toggle('at-latest', state.frameIdx === frames.length - 1);
            document.querySelectorAll('.btn-prod').forEach(b =>
                b.classList.toggle('unavailable', !fr.products[b.dataset.prod]));
        }

        async function showFrame(idx) {
            const frames = state.manifest.frames;
            state.frameIdx = Math.max(0, Math.min(frames.length - 1, idx));
            state.followLatest = state.frameIdx === frames.length - 1;
            updateFrameLabels();
            writeHash(map);
            const token = ++renderToken;
            const fr = frames[state.frameIdx];
            const u8 = await loadFrame(state.product, fr);
            if (token !== renderToken) return;   // a newer request superseded this one
            if (!u8) { overlay.setOpacity(0); return; }
            render(u8);
            overlay.setOpacity(state.opacity);
            probeRefresh();
        }

        function rerender() { showFrame(state.frameIdx); }

        // ------------------------------------------------------ timeline
        const slider = $('timeline-slider');
        function buildTimeline() {
            const frames = state.manifest.frames;
            const n = frames.length;
            slider.max = n - 1;
            const ticks = $('timeline-ticks');
            ticks.innerHTML = '';
            const step = window.innerWidth < 600 ? 6 : 3;
            const idxs = [];
            for (let i = n - 1; i >= 0; i -= step) idxs.unshift(i);
            let prevDay = null;
            idxs.forEach(i => {
                const d = new Date(frames[i].timestamp);
                const p = n > 1 ? i / (n - 1) : 1;
                const day = istDate(d);
                const s = document.createElement('span');
                if (prevDay && day !== prevDay) {
                    s.textContent = day;
                    s.classList.add('day');
                } else {
                    s.textContent = fmtIST(d, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '').toLowerCase();
                }
                prevDay = day;
                s.style.left = `calc(${p * 100}% + ${(0.5 - p) * 16}px)`;
                if (p > 0.97) s.style.transform = 'translateX(-90%)';
                if (p < 0.03) s.style.transform = 'translateX(-10%)';
                ticks.appendChild(s);
            });
            updateBuffered();
        }

        slider.addEventListener('input', (e) => { if (state.playing) togglePlay(); showFrame(parseInt(e.target.value, 10)); });

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
        $('btn-play').addEventListener('click', togglePlay);
        $('btn-prev').addEventListener('click', () => { if (state.playing) togglePlay(); showFrame(state.frameIdx - 1); });
        $('btn-next').addEventListener('click', () => { if (state.playing) togglePlay(); showFrame(state.frameIdx + 1); });
        $('btn-latest').addEventListener('click', () => { if (state.playing) togglePlay(); showFrame(state.manifest.frames.length - 1); });
        $('speed-select').addEventListener('change', (e) => { state.speed = parseInt(e.target.value, 10); });

        // ------------------------------------------------------ controls
        function setProduct(prod, keepPalette) {
            state.product = prod;
            document.querySelectorAll('.btn-prod').forEach(b => b.classList.toggle('active', b.dataset.prod === prod));
            if (!keepPalette) {
                state.palette = DEFAULT_PALETTE[prod];
                $('palette-select').value = String(state.palette);
            }
            $('tel-temp-label').textContent = prod === 'VIS' ? 'Reflectance (approx.)' : 'Brightness temp (approx.)';
            updateLegend();
            updateBuffered();
            rerender();
            prefetchProduct(prod);
        }
        document.querySelectorAll('.btn-prod').forEach(btn =>
            btn.addEventListener('click', () => setProduct(btn.dataset.prod)));

        $('palette-select').addEventListener('change', (e) => {
            state.palette = parseInt(e.target.value, 10);
            updateLegend();
            rerender();
        });

        $('opacity-slider').addEventListener('input', (e) => {
            state.opacity = parseFloat(e.target.value);
            overlay.setOpacity(state.opacity);
        });

        function setConvection(on) {
            state.convection = on;
            $('toggle-convection').classList.toggle('active', on);
            rerender();
        }
        $('toggle-convection').addEventListener('click', () => setConvection(!state.convection));

        function toggleBorders() {
            if (!stateLayer) return;
            const on = !map.hasLayer(stateLayer);
            if (on) stateLayer.addTo(map); else map.removeLayer(stateLayer);
            $('toggle-borders').classList.toggle('active', on);
        }
        $('toggle-borders').addEventListener('click', toggleBorders);

        $('btn-layers').addEventListener('click', () => {
            const row = $('controls-row');
            const open = row.classList.toggle('open');
            document.body.classList.toggle('layers-open', open);
            $('btn-layers').setAttribute('aria-expanded', open);
        });

        function updateLegend() {
            const bar = $('legend-gradient'), lo = $('leg-min'), hi = $('leg-max');
            const p = state.palette;
            const set = (bg, a, b) => { bar.style.background = bg; lo.textContent = a; hi.textContent = b; };
            if (p === 0) set('linear-gradient(to right, #000, #b4b4b4 53%, #b4141e 64%, #e62814 75%, #ffb400 81%, #1ed232 86%, #00e1ff 92%, #143ce6 96%, #fff)', '+40°C surface', '-85°C storm core');
            else if (p === 1) set('linear-gradient(to right, #000, #fff)', state.product === 'VIS' ? 'Dark' : '+40°C', state.product === 'VIS' ? 'Bright' : '-85°C');
            else if (p === 2) set('linear-gradient(to right, #fff, #000)', '+40°C', '-85°C');
            else if (p === 3) set('linear-gradient(to right, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000)', 'Warm', 'Cold');
            else if (p === 4) set('linear-gradient(to right, #50143c, #0a2878 43%, #32b4e6 88%, #ffffff)', 'Dry air', 'Deep moisture');
            else set('linear-gradient(to right, #111, #fff)', 'Low reflectance', 'Bright cloud');
        }

        // ------------------------------------------------------- probe
        let lastProbe = null;
        function probe(latlng) {
            lastProbe = latlng;
            const { lat, lng } = latlng;
            $('tel-lat').textContent = lat.toFixed(2) + '°';
            $('tel-lon').textContent = lng.toFixed(2) + '°';
            const tag = $('tel-convection');
            const clear = (msg) => { $('tel-temp').textContent = '--'; $('tel-raw').textContent = '--'; tag.textContent = msg; tag.style.color = ''; };

            if (lat < grid.lat_min || lat > grid.lat_max || lng < grid.lon_min || lng > grid.lon_max) {
                return clear('Outside the imagery extent');
            }
            const fr = state.manifest.frames[state.frameIdx];
            const u8 = frameCache.get(frameKey(state.product, fr));
            if (!u8) return clear('No data for this frame');

            const row = Math.floor((grid.lat_max - lat) / (grid.lat_max - grid.lat_min) * grid.rows);
            const col = Math.floor((lng - grid.lon_min) / (grid.lon_max - grid.lon_min) * grid.cols);
            if (row < 0 || row >= grid.rows || col < 0 || col >= grid.cols) return clear('Outside the imagery extent');
            const count = u8[row * grid.cols + col];
            $('tel-raw').textContent = count;

            const say = (msg, color) => { tag.textContent = msg; tag.style.color = color || ''; };
            if (state.product === 'VIS') {
                const pct = Math.round(count / 255 * 100);
                $('tel-temp').textContent = `${pct}%`;
                say(pct > 50 ? 'Bright, thick cloud' : pct > 25 ? 'Thin cloud / bright surface' : 'Clear, or night-time');
                return;
            }
            const c = wasm.getTempCelsius(count), k = wasm.getTempKelvin(count);
            $('tel-temp').textContent = `${c.toFixed(1)}°C (${k.toFixed(0)} K)`;
            if (state.product === 'SW') {
                if (count > 200) say('Low stratus / fog / high reflection', '#38bdf8');
                else if (count < 60) say('Hotspot / high radiance', '#f59e0b');
                else say('Surface or clear sky');
            } else if (c < -70) say('⚡ Intense convective overshoot', '#f43f5e');
            else if (c < -55) say('Deep convective storm top', '#fbbf24');
            else if (c < -30) say('High cirrus / mid-level cloud', '#38bdf8');
            else say('Warm sea / land surface or low cloud');
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
            $('status-text').textContent = `${label} · latest ${istTime(latest)} IST · ${ago(Date.now() - latest.getTime())}`;
            chip.title = age > DELAYED_MIN
                ? 'The update pipeline appears to be behind NOAA. Imagery shown may be several hours old.'
                : 'NOAA publishes each hourly mosaic about 40 minutes after its nominal time.';
            const up = m.last_updated ? new Date(m.last_updated) : null;
            $('dlg-meta').textContent = `${m.frames.length} hourly frames · newest ${istDate(latest)} ${istTime(latest)} IST (${utcHM(latest)} UTC)` +
                (up ? ` · site checked NOAA ${ago(Date.now() - up.getTime())}` : '');
            if (!state.playing) updateFrameLabels();
        }

        async function refreshManifest() {
            let fresh;
            try { fresh = await fetchManifest(); } catch (e) { console.warn('Manifest refresh failed', e); return; }
            const old = state.manifest;
            const oldLatest = old.frames[old.frames.length - 1].id;
            const newLatest = fresh.frames.length ? fresh.frames[fresh.frames.length - 1].id : oldLatest;
            const sameProducts = JSON.stringify(old.frames.map(f => f.products)) === JSON.stringify(fresh.frames.map(f => f.products));
            if (newLatest === oldLatest && sameProducts) { state.manifest.last_updated = fresh.last_updated; updateStatus(); return; }

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
            if (newLatest !== oldLatest) {
                toast(`New frame: ${istTime(new Date(fresh.frames[fresh.frames.length - 1].timestamp))} IST`);
            }
        }
        setInterval(refreshManifest, MANIFEST_REFRESH_MS);
        setInterval(updateStatus, 30000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshManifest(); });

        // ------------------------------------------------- info & keys
        const dlg = $('info-dialog');
        const openInfo = () => { if (dlg.showModal) dlg.showModal(); };
        $('btn-info').addEventListener('click', openInfo);
        $('status-chip').addEventListener('click', openInfo);

        document.addEventListener('keydown', (e) => {
            if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === ' ' && e.target.matches('button')) return;
            if (dlg.open) return;
            const prods = { '1': 'LW', '2': 'WV', '3': 'VIS', '4': 'SW' };
            if (e.key === ' ') { e.preventDefault(); togglePlay(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); if (state.playing) togglePlay(); showFrame(state.frameIdx - 1); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); if (state.playing) togglePlay(); showFrame(state.frameIdx + 1); }
            else if (e.key === 'End') { if (state.playing) togglePlay(); showFrame(state.manifest.frames.length - 1); }
            else if (prods[e.key]) setProduct(prods[e.key]);
            else if (e.key === 'c' || e.key === 'C') setConvection(!state.convection);
            else if (e.key === 'b' || e.key === 'B') toggleBorders();
            else if (e.key === 'i' || e.key === 'I') openInfo();
        });

        map.on('moveend', () => writeHash(map));
        window.addEventListener('resize', () => buildTimeline());

        // --------------------------------------------------- first paint
        const startProduct = PRODUCT_NAMES[hash.p] ? hash.p : 'LW';
        const pal = parseInt(hash.pal, 10);
        const hasPal = Number.isInteger(pal) && pal >= 0 && pal <= 5;
        state.palette = hasPal ? pal : DEFAULT_PALETTE[startProduct];
        $('palette-select').value = String(state.palette);
        state.convection = hash.cv === '1';
        $('toggle-convection').classList.toggle('active', state.convection);

        buildTimeline();
        let startIdx = state.manifest.frames.length - 1;
        if (hash.f && hash.f !== 'latest') {
            const i = state.manifest.frames.findIndex(f => f.id === hash.f);
            if (i >= 0) startIdx = i;
        }
        state.frameIdx = startIdx;
        state.product = startProduct;
        document.querySelectorAll('.btn-prod').forEach(b => b.classList.toggle('active', b.dataset.prod === startProduct));
        $('tel-temp-label').textContent = startProduct === 'VIS' ? 'Reflectance (approx.)' : 'Brightness temp (approx.)';
        updateLegend();
        updateStatus();
        await showFrame(startIdx);
        setLoader(null);
        prefetchProduct(state.product);
    });
})();
