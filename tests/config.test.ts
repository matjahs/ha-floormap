import { describe, expect, it } from "vitest";
import { validateConfig, stubConfig } from "../src/config";
import {
  buildGroupTapHotspots,
  discoverGroupIds,
  hitTestGroupTap,
  memberEntitiesForGroup,
} from "../src/groups";
import {
  averageStripParams,
  lerpStrip,
  paramsForStripSamples,
  segmentMidpoint,
  stripSamplePositions,
} from "../src/strip";
import type { LightParams } from "../src/types";

describe("config validation", () => {
  it("accepts stub config", () => {
    const cfg = validateConfig(stubConfig());
    expect(cfg.type).toContain("sunflow");
  });

  it("rejects empty object", () => {
    expect(() => validateConfig({})).toThrow(/missing type|manifest|ir|renders|entities/);
  });

  it("rejects config without data sources", () => {
    expect(() => validateConfig({ type: "custom:sunflow-floorplan-card" })).toThrow(
      /manifest|ir|renders|entities/,
    );
  });

  it("rejects bad render.mode", () => {
    expect(() =>
      validateConfig({
        type: "custom:sunflow-floorplan-card",
        entities: { a: { entity: "light.x" } },
        render: { mode: "nope" },
      }),
    ).toThrow(/render.mode/);
  });

  it("rejects bad render.gpu", () => {
    expect(() =>
      validateConfig({
        type: "custom:sunflow-floorplan-card",
        entities: { a: { entity: "light.x" } },
        render: { gpu: "vulkan" as "webgpu" },
      }),
    ).toThrow(/render\.gpu/);
  });

  it("rejects bad render.engine", () => {
    expect(() =>
      validateConfig({
        type: "custom:sunflow-floorplan-card",
        entities: { a: { entity: "light.x" } },
        render: { engine: "unity" as "three" },
      }),
    ).toThrow(/render\.engine/);
  });

  it("rejects bad render.lock_camera", () => {
    expect(() =>
      validateConfig({
        type: "custom:sunflow-floorplan-card",
        entities: { a: { entity: "light.x" } },
        render: { lock_camera: "yes" as unknown as boolean },
      }),
    ).toThrow(/render\.lock_camera/);
  });

  it("rejects marker override that is not a pair", () => {
    expect(() =>
      validateConfig({
        type: "custom:sunflow-floorplan-card",
        entities: { a: { entity: "light.x" } },
        overrides: { a: { marker: [1] } },
      }),
    ).toThrow(/marker/);
  });

  it("rejects bad position override", () => {
    expect(() =>
      validateConfig({
        type: "custom:sunflow-floorplan-card",
        entities: { a: { entity: "light.x" } },
        overrides: { a: { position: [1, 2] } },
      }),
    ).toThrow(/position/);
  });

  it("accepts position override triple", () => {
    const cfg = validateConfig({
      type: "custom:sunflow-floorplan-card",
      entities: { a: { entity: "light.x" } },
      overrides: { a: { position: [1, 2, 3] } },
      edit_mode: true,
      placements: "/local/floorplan/placements.json",
    });
    expect(cfg.overrides?.a?.position).toEqual([1, 2, 3]);
    expect(cfg.edit_mode).toBe(true);
  });

  it("accepts scene_glb as a data source", () => {
    const cfg = validateConfig({
      type: "custom:sunflow-floorplan-card",
      scene_glb: "/local/floorplan/appartement.glb",
      entities: { L01: { entity: "light.livingroom_light_1" } },
    });
    expect(cfg.scene_glb).toContain("appartement.glb");
  });

  it("accepts groups with tap_area polygon", () => {
    const cfg = validateConfig({
      type: "custom:sunflow-floorplan-card",
      entities: { a: { entity: "light.x", group: "kitchen" } },
      groups: {
        kitchen: {
          entity: "light.kitchen",
          tap_area: [
            [10, 10],
            [40, 10],
            [40, 40],
            [10, 40],
          ],
        },
      },
    });
    expect(cfg.groups?.kitchen?.tap_area).toHaveLength(4);
  });

  it("rejects tap_area with fewer than 3 points", () => {
    expect(() =>
      validateConfig({
        type: "custom:sunflow-floorplan-card",
        entities: { a: { entity: "light.x" } },
        groups: { g: { tap_area: [[1, 1], [2, 2]] } },
      }),
    ).toThrow(/tap_area/);
  });

  it("accepts strip segments in [0,1]", () => {
    const cfg = validateConfig({
      type: "custom:sunflow-floorplan-card",
      entities: {
        strip: {
          entity: "light.master",
          segments: [
            { entity: "light.a", start: 0, end: 0.5 },
            { entity: "light.b", start: 0.5, end: 1 },
          ],
        },
      },
      overrides: { strip: { kind: "strip", end: [1, 2, 3] } },
    });
    expect(cfg.entities?.strip?.segments).toHaveLength(2);
  });

  it("rejects segment fractions outside [0,1]", () => {
    expect(() =>
      validateConfig({
        type: "custom:sunflow-floorplan-card",
        entities: {
          strip: {
            entity: "light.master",
            segments: [{ entity: "light.a", start: -0.1, end: 0.5 }],
          },
        },
      }),
    ).toThrow(/\[0,1\]/);
  });
});

