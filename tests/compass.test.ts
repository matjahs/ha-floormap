import { describe, expect, it } from "vitest";
import {
  geographicNorthRenderDir,
  horizontalDirToScreenDeg,
  PLAN_NORTH_RENDER_DIR,
  resolveCompassScreenBearings,
  screenOffsetToDeg,
  signedAngleDeltaDeg,
} from "../src/compass";

describe("compass bearings", () => {
  it("maps plan +Y to geographic north when config is 0", () => {
    const geo = geographicNorthRenderDir(0);
    expect(geo.x).toBeCloseTo(0, 5);
    expect(geo.z).toBeCloseTo(1, 5);
  });

  it("offsets geographic north when plan +Y points south (north 180)", () => {
    const geo = geographicNorthRenderDir(180);
    expect(geo.x).toBeCloseTo(0, 5);
    expect(geo.z).toBeCloseTo(-1, 5);
  });

  it("projects +Z as screen-up when camera looks straight down", () => {
    const basis = [1, 0, 0, 0, 0, -1];
    const deg = horizontalDirToScreenDeg(PLAN_NORTH_RENDER_DIR.x, PLAN_NORTH_RENDER_DIR.z, basis);
    expect(deg).toBeCloseTo(180, 0);
  });

  it("puts due-west sun left of geographic north on a top-down view (north 180)", () => {
    const basis = [1, 0, 0, 0, 0, -1];
    const geo = geographicNorthRenderDir(180);
    const northDeg = horizontalDirToScreenDeg(geo.x, geo.z, basis);
    expect(northDeg).toBeCloseTo(0, 0);
    const sunDeg = horizontalDirToScreenDeg(-1, 0, basis);
    expect(sunDeg).toBeCloseTo(-90, 0);
    expect(horizontalDirToScreenDeg(0, 1, basis)).toBeCloseTo(180, 0);
  });

  it("keeps SW sun ~230° clockwise from N (matches Blender sky / HA azimuth)", () => {
    const basis = [0.985, 0, -0.173, -0.167, 0.262, -0.951];
    const geo = geographicNorthRenderDir(180);
    const sun = { x: -0.55, z: 0.46 };
    const northDeg = horizontalDirToScreenDeg(geo.x, geo.z, basis);
    const sunDeg = horizontalDirToScreenDeg(sun.x, sun.z, basis);
    let delta = (sunDeg - northDeg + 360) % 360;
    expect(delta).toBeGreaterThan(200);
    expect(delta).toBeLessThan(260);
  });

  it("derives N from projected sun − azimuth (working rule)", () => {
    const sunScreen = 120;
    const az = 78;
    const resolved = resolveCompassScreenBearings({
      planNorthConfigDeg: 180,
      planNorthScreenDeg: 180,
      sunScreenDeg: sunScreen,
      sunAzimuthDeg: az,
      geographicNorthScreenDegFallback: 0,
    });
    expect(resolved.sunScreenDeg).toBe(120);
    expect(resolved.geographicNorthScreenDeg).toBeCloseTo(sunScreen - az, 5);
    expect(
      Math.abs(signedAngleDeltaDeg(resolved.sunScreenDeg! - resolved.geographicNorthScreenDeg, az)),
    ).toBeLessThan(0.01);
  });

  it("falls back to projected geo north when sun is down", () => {
    const resolved = resolveCompassScreenBearings({
      planNorthConfigDeg: 180,
      planNorthScreenDeg: 200,
      sunScreenDeg: null,
      sunAzimuthDeg: 78,
      geographicNorthScreenDegFallback: 42,
    });
    expect(resolved.sunScreenDeg).toBeNull();
    expect(resolved.geographicNorthScreenDeg).toBe(42);
  });

  it("maps screen offsets with 0° = up, clockwise", () => {
    expect(screenOffsetToDeg(0, 1)).toBeCloseTo(0, 5);
    expect(screenOffsetToDeg(1, 0)).toBeCloseTo(90, 5);
    expect(screenOffsetToDeg(0, -1)).toBeCloseTo(180, 5);
    expect(screenOffsetToDeg(-1, 0)).toBeCloseTo(-90, 5);
  });
});
