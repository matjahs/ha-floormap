import { describe, expect, it } from "vitest";
import { solarPosition, WAALBANDIJK_SUN_LOCATION } from "../src/solar";

describe("solarPosition", () => {
  it("returns SW afternoon sun for Waalbandijk on 24 Aug 2026 16:12", () => {
    const pos = solarPosition(
      new Date("2026-08-24T16:12:00+02:00"),
      WAALBANDIJK_SUN_LOCATION.latitude,
      WAALBANDIJK_SUN_LOCATION.longitude,
    );
    expect(pos.azimuth).toBeCloseTo(231.22, 1);
    expect(pos.elevation).toBeCloseTo(38.75, 1);
  });
});
