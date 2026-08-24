import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { importBlenderScene, isBlenderSceneFile } from "../src/import/blender";

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
    expect(ir.fixtures[1]?.kind).toBe("strip");
    expect(ir.fixtures[1]?.samples).toBe(8);
    expect(ir.cameras[0]?.id).toBe("DollhouseCam");
    expect(ir.environment.dollhouseView?.fovDeg).toBeCloseTo(39.598);
    expect(ir.environment.planNorthDeg).toBe(180);
    expect(ir.environment.floorLevel).toBe(10);
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
    expect(ir.cameras[0]?.id).toBe("DollhouseCam");
  });
});
