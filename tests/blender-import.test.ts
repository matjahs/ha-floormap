import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  importBlenderScene,
  isBlenderSceneFile,
  mergeEntitiesFromBlenderFixtures,
} from "../src/import/blender";

const fixturePath = resolve(
  __dirname,
  "fixtures/blender/appartement.scene.json",
);

describe("importBlenderScene", () => {
  it("loads sidecar fixtures and dollhouse camera", () => {
    const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect(isBlenderSceneFile(raw)).toBe(true);
    const ir = importBlenderScene(raw, "appartement.scene.json");
    expect(ir.source.kind).toBe("blender-glb");
    expect(ir.fixtures.map((f) => f.id)).toEqual(["L01", "L07"]);
    expect(ir.fixtures[0]?.entityId).toBe("light.livingroom_light_3");
    expect(ir.fixtures[1]?.kind).toBe("strip");
    expect(ir.fixtures[1]?.samples).toBe(8);
    expect(ir.fixtures[1]?.entityId).toBe(
      "light.kitchen_island_nanoleaf_light_strip",
    );
    expect(ir.cameras[0]?.id).toBe("DollhouseCam");
    expect(ir.environment.dollhouseView?.fovDeg).toBeCloseTo(39.598);
    expect(ir.environment.planNorthDeg).toBe(180);
    expect(ir.environment.floorLevel).toBe(10);
    expect(ir.environment.floorElevationM).toBe(32);
    expect(ir.walls).toEqual([]);
    expect(ir.furniture).toEqual([]);
  });

  it("rejects non-blender JSON", () => {
    expect(() => importBlenderScene({ floors: [] })).toThrow(/Blender scene/);
  });

  it("imports the exported playground sidecar", () => {
    const exported = resolve(
      __dirname,
      "../dev/public/local/floorplan/appartement.scene.json",
    );
    const raw = JSON.parse(readFileSync(exported, "utf8"));
    const ir = importBlenderScene(raw);
    expect(ir.fixtures).toHaveLength(18);
    expect(ir.fixtures.map((f) => f.id)).toEqual(
      Array.from({ length: 18 }, (_, i) => `L${String(i + 1).padStart(2, "0")}`),
    );
    expect(ir.fixtures[0]?.entityId).toBe("light.livingroom_light_3");
    expect(ir.fixtures[1]?.entityId).toBeUndefined();
    expect(ir.fixtures[3]?.entityId).toBe("light.livingroom_light_1");
    expect(ir.cameras[0]?.id).toBe("DollhouseCam");
  });
});

describe("mergeEntitiesFromBlenderFixtures", () => {
  it("lets Blender entity ids win while keeping card groups", () => {
    const merged = mergeEntitiesFromBlenderFixtures(
      {
        L01: { entity: "light.stale", group: "living" },
        L02: { entity: "light.placeholder", group: "living" },
      },
      [
        {
          id: "L01",
          name: "Living",
          position: { x: 0, y: 0, z: 0 },
          color: "#fff",
          power: 1,
          entityId: "light.livingroom_light_3",
        },
        {
          id: "L18",
          name: "Utility",
          position: { x: 0, y: 0, z: 0 },
          color: "#fff",
          power: 1,
          entityId: "light.utility_room",
        },
      ],
    );
    expect(merged.L01).toEqual({
      entity: "light.livingroom_light_3",
      group: "living",
    });
    expect(merged.L02).toEqual({
      entity: "light.placeholder",
      group: "living",
    });
    expect(merged.L18).toEqual({ entity: "light.utility_room" });
  });
});
