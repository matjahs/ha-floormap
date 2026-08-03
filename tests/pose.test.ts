import { describe, expect, it } from "vitest";
import { emptyIR } from "../src/import/ir";
import {
  mergePlacementsIntoOverrides,
  overridesToPlacements,
  resolveFixturePose,
} from "../src/pose";
import { projectToPercent } from "../src/projection";
import type { CameraIR } from "../src/import/ir";

describe("resolveFixturePose", () => {
  const ir = emptyIR("sweethome3d", "test");
  ir.fixtures.push({
    id: "fx1",
    name: "Hall",
    position: { x: 100, y: 200, z: 180 },
    color: "#ffffff",
    power: 60,
  });

  it("returns IR position when no override", () => {
    expect(resolveFixturePose(ir, "fx1")).toEqual({ x: 100, y: 200, z: 180 });
  });

  it("prefers overrides.position over IR", () => {
    expect(
      resolveFixturePose(ir, "fx1", {
        fx1: { position: [10, 20, 30] },
      }),
    ).toEqual({ x: 10, y: 20, z: 30 });
  });

  it("returns undefined for unknown fixture without override", () => {
    expect(resolveFixturePose(ir, "missing")).toBeUndefined();
  });

  it("accepts position-only override without IR fixture", () => {
    expect(
      resolveFixturePose(ir, "manual", {
        manual: { position: [1, 2, 3] },
      }),
    ).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe("placements merge", () => {
  it("merges placements into overrides", () => {
    const merged = mergePlacementsIntoOverrides(
      { a: { gain: 1.2 } },
      { a: { position: [5, 6, 7] }, b: { position: [1, 1, 1] } },
    );
    expect(merged.a).toEqual({ gain: 1.2, position: [5, 6, 7] });
    expect(merged.b).toEqual({ position: [1, 1, 1] });
  });

  it("exports only position overrides", () => {
    expect(
      overridesToPlacements({
        a: { position: [1, 2, 3], gain: 2 },
        b: { marker: [10, 20] },
      }),
    ).toEqual({ a: { position: [1, 2, 3] } });
  });
});

describe("projection follows resolved pose", () => {
  it("uses override pose when projecting", () => {
    const ir = emptyIR("sweethome3d", "test");
    ir.fixtures.push({
      id: "fx1",
      name: "Hall",
      position: { x: 100, y: 200, z: 180 },
      color: "#ffffff",
      power: 60,
    });
    const cam: CameraIR = {
      id: "c1",
      kind: "camera",
      attribute: "storedCamera",
      lens: "NORMAL",
      x: 400,
      y: 800,
      z: 400,
      yaw: 0,
      pitch: -0.6,
      fieldOfView: Math.PI / 3,
    };
    const base = resolveFixturePose(ir, "fx1")!;
    const moved = resolveFixturePose(ir, "fx1", {
      fx1: { position: [900, 200, 180] },
    })!;
    const a = projectToPercent(cam, base, { aspect: 16 / 9 });
    const b = projectToPercent(cam, moved, { aspect: 16 / 9 });
    expect(Math.abs(a.left - b.left) + Math.abs(a.top - b.top)).toBeGreaterThan(1);
  });
});
