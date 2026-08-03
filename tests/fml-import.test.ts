import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { importFml } from "../src/import/fml";

const fmlPath = resolve(
  __dirname,
  "../dev/public/local/floorplan/waalbandijk.fml.json",
);

describe("Floorplanner FML import", () => {
  it("parses project export with nested designs", () => {
    const raw = JSON.parse(readFileSync(fmlPath, "utf8"));
    const ir = importFml(raw, "waalbandijk.fml.json", {
      assetsBase: "/local/floorplan/glb",
      openingAssets: true,
    });
    expect(ir.source.kind).toBe("floorplanner-fml");
    expect(ir.walls.length).toBe(52);
    // Areas + textured surfaces (e.g. kitchen vinyl).
    expect(ir.rooms.length).toBeGreaterThanOrEqual(12);
    expect(ir.furniture.length).toBeGreaterThan(50);
    expect(ir.openings.length).toBe(21);
    expect(ir.cameras.length).toBeGreaterThan(0);
    const withMesh = ir.furniture.filter((f) => f.meshUrl);
    expect(withMesh.length).toBeGreaterThan(50);
    expect(withMesh[0]?.meshUrl).toMatch(/\/local\/floorplan\/glb\/.+\.glb$/);
    const openMesh = ir.openings.filter((o) => o.meshUrl);
    expect(openMesh.length).toBe(21);
  });

  it("applies wall/floor materials when provided", () => {
    const raw = JSON.parse(readFileSync(fmlPath, "utf8"));
    const materials = JSON.parse(
      readFileSync(
        resolve(__dirname, "../dev/public/local/floorplan/waalbandijk.materials.json"),
        "utf8",
      ),
    );
    const ir = importFml(raw, "waalbandijk.fml.json", {
      assetsBase: "/local/floorplan/glb",
      openingAssets: true,
      materials,
    });
    const texturedWalls = ir.walls.filter((w) => w.leftTexture || w.rightTexture);
    expect(texturedWalls.length).toBeGreaterThan(10);
    expect(texturedWalls[0]?.leftTexture ?? texturedWalls[0]?.rightTexture).toMatch(
      /\/local\/floorplan\/textures\//,
    );
    const kitchen = ir.rooms.find((r) => r.floorTexture);
    expect(kitchen?.floorTexture).toMatch(/130533-texture/);
    expect(kitchen?.tileWidthCm).toBe(400);
    expect(ir.environment.wallSectionHeight).toBe(151);
  });

  it("applies default PVC floor except bath and toilet", () => {
    const raw = JSON.parse(readFileSync(fmlPath, "utf8"));
    const ir = importFml(raw, "waalbandijk.fml.json", {
      defaultFloor: {
        texture: "/local/floorplan/textures/pvc-laminaat.jpg",
        tileWidthCm: 100,
        tileHeightCm: 100,
      },
    });
    const toilet = ir.rooms.find((r) => /toilet/i.test(r.name ?? ""));
    const bath = ir.rooms.find((r) => /badkamer/i.test(r.name ?? ""));
    const living = ir.rooms.find((r) => /living/i.test(r.name ?? ""));
    const kitchen = ir.rooms.find((r) => /keuken/i.test(r.name ?? ""));
    expect(toilet?.floorTexture).toBeUndefined();
    expect(bath?.floorTexture).toBeUndefined();
    expect(living?.floorTexture).toMatch(/pvc-laminaat/);
    expect(kitchen?.floorTexture).toMatch(/pvc-laminaat/);
    expect(living?.tileWidthCm).toBe(100);
  });

  it("applies concrete tiles on balcony", () => {
    const raw = JSON.parse(readFileSync(fmlPath, "utf8"));
    const ir = importFml(raw, "waalbandijk.fml.json", {
      defaultFloor: {
        texture: "/local/floorplan/textures/pvc-laminaat.jpg",
        tileWidthCm: 100,
        tileHeightCm: 100,
        excludeNameIncludes: ["toilet", "badkamer", "bathroom", "bath", "balcony"],
      },
      roomFloors: [
        {
          nameIncludes: ["balcony"],
          texture: "/local/floorplan/textures/balcony-concrete.jpg",
          tileWidthCm: 100,
          tileHeightCm: 100,
        },
      ],
    });
    const balcony = ir.rooms.find((r) => /balcony/i.test(r.name ?? ""));
    const living = ir.rooms.find((r) => /living/i.test(r.name ?? ""));
    expect(balcony?.floorTexture).toMatch(/balcony-concrete/);
    expect(balcony?.tileWidthCm).toBe(100);
    expect(living?.floorTexture).toMatch(/pvc-laminaat/);
  });

  it("parses design-only documents", () => {
    const raw = JSON.parse(readFileSync(fmlPath, "utf8"));
    const design = raw.floors[0].designs[0];
    const ir = importFml(design, "design.fml");
    expect(ir.walls.length).toBe(52);
    expect(ir.furniture.length).toBeGreaterThan(50);
  });

  it("marks only hallway-living door as glazed among doors", () => {
    const raw = JSON.parse(readFileSync(fmlPath, "utf8"));
    const ir = importFml(raw, "waalbandijk.fml.json", {
      assetsBase: "/local/floorplan/glb",
      openingAssets: true,
    });
    const doors = ir.openings.filter((o) => o.kind === "door");
    const glazedDoors = doors.filter((o) => o.glazed);
    expect(glazedDoors.length).toBe(1);
    expect(glazedDoors[0]?.position.x).toBeCloseTo(614, 0);
    expect(ir.openings.filter((o) => o.kind === "window").every((o) => o.glazed)).toBe(true);
  });
});
