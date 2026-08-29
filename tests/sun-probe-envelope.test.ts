import { describe, expect, it } from "vitest";
import {
  eastWestPlanHintFromRooms,
  facadeNormalFromEnvelope,
  geographicFacadeNormal,
  geometricOutwardFromEnvelope,
  meshXPointsEast,
} from "../src/sun-probe-envelope";
import { facadeReceivesDirectSun } from "../src/sun-probes";
import { sunDirection } from "../src/sun";
import scene from "../dev/public/local/floorplan/appartement.scene.json";

describe("sun probe envelope", () => {
  const env = { minX: 50, maxX: 1400, minZ: 100, maxZ: 1300 };
  const hint = eastWestPlanHintFromRooms(
    scene.rooms.map((r) => ({
      id: r.id,
      polygon: r.polygon.map(([x, y]) => ({ x, y })),
    })),
  )!;

  it("derives living west and bedroom/office east from room polygons", () => {
    expect(hint.westX).toBeLessThan(500);
    expect(hint.eastX).toBeGreaterThan(900);
    // Same ordering in mesh space → +X is east
    expect(meshXPointsEast(hint.westX, hint.eastX, hint)).toBe(true);
  });

  it("detects mirrored mesh when office is at lower X than living", () => {
    expect(meshXPointsEast(-350, -1450, hint)).toBe(false);
  });

  it("geometric outward: maxX → +X, minX → −X", () => {
    expect(geometricOutwardFromEnvelope(1350, 700, env).x).toBe(1);
    expect(geometricOutwardFromEnvelope(120, 700, env).x).toBe(-1);
  });

  it("assigns geographic east facade +X (sun math) when aligned or mirrored", () => {
    const aligned = facadeNormalFromEnvelope(1350, 700, env, true);
    const westAligned = facadeNormalFromEnvelope(120, 700, env, true);
    expect(aligned.x).toBeCloseTo(1, 5);
    expect(westAligned.x).toBeCloseTo(-1, 5);

    const mirroredEnv = { minX: -1500, maxX: 50, minZ: 100, maxZ: 1300 };
    const eastGeo = facadeNormalFromEnvelope(-1450, 700, mirroredEnv, false);
    const westGeo = facadeNormalFromEnvelope(0, 700, mirroredEnv, false);
    expect(eastGeo.x).toBeCloseTo(1, 5);
    expect(westGeo.x).toBeCloseTo(-1, 5);
    // Placement stays geometric: east wall outer face is minX (−X)
    expect(geometricOutwardFromEnvelope(-1450, 700, mirroredEnv).x).toBe(-1);
  });

  it("geographic flip leaves Z unchanged", () => {
    expect(geographicFacadeNormal({ x: 0, y: 0, z: 1 }, false).z).toBe(1);
  });

  it("matches dawn/evening sun vs east/west envelope facades", () => {
    const north = 180;
    const mirrorX = true;
    const morning = sunDirection(75, 3, north, mirrorX);
    const evening = sunDirection(268, 15, north, mirrorX);
    const eastN = facadeNormalFromEnvelope(env.maxX - 20, 700, env, true);
    const westN = facadeNormalFromEnvelope(env.minX + 20, 700, env, true);
    expect(facadeReceivesDirectSun(eastN, morning)).toBe(true);
    expect(facadeReceivesDirectSun(westN, morning)).toBe(false);
    expect(facadeReceivesDirectSun(westN, evening)).toBe(true);
    expect(facadeReceivesDirectSun(eastN, evening)).toBe(false);
  });
});
