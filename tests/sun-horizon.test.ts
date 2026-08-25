import { describe, expect, it } from "vitest";
import {
  effectiveSunElevation,
  localHorizonElevationDeg,
  observerHeightM,
  resolveFloorSunContext,
  waalbandijkFloorSunContext,
} from "../src/sun-horizon";

describe("floor sun horizon", () => {
  const ctx10 = waalbandijkFloorSunContext(10);
  const ctx1 = waalbandijkFloorSunContext(1);

  it("places the observer on the 10th floor", () => {
    expect(observerHeightM(ctx10)).toBeCloseTo(9 * 3.05, 2);
  });

  it("clears mid-rise obstructions on floor 10", () => {
    expect(localHorizonElevationDeg(ctx10, 230)).toBe(0);
  });

  it("blocks low sun more on street level than on floor 10", () => {
    const lowSun = 8;
    expect(effectiveSunElevation(lowSun, ctx1, 230)).toBeLessThan(
      effectiveSunElevation(lowSun, ctx10, 230),
    );
  });

  it("keeps afternoon sun at 16:12 essentially unchanged on floor 10", () => {
    const afternoonEl = 39;
    expect(effectiveSunElevation(afternoonEl, ctx10, 230)).toBeCloseTo(afternoonEl, 1);
  });

  it("resolves floor level from card config", () => {
    expect(
      resolveFloorSunContext({
        floorLevel: 10,
        obstruction: { west_height_m: 5, west_distance_m: 70 },
      })?.floorLevel,
    ).toBe(10);
  });
});
