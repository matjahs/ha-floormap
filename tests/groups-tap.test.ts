import { describe, expect, it } from "vitest";
import {
  buildGroupTapHotspots,
  hitTestGroupTap,
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
});
