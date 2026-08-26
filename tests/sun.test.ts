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

  it("rotates plan +Y with building north offset without corrupting elevation", () => {
    // plan +Y = east (90°); geographic north lies along -plan X.
    const d = sunDirection(0, 30, 90);
    expect(d.x).toBeLessThan(-0.5);
    expect(Math.abs(d.z)).toBeLessThan(0.2);
    expect((Math.asin(d.y) * 180) / Math.PI).toBeCloseTo(30, 5);
  });

  it("preserves elevation across north/azimuth grids (no shear)", () => {
    const elev = 20;
    for (const north of [0, 45, 90, 135, 180, 270]) {
      for (const az of [0, 45, 90, 135, 180, 225, 270, 315]) {
        const d = sunDirection(az, elev, north);
        expect((Math.asin(Math.min(1, Math.max(-1, d.y))) * 180) / Math.PI).toBeCloseTo(elev, 5);
      }
    }
  });

  it("mirror_x restores east→+X when north is 180 (Blender Y-flip plans)", () => {
    const plain = sunDirection(90, 0, 180, false);
    const mirrored = sunDirection(90, 0, 180, true);
    expect(plain.x).toBeCloseTo(-1, 5);
    expect(mirrored.x).toBeCloseTo(1, 5);
  });

  it("keeps SW afternoon sun west of plan when plan +Y is south (north 180 + mirror_x)", () => {
    const ref = approximateSun(new Date("2026-08-24T16:12:00+02:00"));
    const d = sunDirection(ref.azimuth, ref.elevation, 180, true);
    expect(d.x).toBeLessThan(-0.5);
    expect(d.z).toBeGreaterThan(0.4);
  });

  it("Waalbandijk: morning sun from east (bedroom/office), evening from west (living)", () => {
    // Centroids: bedroom/office high plan X, living low plan X; north: 180 + mirror_x.
    const morning = approximateSun(new Date("2026-08-24T08:00:00+02:00"));
    const evening = approximateSun(new Date("2026-08-24T19:00:00+02:00"));
    const noon = approximateSun(new Date("2026-08-24T13:00:00+02:00"));
    const m = sunDirection(morning.azimuth, morning.elevation, 180, true);
    const e = sunDirection(evening.azimuth, evening.elevation, 180, true);
    const n = sunDirection(noon.azimuth, noon.elevation, 180, true);
    expect(m.x).toBeGreaterThan(0.5); // toward +X → bedroom / home office
    expect(e.x).toBeLessThan(-0.5); // toward −X → living
    // Midday: sun mostly south; neither E nor W facade dominates.
    expect(Math.abs(n.x)).toBeLessThan(0.45);
    expect(n.z).toBeGreaterThan(0.35);
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

  it("kills direct sun at and below the horizon", () => {
    expect(shadeSun({ azimuth: 289, elevation: -0.2 }).sunIntensity).toBe(0);
    expect(shadeSun({ azimuth: 289, elevation: 0 }).sunIntensity).toBe(0);
    expect(shadeSun({ azimuth: 75, elevation: 3 }).sunIntensity).toBeGreaterThan(0.17);
  });

  it("is bright at a high sun", () => {
    const day = shadeSun({ azimuth: 180, elevation: 50 });
    expect(day.sunIntensity).toBeGreaterThan(0.8);
    expect(day.enabled).toBe(true);
  });

  it("keeps daytime ambient low so ceiling shadows can read", () => {
    const day = shadeSun({ azimuth: 90, elevation: 25, floor: waalbandijkFloorSunContext(10) });
    expect(day.ambientIntensity).toBeLessThan(0.12);
    expect(day.sunIntensity).toBeGreaterThan(0.55);
    expect(day.fillIntensity).toBeLessThan(0.08);
  });

  it("boosts twilight fill on upper floors", () => {
    const low = shadeSun({ azimuth: 230, elevation: -4, floor: waalbandijkFloorSunContext(1) });
    const high = shadeSun({ azimuth: 230, elevation: -4, floor: waalbandijkFloorSunContext(10) });
    expect(high.fillIntensity).toBeGreaterThan(low.fillIntensity);
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

  it("matches Floorplanner-era afternoon sun for 24 Aug 2026 16:12 at Waalbandijk", () => {
    const ref = solarPosition(
      new Date("2026-08-24T16:12:00+02:00"),
      WAALBANDIJK_SUN_LOCATION.latitude,
      WAALBANDIJK_SUN_LOCATION.longitude,
    );
    // Nijmegen / Waalbandijk (~51.85, 5.86); Amsterdam stand-in was ~230°.
    expect(ref.azimuth).toBeCloseTo(231, 0);
    expect(ref.elevation).toBeCloseTo(39, 0);
    expect(playgroundSunPresets().afternoon).toEqual(ref);
  });

  it("derives playground presets from real solar times on the reference day", () => {
    const presets = playgroundSunPresets();
    expect(presets.dawn.elevation).toBeGreaterThan(0);
    expect(presets.dawn.elevation).toBeLessThan(8);
    expect(presets.noon.elevation).toBeGreaterThan(40);
    expect(presets.sunset.elevation).toBeGreaterThan(0);
    expect(presets.sunset.elevation).toBeLessThan(12);
    expect(presets.night.elevation).toBeLessThan(0);
  });
});
