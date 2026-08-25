import { describe, expect, it } from "vitest";
import {
  approximateSun,
  parseSunEntity,
  playgroundSunPresets,
  resolvePlanNorthDeg,
  shadeSun,
  solarPosition,
  sunDirection,
  sunShadingFromHass,
  waalbandijkFloorSunContext,
  WAALBANDIJK_SUN_LOCATION,
} from "../src/sun";

describe("sun direction", () => {
  it("puts noon-north light along +Z (plan north)", () => {
    const d = sunDirection(0, 0, 0);
    expect(d.x).toBeCloseTo(0, 5);
    expect(d.y).toBeCloseTo(0, 5);
    expect(d.z).toBeCloseTo(1, 5);
  });

  it("puts due-east light along +X", () => {
    const d = sunDirection(90, 0, 0);
    expect(d.x).toBeCloseTo(1, 5);
    expect(d.y).toBeCloseTo(0, 5);
    expect(d.z).toBeCloseTo(0, 5);
  });

  it("raises the sun with elevation", () => {
    const d = sunDirection(180, 90, 0);
    expect(d.y).toBeCloseTo(1, 5);
  });

  it("rotates plan +Y with building north offset", () => {
    // plan +Y = east (90°); geographic north lies along -plan X (Blender X stays east).
    const d = sunDirection(0, 30, 90);
    expect(d.x).toBeLessThan(-0.5);
    expect(Math.abs(d.z)).toBeLessThan(0.2);
  });

  it("keeps SW afternoon sun west of plan when plan +Y is south (north 180)", () => {
    const ref = approximateSun(new Date("2026-08-24T16:12:00+02:00"));
    const d = sunDirection(ref.azimuth, ref.elevation, 180);
    expect(d.x).toBeLessThan(-0.5);
    expect(d.z).toBeGreaterThan(0.4);
  });
});

describe("resolvePlanNorthDeg", () => {
  it("prefers card config over scene sidecar", () => {
    expect(resolvePlanNorthDeg(90, 180)).toBe(90);
  });

  it("falls back to scene sidecar", () => {
    expect(resolvePlanNorthDeg(undefined, 180)).toBe(180);
  });

  it("defaults to 0", () => {
    expect(resolvePlanNorthDeg(undefined, undefined)).toBe(0);
  });
});

describe("sun shading", () => {
  it("zeros the lamp below civil twilight", () => {
    expect(shadeSun({ azimuth: 200, elevation: -12 }).sunIntensity).toBe(0);
  });

  it("is bright at a high sun", () => {
    const day = shadeSun({ azimuth: 180, elevation: 50 });
    expect(day.sunIntensity).toBeGreaterThan(0.8);
    expect(day.enabled).toBe(true);
  });

  it("boosts ambient on upper floors", () => {
    const low = shadeSun({ azimuth: 230, elevation: 30, floor: waalbandijkFloorSunContext(1) });
    const high = shadeSun({ azimuth: 230, elevation: 30, floor: waalbandijkFloorSunContext(10) });
    expect(high.ambientIntensity).toBeGreaterThan(low.ambientIntensity);
    expect(high.targetElevationCm).toBe(150);
  });

  it("can disable the dynamic lamp", () => {
    expect(shadeSun({ azimuth: 180, elevation: 50, enabled: false }).enabled).toBe(
      false,
    );
  });
});

describe("HA sun entity", () => {
  it("reads azimuth and elevation attributes", () => {
    expect(
      parseSunEntity({
        state: "above_horizon",
        attributes: { azimuth: 142.2, elevation: 33.1 },
      }),
    ).toEqual({ azimuth: 142.2, elevation: 33.1 });
  });

  it("returns null when attributes are missing", () => {
    expect(parseSunEntity({ state: "above_horizon", attributes: {} })).toBeNull();
  });

  it("uses sun.sun when ambient is sun", () => {
    const s = sunShadingFromHass(
      {
        states: {
          "sun.sun": {
            state: "above_horizon",
            attributes: { azimuth: 90, elevation: 0 },
          },
        },
      },
      "sun",
      0,
    );
    expect(s.direction.x).toBeCloseTo(1, 5);
    expect(s.enabled).toBe(true);
  });

  it("turns the lamp off when ambient is off", () => {
    const s = sunShadingFromHass(undefined, "off", 0);
    expect(s.enabled).toBe(false);
  });

  it("falls back to the clock when the entity is missing", () => {
    const noon = approximateSun(new Date("2026-06-21T12:00:00+02:00"));
    expect(noon.elevation).toBeGreaterThan(40);
    const afternoon = approximateSun(new Date("2026-08-24T16:12:00+02:00"));
    expect(afternoon.azimuth).toBeGreaterThan(225);
    expect(afternoon.azimuth).toBeLessThan(235);
    expect(afternoon.elevation).toBeGreaterThan(35);
    const night = approximateSun(new Date("2026-06-21T00:30:00+02:00"));
    expect(night.elevation).toBeLessThan(0);
  });

  it("matches Floorplanner reference for 24 Aug 2026 16:12", () => {
    const ref = solarPosition(
      new Date("2026-08-24T16:12:00+02:00"),
      WAALBANDIJK_SUN_LOCATION.latitude,
      WAALBANDIJK_SUN_LOCATION.longitude,
    );
    expect(ref.azimuth).toBeCloseTo(230, 0);
    expect(ref.elevation).toBeCloseTo(39, 0);
    expect(playgroundSunPresets().afternoon).toEqual(ref);
  });
});
