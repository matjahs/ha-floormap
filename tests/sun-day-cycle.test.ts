import { describe, expect, it } from "vitest";
import {
  approximateSun,
  playgroundSunPresets,
  shadeSun,
  sunDirection,
  waalbandijkFloorSunContext,
} from "../src/sun";

const NORTH = 180;
const MIRROR_X = true;
const REF_DAY = "2026-08-24";
const FLOOR10 = waalbandijkFloorSunContext(10);

function atTime(hour: number, minute = 0) {
  return approximateSun(
    new Date(
      `${REF_DAY}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+02:00`,
    ),
  );
}

describe("Waalbandijk day cycle (plan north 180 + mirror_x, floor 10)", () => {
  it("morning sun favors the east facade (bedroom / office)", () => {
    for (const hour of [7, 8, 9, 10, 11]) {
      const pose = atTime(hour);
      const d = sunDirection(pose.azimuth, pose.elevation, NORTH, MIRROR_X);
      expect(d.x).toBeGreaterThan(0.45);
    }
  });

  it("midday sun is mostly south with little east/west bias", () => {
    for (const hour of [12, 13, 14]) {
      const pose = atTime(hour);
      const d = sunDirection(pose.azimuth, pose.elevation, NORTH, MIRROR_X);
      expect(Math.abs(d.x)).toBeLessThan(0.45);
      expect(d.z).toBeGreaterThan(0.35);
    }
  });

  it("afternoon and evening sun favors the west facade (living)", () => {
    for (const hour of [16, 17, 18, 19]) {
      const pose = atTime(hour);
      const d = sunDirection(pose.azimuth, pose.elevation, NORTH, MIRROR_X);
      expect(d.x).toBeLessThan(-0.45);
    }
  });

  it("lights the living side at sunset preset and keeps morning off before sunrise", () => {
    const presets = playgroundSunPresets();
    const dawn = sunDirection(presets.dawn.azimuth, presets.dawn.elevation, NORTH, MIRROR_X);
    const sunset = sunDirection(presets.sunset.azimuth, presets.sunset.elevation, NORTH, MIRROR_X);
    expect(dawn.x).toBeGreaterThan(0.45);
    expect(sunset.x).toBeLessThan(-0.45);
    expect(
      shadeSun({ ...presets.dawn, north: NORTH, mirrorX: MIRROR_X, floor: FLOOR10 }).sunIntensity,
    ).toBeGreaterThan(0.15);
    expect(
      shadeSun({ ...atTime(6), north: NORTH, mirrorX: MIRROR_X, floor: FLOOR10 }).sunIntensity,
    ).toBe(0);
  });

  it("keeps sunset hour bright enough to read on west facades", () => {
    const evening = shadeSun({ ...atTime(19), north: NORTH, mirrorX: MIRROR_X, floor: FLOOR10 });
    expect(evening.sunIntensity).toBeGreaterThan(0.45);
  });
});
