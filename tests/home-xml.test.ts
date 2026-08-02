import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHomeXml, lightSourceWorldPosition } from "../src/import/sweethome3d";

const xml = readFileSync(
  resolve(__dirname, "fixtures/sweethome3d/Home.xml"),
  "utf8",
);

describe("Home.xml parsing", () => {
  it("parses levels, rooms, walls, cameras, fixtures", () => {
    const ir = parseHomeXml(xml, "Home.xml");
    expect(ir.schemaVersion).toBe(1);
    expect(ir.source.kind).toBe("sweethome3d");
    expect(ir.levels).toHaveLength(1);
    expect(ir.levels[0]?.name).toBe("10th_floor");
    expect(ir.rooms).toHaveLength(1);
    expect(ir.walls).toHaveLength(2);
    expect(ir.openings).toHaveLength(1);
    expect(ir.cameras).toHaveLength(1);
    expect(ir.cameras[0]?.attribute).toBe("storedCamera");
    expect(ir.cameras[0]?.lens).toBe("PINHOLE");
    expect(ir.fixtures.length).toBeGreaterThanOrEqual(2);
    expect(ir.environment.photoWidth).toBe(720);
    expect(ir.environment.ambientColor).toBeTruthy();
  });

  it("places lightSource in world space from piece percentages", () => {
    const pos = lightSourceWorldPosition(
      { x: 100, y: 200, elevation: 0, width: 40, depth: 20, height: 80, angle: 0 },
      { x: 0.5, y: 0.5, z: 0.9 },
    );
    expect(pos.x).toBeCloseTo(100, 5);
    expect(pos.y).toBeCloseTo(200, 5);
    expect(pos.z).toBeCloseTo(72, 5);
  });

  it("assigns fixtures inside rooms when possible", () => {
    const ir = parseHomeXml(xml, "Home.xml");
    const dining = ir.fixtures.find((f) => f.name.includes("Dining"));
    expect(dining?.roomId).toBe("living");
  });
});
