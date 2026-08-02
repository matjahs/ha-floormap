/** sRGB ↔ linear, Kelvin → RGB, brightness curves, tone mapping */

export type RGB = [number, number, number];

export function srgbToLinearChannel(c: number): number {
  const s = c <= 1 ? c : c / 255;
  if (s <= 0.04045) {
    return s / 12.92;
  }
  return Math.pow((s + 0.055) / 1.055, 2.4);
}

export function linearToSrgbChannel(c: number): number {
  if (c <= 0.0031308) {
    return 12.92 * c;
  }
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function srgbToLinear(rgb: RGB): RGB {
  return [srgbToLinearChannel(rgb[0]), srgbToLinearChannel(rgb[1]), srgbToLinearChannel(rgb[2])];
}

export function linearToSrgb(rgb: RGB): RGB {
  return [linearToSrgbChannel(rgb[0]), linearToSrgbChannel(rgb[1]), linearToSrgbChannel(rgb[2])];
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = Number.parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(n)) {
    return [1, 1, 1];
  }
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function argbIntToHex(color: number): string {
  const rgb = color & 0xffffff;
  return `#${rgb.toString(16).padStart(6, "0")}`;
}

/**
 * Approximate black-body RGB (Tanner Helland / similar).
 * Returns sRGB 0–255, then normalised so relative luminance ≈ 1.
 */
export function kelvinToRgb(kelvin: number): RGB {
  const temp = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r: number;
  let g: number;
  let b: number;

  if (temp <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(temp) - 161.1195681661;
    b = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    b = 255;
  }

  const srgb: RGB = [
    clamp01(r / 255) * 255,
    clamp01(g / 255) * 255,
    clamp01(b / 255) * 255,
  ];
  return normalizeLuminance(srgbToLinear([srgb[0] / 255, srgb[1] / 255, srgb[2] / 255]));
}

export function relativeLuminance(linear: RGB): number {
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

export function normalizeLuminance(linear: RGB): RGB {
  const y = relativeLuminance(linear);
  if (y < 1e-6) {
    return [1, 1, 1];
  }
  return [linear[0] / y, linear[1] / y, linear[2] / y];
}

/**
 * HA brightness is perceptual (0–255). Convert to linear energy with gamma.
 */
export function brightnessToIntensity(
  brightness: number | undefined,
  state: string,
  gamma = 2.2,
  power = 1,
  gain = 1,
  curve: "gamma" | "linear" = "gamma",
): number {
  if (state !== "on") {
    return 0;
  }
  const b = Math.min(255, Math.max(0, brightness ?? 255)) / 255;
  const e = curve === "linear" ? b : Math.pow(b, gamma);
  return e * power * gain;
}

export function reinhardToneMap(rgb: RGB): RGB {
  return [rgb[0] / (1 + rgb[0]), rgb[1] / (1 + rgb[1]), rgb[2] / (1 + rgb[2])];
}

/** Simplified ACES fitted curve (Narkowicz). */
export function acesToneMap(rgb: RGB): RGB {
  const a = 2.51;
  const b = 0.03;
  const c = 2.43;
  const d = 0.59;
  const e = 0.14;
  const map = (x: number) => clamp01((x * (a * x + b)) / (x * (c * x + d) + e));
  return [map(rgb[0]), map(rgb[1]), map(rgb[2])];
}

export function applyToneMap(rgb: RGB, mode: "aces" | "reinhard" | "none", exposure = 1): RGB {
  const exposed: RGB = [rgb[0] * exposure, rgb[1] * exposure, rgb[2] * exposure];
  if (mode === "none") {
    return [clamp01(exposed[0]), clamp01(exposed[1]), clamp01(exposed[2])];
  }
  if (mode === "reinhard") {
    return reinhardToneMap(exposed);
  }
  return acesToneMap(exposed);
}

export function rgb255ToLinear(rgb: [number, number, number]): RGB {
  return srgbToLinear([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255]);
}
