import { describe, expect, it } from "vitest";
import { importBlenderScene } from "../src/import/blender";
import {
  buildRoomHotspotsLive3d,
  hitTestRoom,
  roomDisplayName,
  roomHitTestElevationCm,
} from "../src/renderer/shared/rooms";
import { discoverGroupIds, memberEntitiesForGroup } from "../src/groups";
import sceneJson from "../dev/public/local/floorplan/appartement.scene.json";
import type { SunflowFloorplanCardConfig } from "../src/types";
import type { Vec3 } from "../src/types";

/** Approximate dollhouse home_view projector (plan cm → stage percent). */
function homeViewProject(planPos: Vec3): { left: number; top: number; behind?: boolean } | null {
  const eye = { x: -589.1, y: 1524.8, z: 667.7 };
  const target = { x: 748.3, y: 40.0, z: 658.7 };
  const fovDeg = 39.6;
  const aspect = 16 / 9;
  const world = { x: planPos.x, y: planPos.z, z: planPos.y };
  const sub = (a: { x: number; y: number; z: number }, b: typeof a) => ({
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  });
  const cross = (a: { x: number; y: number; z: number }, b: typeof a) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  });
  const dot = (a: { x: number; y: number; z: number }, b: typeof a) =>
    a.x * b.x + a.y * b.y + a.z * b.z;
  const norm = (v: { x: number; y: number; z: number }) => {
    const len = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  };
  const zAxis = norm(sub(eye, target));
  const xAxis = norm(cross({ x: 0, y: 1, z: 0 }, zAxis));
  const yAxis = cross(zAxis, xAxis);
  const d = sub(world, eye);
  const vx = dot(d, xAxis);
  const vy = dot(d, yAxis);
  const vz = dot(d, zAxis);
  if (vz >= -1e-6) {
    return { left: 0, top: 0, behind: true };
  }
  const f = 1 / Math.tan(((fovDeg * Math.PI) / 180) / 2);
  const ndcX = (f / aspect) * (vx / -vz);
  const ndcY = f * (vy / -vz);
  return {
    left: ((ndcX + 1) / 2) * 100,
    top: ((1 - ndcY) / 2) * 100,
  };
}

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

  it("uses ceiling elevation (not floor) for room hotspot projection", () => {
    const ir = importBlenderScene(sceneJson);
    const ceilingZ = roomHitTestElevationCm(ir);
    expect(ceilingZ).toBeGreaterThan(100);
    expect(ceilingZ).toBeLessThanOrEqual(ir.bounds.max.z);

    const zs: number[] = [];
    buildRoomHotspotsLive3d(ir, (planPos: Vec3) => {
      zs.push(planPos.z);
      return { left: planPos.x / 10, top: planPos.y / 10 };
    });
    expect(zs.length).toBeGreaterThan(0);
    expect(zs.every((z) => z === ceilingZ)).toBe(true);
    expect(zs[0]).not.toBe(1);
  });

  it("hits toilet (not utility) for toilet-light UV under dollhouse projection at ceiling Z", () => {
    const ir = importBlenderScene(sceneJson);
    const toiletLight = ir.fixtures.find((f) => f.id === "L16");
    expect(toiletLight).toBeDefined();
    const marker = homeViewProject(toiletLight!.position);
    expect(marker && !marker.behind).toBeTruthy();
    const u = marker!.left / 100;
    const v = marker!.top / 100;

    // Floor-plane projection (legacy) skews toilet taps into utility.
    const floorManual = ir.rooms.map((room) => {
      const polygonUv = room.polygon.map((p) => {
        const pct = homeViewProject({ x: p.x, y: p.y, z: 1 })!;
        return { x: pct.left / 100, y: pct.top / 100 };
      });
      return { room, polygonUv, areaId: room.areaHint };
    });
    expect(hitTestRoom(floorManual, u, v)?.room.id).toBe("utility");

    const ceilingHotspots = buildRoomHotspotsLive3d(ir, homeViewProject);
    expect(hitTestRoom(ceilingHotspots, u, v)?.room.id).toBe("toilet");
  });
});

describe("roomHitTestElevationCm", () => {
  it("prefers level clear height and clamps to mesh top underside", () => {
    const ir = importBlenderScene(sceneJson);
    // Appartement mesh top ~262; clear height capped at 250 → underside 249.
    expect(roomHitTestElevationCm(ir)).toBe(249);
    expect(ir.levels[0]?.height).toBe(250);
  });

  it("falls back to floorHeightCm when level height is missing", () => {
    const ir = importBlenderScene(sceneJson);
    ir.levels[0]!.height = 0;
    expect(roomHitTestElevationCm(ir, undefined, { floorHeightCm: 280 })).toBeCloseTo(
      Math.min(280, ir.bounds.max.z) - 1,
      5,
    );
  });
});
