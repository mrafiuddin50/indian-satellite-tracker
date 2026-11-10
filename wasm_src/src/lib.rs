#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {}
}

const MAX_INPUT_SIZE: usize = 1_000_000;
const MAX_OUTPUT_SIZE: usize = 4_000_000;

static mut INPUT_BUFFER: [u8; MAX_INPUT_SIZE] = [0; MAX_INPUT_SIZE];
static mut OUTPUT_BUFFER: [u8; MAX_OUTPUT_SIZE] = [0; MAX_OUTPUT_SIZE];

#[no_mangle]
pub extern "C" fn get_input_ptr() -> *mut u8 {
    unsafe { INPUT_BUFFER.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn get_output_ptr() -> *const u8 {
    unsafe { OUTPUT_BUFFER.as_ptr() }
}

#[no_mangle]
pub extern "C" fn get_temp_celsius(count: u8) -> f32 {
    // Standard GMGSI IR approximation: 0 = +40°C, 255 = -85°C
    40.0 - 0.4902 * (count as f32)
}

#[no_mangle]
pub extern "C" fn get_temp_kelvin(count: u8) -> f32 {
    get_temp_celsius(count) + 273.15
}

// Generate color lookup tables on the fly
#[inline(always)]
fn get_color(palette_id: u32, v: u8, highlight_convection: u32) -> (u8, u8, u8, u8) {
    // If convection highlight mode is active: highlight intense cloud tops (> -55°C, count > 194)
    if highlight_convection == 1 && v >= 194 {
        if v >= 230 {
            // Extreme convective core (< -72°C): Neon Magenta
            return (255, 0, 220, 255);
        } else if v >= 210 {
            // Very deep convection (< -63°C): Neon Red/Orange
            return (255, 50, 0, 255);
        } else {
            // Convective cloud (< -55°C): Vibrant Yellow
            return (255, 230, 0, 255);
        }
    }

    match palette_id {
        // 0: Enhanced IR (BD / Dvorak Tropical Cyclone Curve)
        0 => {
            if v < 136 {
                // Grayscale base (sea / warm land / shallow clouds)
                let g = (v as u32 * 180 / 136) as u8;
                (g, g, g, 255)
            } else if v < 163 {
                // -30°C to -41°C: Medium Gray to White
                let t = (v - 136) as u32 * 75 / 27;
                let g = (180 + t) as u8;
                (g, g, g, 255)
            } else if v < 177 {
                // -42°C to -48°C: Dark Red / Crimson
                (180, 20, 30, 255)
            } else if v < 193 {
                // -49°C to -54°C: Bright Crimson / Vermilion
                (230, 40, 20, 255)
            } else if v < 207 {
                // -55°C to -63°C: Orange / Yellow
                (255, 180, 0, 255)
            } else if v < 221 {
                // -64°C to -69°C: Bright Green
                (30, 210, 50, 255)
            } else if v < 235 {
                // -70°C to -75°C: Cyan
                (0, 225, 255, 255)
            } else if v < 245 {
                // -76°C to -80°C: Deep Royal Blue
                (20, 60, 230, 255)
            } else {
                // < -80°C: Severe Convective Top (Pure White)
                (255, 255, 255, 255)
            }
        }

        // 1: Standard White-Hot IR (Inverted Grayscale)
        1 => (v, v, v, 255),

        // 2: Standard Black-Hot IR
        2 => {
            let inv = 255 - v;
            (inv, inv, inv, 255)
        }

        // 3: Rainbow / Turbo Heatmap
        3 => {
            let x = v as f32 / 255.0;
            let r = if x < 0.35 {
                0.0
            } else if x < 0.65 {
                (x - 0.35) / 0.3
            } else {
                1.0
            };

            let g = if x < 0.15 {
                0.0
            } else if x < 0.45 {
                (x - 0.15) / 0.3
            } else if x < 0.75 {
                1.0
            } else {
                1.0 - (x - 0.75) / 0.25
            };

            let b = if x < 0.25 {
                x / 0.25
            } else if x < 0.55 {
                1.0 - (x - 0.25) / 0.3
            } else {
                0.0
            };

            ((r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8, 255)
        }

        // 4: Water Vapor Upper-Troposphere Palette
        4 => {
            if v < 110 {
                // Dry air subsidence (deep terracotta/purple)
                let t = v as u32 * 255 / 110;
                ((80 + t / 4) as u8, (20 + t / 6) as u8, (60 + t / 5) as u8, 255)
            } else if v < 180 {
                // Moderate moisture (deep blue to cobalt)
                let t = (v - 110) as u32 * 255 / 70;
                ((10 + t / 6) as u8, (40 + t * 140 / 255) as u8, (120 + t * 135 / 255) as u8, 255)
            } else if v < 225 {
                // High moisture plumes (cyan to pale aqua)
                let t = (v - 180) as u32 * 255 / 45;
                ((50 + t * 150 / 255) as u8, (180 + t * 65 / 255) as u8, (230 + t * 25 / 255) as u8, 255)
            } else {
                // Saturated convective storms (cloud white)
                let t = (v - 225) as u32 * 255 / 30;
                ((200 + t * 55 / 255) as u8, (245 + t * 10 / 255) as u8, 255, 255)
            }
        }

        // 5: Visible Daylight Enhanced
        _ => {
            // Apply gamma-corrected contrast stretch for cloud reflectance
            let norm = v as f32 / 255.0;
            // Gamma 0.8 to brighten shadows and enhance cloud textures
            let mut val = norm * norm * 0.2 + norm * 0.8;
            if val > 1.0 { val = 1.0; }
            let b = (val * 255.0) as u8;
            (b, b, b, 255)
        }
    }
}

#[no_mangle]
pub extern "C" fn render_frame(
    width: u32,
    height: u32,
    palette_id: u32,
    brightness: f32, // -50.0 to +50.0
    contrast: f32,   // 0.5 to 2.0
    thresh_min: u8,
    thresh_max: u8,
    highlight_convection: u32
) -> u32 {
    let total_pixels = (width * height) as usize;
    if total_pixels > MAX_INPUT_SIZE {
        return 0;
    }

    let input = unsafe { &INPUT_BUFFER[..total_pixels] };
    let output = unsafe { &mut OUTPUT_BUFFER[..(total_pixels * 4)] };

    for i in 0..total_pixels {
        let raw = input[i];

        // Apply thresholding filter
        if raw < thresh_min || raw > thresh_max {
            let out_idx = i * 4;
            output[out_idx] = 0;
            output[out_idx + 1] = 0;
            output[out_idx + 2] = 0;
            output[out_idx + 3] = 0; // Transparent
            continue;
        }

        // Apply contrast & brightness adjustment
        let mut adj = (raw as f32 - 128.0) * contrast + 128.0 + brightness;
        if adj < 0.0 { adj = 0.0; }
        if adj > 255.0 { adj = 255.0; }
        let adjusted_val = adj as u8;

        let (r, g, b, a) = get_color(palette_id, adjusted_val, highlight_convection);
        let out_idx = i * 4;
        output[out_idx] = r;
        output[out_idx + 1] = g;
        output[out_idx + 2] = b;
        output[out_idx + 3] = a;
    }

    1
}

#[no_mangle]
pub extern "C" fn compute_stats(len: u32, out_stats: *mut f32) {
    if len as usize > MAX_INPUT_SIZE || out_stats.is_null() {
        return;
    }

    let input = unsafe { &INPUT_BUFFER[..(len as usize)] };
    let mut min_val: u8 = 255;
    let mut max_val: u8 = 0;
    let mut sum: u64 = 0;
    let mut valid_count: u64 = 0;
    let mut severe_convection_count: u64 = 0;

    for &v in input {
        if v > 0 {
            if v < min_val { min_val = v; }
            if v > max_val { max_val = v; }
            sum += v as u64;
            valid_count += 1;
            if v >= 210 { // Convective storm top < -63°C
                severe_convection_count += 1;
            }
        }
    }

    let mean_val = if valid_count > 0 {
        (sum as f32) / (valid_count as f32)
    } else {
        0.0
    };

    unsafe {
        *out_stats.offset(0) = min_val as f32;
        *out_stats.offset(1) = max_val as f32;
        *out_stats.offset(2) = mean_val;
        *out_stats.offset(3) = get_temp_celsius(max_val); // Minimum temperature in area (highest count)
        *out_stats.offset(4) = get_temp_celsius(min_val); // Maximum temperature in area
        *out_stats.offset(5) = severe_convection_count as f32;
    }
}
