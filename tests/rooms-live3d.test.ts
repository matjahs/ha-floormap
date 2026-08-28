import { describe, expect, it } from "vitest";
import { importBlenderScene } from "../src/import/blender";
import {
  buildRoomHotspotsLive3d,
  hitTestRoom,
  roomDisplayName,
} from "../src/renderer/shared/rooms";
import { discoverGroupIds, memberEntitiesForGroup } from "../src/groups";
import sceneJson from "../dev/public/local/floorplan/appartement.scene.json";
import type { SunflowFloorplanCardConfig } from "../src/types";

describe("Blender room hotspots", () => {
  it("projects floor polygons through live3d and hit-tests stage UV", () => {
    const ir = importBlenderScene(sceneJson);
    const hotspots = buildRoomHotspotsLive3d(ir, (planPos) => ({
      left: planPos.x / 10,
      top: planPos.y / 10,
    }));
    expect(hotspots.length).toBeGreaterThan(0);
    const kitchen = hotspots.find((h) => h.room.id === "kitchen");
    expect(kitchen).toBeDefined();
    const mid = kitchen!.polygonUv.reduce(
      (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
      { x: 0, y: 0 },
    );
    mid.x /= kitchen!.polygonUv.length;
    mid.y /= kitchen!.polygonUv.length;
    expect(hitTestRoom(hotspots, mid.x, mid.y)?.room.id).toBe("kitchen");
  });

  it("discovers group ids from Blender rooms", () => {
    const ir = importBlenderScene(sceneJson);
    const cfg = {
      type: "custom:sunflow-floorplan-card",
      entities: { L01: { entity: "light.a" } },
    } as SunflowFloorplanCardConfig;
    const ids = discoverGroupIds(cfg, undefined, ir);
    expect(ids).toContain("kitchen");
    expect(ids).toContain("living");
    expect(ids.length).toBe(ir.rooms.length);
  });

  it("resolves members by fixture roomId", () => {
    const ir = importBlenderScene(sceneJson);
    const cfg = {
      type: "custom:sunflow-floorplan-card",
      entities: {
        L01: { entity: "light.livingroom_light_3" },
        L06: { entity: "light.kitchen_light_1" },
      },
      groups: { kitchen: { tap_action: { action: "toggle" } } },
    } as SunflowFloorplanCardConfig;
    const living = memberEntitiesForGroup(cfg, "living", undefined, ir);
    const kitchen = memberEntitiesForGroup(cfg, "kitchen", undefined, ir);
    expect(living).toContain("light.livingroom_light_3");
    expect(kitchen).toContain("light.kitchen_light_1");
    expect(living).not.toContain("light.kitchen_light_1");
  });

  it("shows Blender room names on chips", () => {
    const ir = importBlenderScene(sceneJson);
    expect(roomDisplayName(ir, "home_office")).toBe("Home Office");
    expect(roomDisplayName(ir, "living")).toBe("Living");
  });
});
