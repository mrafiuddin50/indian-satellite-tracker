/**
 * WebAssembly Raster Engine Wrapper
 * High-performance WebAssembly module for real-time meteorological satellite raster processing.
 */

class WasmRasterEngine {
    constructor() {
        this.wasmInstance = null;
        this.memory = null;
        this.isReady = false;
        this.inputPtr = null;
        this.outputPtr = null;
    }

    async init(wasmUrl = 'wasm/raster_engine.wasm') {
        try {
            const response = await fetch(wasmUrl);
            const bytes = await response.arrayBuffer();
            const wasmModule = await WebAssembly.instantiate(bytes, {
                env: {
                    // No external imports needed for standalone no_std WASM
                }
            });

            this.wasmInstance = wasmModule.instance;
            this.memory = this.wasmInstance.exports.memory;
            this.inputPtr = this.wasmInstance.exports.get_input_ptr();
            this.outputPtr = this.wasmInstance.exports.get_output_ptr();
            this.isReady = true;
            console.log("WebAssembly Raster Engine initialized successfully (2.4 KB native module).");
            return true;
        } catch (err) {
            console.error("Failed to load WebAssembly module:", err);
            return false;
        }
    }

    /**
     * Renders a raw uint8 raster array into an RGBA ImageData buffer via WASM.
     */
    renderToImageData(rawBuffer, width, height, options = {}) {
        if (!this.isReady) {
            console.warn("WASM not initialized yet.");
            return null;
        }

        const {
            paletteId = 0,
            brightness = 0.0,
            contrast = 1.0,
            threshMin = 0,
            threshMax = 255,
            highlightConvection = 0
        } = options;

        const totalPixels = width * height;

        // Copy raw uint8 input array directly into WASM linear memory
        const wasmInput = new Uint8Array(this.memory.buffer, this.inputPtr, totalPixels);
        wasmInput.set(rawBuffer);

        // Call the WebAssembly native function
        const res = this.wasmInstance.exports.render_frame(
            width,
            height,
            paletteId,
            brightness,
            contrast,
            threshMin,
            threshMax,
            highlightConvection ? 1 : 0
        );

        if (res !== 1) {
            console.error("WASM render_frame returned error code:", res);
            return null;
        }

        // Create ImageData from WASM output buffer
        const wasmOutput = new Uint8ClampedArray(this.memory.buffer, this.outputPtr, totalPixels * 4);
        const imgData = new ImageData(new Uint8ClampedArray(wasmOutput), width, height);

        return imgData;
    }

    getTempCelsius(count) {
        if (!this.isReady) return 40.0 - 0.4902 * count;
        return this.wasmInstance.exports.get_temp_celsius(count);
    }

    getTempKelvin(count) {
        if (!this.isReady) return this.getTempCelsius(count) + 273.15;
        return this.wasmInstance.exports.get_temp_kelvin(count);
    }
}

// Export for app.js
window.WasmRasterEngine = WasmRasterEngine;