describe("groups helpers", () => {
  it("discovers ids from entities and groups map", () => {
    const ids = discoverGroupIds({
      type: "custom:sunflow-floorplan-card",
      entities: {
        a: { entity: "light.a", group: "kitchen" },
        b: { entity: "light.b", group: "living" },
      },
      groups: { office: {} },
    });
    expect(ids).toEqual(["kitchen", "living", "office"]);
  });

  it("lists member entities including segments and master", () => {
    const members = memberEntitiesForGroup(
      {
        type: "custom:sunflow-floorplan-card",
        entities: {
          a: {
            entity: "light.a",
            group: "kitchen",
            segments: [{ entity: "light.seg", start: 0, end: 1 }],
          },
        },
        groups: { kitchen: { entity: "light.kitchen" } },
      },
      "kitchen",
    );
    expect(members).toContain("light.kitchen");
    expect(members).toContain("light.a");
    expect(members).toContain("light.seg");
  });

  it("hit-tests group tap areas in stage UV", () => {
    const hotspots = buildGroupTapHotspots({
      kitchen: {
        tap_area: [
          [0, 0],
          [50, 0],
          [50, 50],
          [0, 50],
        ],
      },
    });
    expect(hitTestGroupTap(hotspots, 0.25, 0.25)?.groupId).toBe("kitchen");
    expect(hitTestGroupTap(hotspots, 0.9, 0.9)).toBeUndefined();
  });
});

describe("strip helpers", () => {
  const start = { x: 0, y: 0, z: 100 };
  const end = { x: 100, y: 0, z: 100 };

  it("samples along strip", () => {
    const pts = stripSamplePositions(start, end, 5);
    expect(pts).toHaveLength(5);
    expect(pts[0]).toEqual(start);
    expect(pts[4]).toEqual(end);
    expect(lerpStrip(start, end, 0.5).x).toBe(50);
  });

  it("segment midpoint", () => {
    const mid = segmentMidpoint(start, end, { entity: "light.x", start: 0.25, end: 0.75 });
    expect(mid.x).toBe(50);
  });

  it("maps sample params from segments", () => {
    const off: LightParams = {
      intensity: 0,
      color: [1, 1, 1],
      on: false,
      unavailable: false,
      unknown: false,
    };
    const onA: LightParams = { ...off, on: true, intensity: 1, color: [1, 0, 0] };
    const onB: LightParams = { ...off, on: true, intensity: 0.5, color: [0, 1, 0] };
    const master = off;
    const map = new Map([
      [0, onA],
      [1, onB],
    ]);
    const samples = paramsForStripSamples(
      4,
      [
        { entity: "a", start: 0, end: 0.5 },
        { entity: "b", start: 0.5, end: 1 },
      ],
      map,
      master,
    );
    expect(samples[0]!.color[0]).toBe(1);
    expect(samples[3]!.color[1]).toBe(1);
    const avg = averageStripParams(samples);
    expect(avg.on).toBe(true);
  });
});
