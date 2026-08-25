import { describe, expect, it } from "vitest";
import {
  buildGroupTapHotspots,
  clientToStagePercent,
  hitTestGroupTap,
  hitTapEdge,
  hitTapVertex,
  discoverGroupIds,
} from "../src/groups";
import type { SunflowFloorplanCardConfig } from "../src/types";

describe("tap area hit-test", () => {
  it("hits inside polygon and misses outside", () => {
    const hotspots = buildGroupTapHotspots({
      kitchen: {
        tap_area: [
          [10, 10],
          [40, 10],
          [40, 40],
          [10, 40],
        ],
      },
    });
    expect(hitTestGroupTap(hotspots, 0.25, 0.25)?.groupId).toBe("kitchen");
    expect(hitTestGroupTap(hotspots, 0.5, 0.5)).toBeUndefined();
  });

  it("discovers groups from membership for draw UI", () => {
    const cfg = {
      type: "custom:sunflow-floorplan-card",
      entities: {
        a: { entity: "light.a", group: "kitchen" },
        b: { entity: "light.b", group: "living" },
      },
      groups: { kitchen: {} },
    } as SunflowFloorplanCardConfig;
    expect(discoverGroupIds(cfg)).toEqual(["kitchen", "living"]);
  });

  it("maps client pixels into clamped stage percent", () => {
    const rect = { left: 100, top: 50, width: 200, height: 100 };
    expect(clientToStagePercent(rect, 100, 50)).toEqual([0, 0]);
    expect(clientToStagePercent(rect, 200, 100)).toEqual([50, 50]);
    expect(clientToStagePercent(rect, 300, 150)).toEqual([100, 100]);
    expect(clientToStagePercent(rect, 0, 0)).toEqual([0, 0]);
    expect(clientToStagePercent(rect, 500, 400)).toEqual([100, 100]);
  });

  it("hits the nearest tap vertex within threshold", () => {
    const pts: [number, number][] = [
      [10, 10],
      [40, 10],
      [40, 40],
      [10, 40],
    ];
    expect(hitTapVertex(pts, [10, 10], 3)).toBe(0);
    expect(hitTapVertex(pts, [41, 11], 3)).toBe(1);
    expect(hitTapVertex(pts, [25, 25], 3)).toBe(-1);
  });

  it("hits a tap edge and reports insert index", () => {
    const pts: [number, number][] = [
      [10, 10],
      [40, 10],
      [40, 40],
      [10, 40],
    ];
    const top = hitTapEdge(pts, [25, 10], 3);
    expect(top?.insertAt).toBe(1);
    expect(top?.point).toEqual([25, 10]);
    const closing = hitTapEdge(pts, [10, 25], 3);
    expect(closing?.insertAt).toBe(4);
    expect(hitTapEdge(pts, [25, 25], 3)).toBeNull();
  });
});
