import { describe, expect, it } from "vitest";
import {
  classifyExteriorWallName,
  evaluateSunProbeReceive,
  ndotTowardSun,
  probeSpatialKey,
  probeStationsAlongLength,
} from "../src/sun-probes";

describe("classifyExteriorWallName", () => {
  it("tags cavity leaves", () => {
    expect(classifyExteriorWallName("Wall_28 Ext–Office buitenblad")).toEqual({
      isExteriorWall: true,
      preferredSide: "exterior",
    });
    expect(classifyExteriorWallName("Wall_28 Ext–Office binnenblad")).toEqual({
      isExteriorWall: true,
      preferredSide: "interior",
    });
  });

  it("tags Ext walls without leaf suffix", () => {
    expect(classifyExteriorWallName("Wall_31 Ext–Office").isExteriorWall).toBe(true);
    expect(classifyExteriorWallName("Wall_31 Ext–Office").preferredSide).toBeNull();
  });

  it("ignores interior partitions", () => {
    expect(classifyExteriorWallName("Wall_41 Hallway–Office").isExteriorWall).toBe(false);
    expect(classifyExteriorWallName("Wall_13 Bedroom–Hallway").isExteriorWall).toBe(false);
  });

  it("does not treat 'ext' as a substring (Texture / next / extra)", () => {
    expect(classifyExteriorWallName("Wall_12 Texture").isExteriorWall).toBe(false);
    expect(classifyExteriorWallName("Wall next to stairs").isExteriorWall).toBe(false);
    expect(classifyExteriorWallName("Wall extra").isExteriorWall).toBe(false);
  });
});

describe("evaluateSunProbeReceive", () => {
  it("requires facing and clear ray", () => {
    expect(evaluateSunProbeReceive({ ndotL: 0.8, occluded: false }).receivesSun).toBe(true);
    expect(evaluateSunProbeReceive({ ndotL: 0.8, occluded: true }).receivesSun).toBe(false);
    expect(evaluateSunProbeReceive({ ndotL: -0.2, occluded: false }).receivesSun).toBe(false);
  });

  it("exterior buitenblad trusts facing only (no cavity self-occlusion)", () => {
    expect(
      evaluateSunProbeReceive({ ndotL: 0.96, occluded: true, trustFacingOnly: true }).receivesSun,
    ).toBe(true);
    expect(
      evaluateSunProbeReceive({ ndotL: 0.96, occluded: true, trustFacingOnly: true }).occluded,
    ).toBe(false);
    expect(
      evaluateSunProbeReceive({ ndotL: 0.96, occluded: true, trustFacingOnly: false }).receivesSun,
    ).toBe(false);
  });

  it("ndotTowardSun is a plain dot product", () => {
    expect(ndotTowardSun({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeCloseTo(1);
    expect(ndotTowardSun({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -1 })).toBeCloseTo(1);
  });
});

describe("probeStationsAlongLength", () => {
  it("puts one station on short walls", () => {
    expect(probeStationsAlongLength(80, 120, 50)).toEqual([40]);
  });

  it("spaces stations evenly on long walls", () => {
    const s = probeStationsAlongLength(600, 120, 50);
    expect(s.length).toBeGreaterThanOrEqual(4);
    expect(s[0]!).toBeGreaterThan(40);
    expect(s[s.length - 1]!).toBeLessThan(560);
    for (let i = 1; i < s.length; i++) {
      expect(s[i]! - s[i - 1]!).toBeGreaterThan(80);
    }
  });
});

describe("probeSpatialKey", () => {
  it("buckets nearby probes without embedding side", () => {
    expect(probeSpatialKey(100, 200, 80)).toBe(probeSpatialKey(110, 210, 80));
    expect(probeSpatialKey(100, 200, 80)).toBe(probeSpatialKey(100, 200, 80));
    expect(probeSpatialKey(100, 200, 80)).not.toBe(probeSpatialKey(400, 200, 80));
  });
});
