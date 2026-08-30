import { describe, expect, it } from "vitest";
import {
  acesToneMap,
  brightnessToIntensity,
  DEFAULT_FIXTURE_GAIN,
  kelvinToRgb,
  relativeLuminance,
  reinhardToneMap,
  srgbToLinear,
  applyToneMap,
} from "../src/color";
import { mergeOverride } from "../src/renderer/shared/state";

describe("color / brightness", () => {
  it("maps 20% brightness much dimmer than 100% in linear energy", () => {
    const full = brightnessToIntensity(255, "on", 2.2, 1, 1);
    const dim = brightnessToIntensity(Math.round(0.2 * 255), "on", 2.2, 1, 1);
    expect(full).toBeCloseTo(1, 5);
    expect(dim).toBeLessThan(0.05);
    expect(dim / full).toBeLessThan(0.1);
  });

  it("applies default fixture gain so 50% HA brightness is clearly visible", () => {
    const mid = brightnessToIntensity(Math.round(0.5 * 255), "on", 2.2, 1, DEFAULT_FIXTURE_GAIN);
    const midUnlifted = brightnessToIntensity(Math.round(0.5 * 255), "on", 2.2, 1, 1);
    expect(DEFAULT_FIXTURE_GAIN).toBe(3);
    expect(mid).toBeCloseTo(midUnlifted * DEFAULT_FIXTURE_GAIN, 5);
    expect(mid).toBeGreaterThan(0.6);
  });

  it("returns 0 intensity when off / unavailable", () => {
    expect(brightnessToIntensity(255, "off")).toBe(0);
    expect(brightnessToIntensity(255, "unavailable")).toBe(0);
  });

  it("shifts Kelvin from warm to cool without changing luminance much", () => {
    const warm = kelvinToRgb(2200);
    const cool = kelvinToRgb(6500);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThan(warm[2]);
    expect(relativeLuminance(warm)).toBeCloseTo(1, 1);
    expect(relativeLuminance(cool)).toBeCloseTo(1, 1);
  });

  it("tone maps bright values below 1", () => {
    const hot: [number, number, number] = [4, 4, 4];
    const aces = acesToneMap(hot);
    const rh = reinhardToneMap(hot);
    expect(aces[0]).toBeLessThan(1);
    expect(rh[0]).toBeLessThan(1);
    expect(applyToneMap(hot, "none", 1)[0]).toBe(1);
  });

  it("srgb/linear round-trip roughly", () => {
    const lin = srgbToLinear([0.5, 0.5, 0.5]);
    expect(lin[0]).toBeGreaterThan(0.2);
    expect(lin[0]).toBeLessThan(0.5);
  });
});

describe("mergeOverride fixture gain", () => {
  it("defaults every fixture to DEFAULT_FIXTURE_GAIN", () => {
    expect(mergeOverride({ power: 1 }).gain).toBe(DEFAULT_FIXTURE_GAIN);
  });

  it("keeps the default brightness curve at gamma", () => {
    expect(mergeOverride({ power: 1 }).curve).toBe("gamma");
  });

  it("uses render.fixture_gain when no per-fixture override", () => {
    expect(mergeOverride({ power: 1 }, undefined, 4).gain).toBe(4);
  });

  it("lets per-fixture gain win over the default", () => {
    expect(mergeOverride({ power: 1 }, { gain: 1.2 }, 3).gain).toBe(1.2);
  });
});
