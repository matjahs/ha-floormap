import { describe, expect, it } from "vitest";
import {
  effectiveSunElevation,
  localHorizonElevationDeg,
  observerHeightM,
  resolveFloorSunContext,
  waalbandijkFloorSunContext,
} from "../src/sun-horizon";

describe("sun-horizon / elevation_m", () => {
  it("prefers elevation_m for observer height", () => {
    expect(observerHeightM({ floorLevel: 10, floorHeightM: 3.05, elevationM: 32 })).toBe(32);
    expect(observerHeightM({ floorLevel: 10, floorHeightM: 3.05 })).toBeCloseTo(27.45, 5);
  });

  it("dips the local horizon from observer height", () => {
    const ctx = waalbandijkFloorSunContext(10);
    const dip = localHorizonElevationDeg(ctx, 90);
    expect(dip).toBeLessThan(0);
    expect(dip).toBeGreaterThan(-0.5);
  });

  it("advances effective elevation via elevation_m (high floor sees sun earlier)", () => {
    const street = resolveFloorSunContext({ floorLevel: 1, floorHeightM: 3.05 })!;
    const high = waalbandijkFloorSunContext(10);
    expect(effectiveSunElevation(0, high)).toBeGreaterThan(effectiveSunElevation(0, street));
    expect(effectiveSunElevation(-0.05, high)).toBeGreaterThan(0);
  });
});
