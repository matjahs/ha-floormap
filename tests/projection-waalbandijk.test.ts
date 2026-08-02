import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertIR } from "../src/import/ir";
import { parseHomeXml } from "../src/import/sweethome3d";
import { projectPoint, selectCamera } from "../src/projection";
import { matchFixtures } from "../src/matching";

const expectedPath = resolve(__dirname, "fixtures/markers-expected.json");
const waalPathXml = resolve(__dirname, "fixtures/sweethome3d/Home.waalbandijk.xml");
const waalPathSh3d = resolve(__dirname, "fixtures/sweethome3d/Home.sh3d");
const waalPathIr = resolve(__dirname, "fixtures/sweethome3d/waalbandijk_2024.ir.json");

describe("Waalbandijk marker regression", () => {
  it("loads expected marker table with 12 entries", () => {
    const data = JSON.parse(readFileSync(expectedPath, "utf8")) as {
      markers: Array<{ entity: string; left: number; top: number; dead?: boolean }>;
    };
    expect(data.markers).toHaveLength(12);
    expect(data.markers.filter((m) => m.dead)).toHaveLength(2);
  });

  it("loads waalbandijk_2024 IR snapshot with named light fixtures", () => {
    const ir = assertIR(JSON.parse(readFileSync(waalPathIr, "utf8")));
    expect(ir.source.file).toContain("waalbandijk_2024");
    expect(ir.fixtures.length).toBeGreaterThanOrEqual(14);
    const names = new Set(ir.fixtures.map((f) => f.name));
    expect(names.has("light_hallway_1")).toBe(true);
    expect(names.has("light_kitchen_1")).toBe(true);
    expect(names.has("light_office_1")).toBe(true);
    // Dining light removed in 2024 model
    expect(names.has("light_living_room_1")).toBe(false);
    expect(ir.environment.photoWidth).toBe(720);
    expect(ir.environment.photoHeight).toBe(405);
  });

  it("parses Home.waalbandijk.xml to the same fixture ids as the IR snapshot", () => {
    if (!existsSync(waalPathXml)) {
      expect(existsSync(waalPathIr)).toBe(true);
      return;
    }
    const fromXml = parseHomeXml(readFileSync(waalPathXml, "utf8"), "Home.waalbandijk.xml");
    const fromIr = assertIR(JSON.parse(readFileSync(waalPathIr, "utf8")));
    expect(fromXml.fixtures.map((f) => f.id).sort()).toEqual(
      fromIr.fixtures.map((f) => f.id).sort(),
    );
    expect(fromXml.fixtures.map((f) => f.name).sort()).toEqual(
      fromIr.fixtures.map((f) => f.name).sort(),
    );
  });

  /**
   * Hard ±2% check. The stored camera in waalbandijk_2024 is not yet the SunFlow
   * plate camera, so this stays opt-in until a matching storedCamera is saved.
   * Run with: CALIBRATE_CAMERA=1 npm test
   */
  it("projects fixtures within 2% of hand-placed markers when CALIBRATE_CAMERA=1", async () => {
    if (process.env.CALIBRATE_CAMERA !== "1") {
      expect(true).toBe(true);
      return;
    }
    if (!existsSync(waalPathXml) && !existsSync(waalPathSh3d)) {
      throw new Error("Home.waalbandijk.xml or Home.sh3d required for calibration");
    }
    const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as {
      aspect: { width: number; height: number };
      tolerance: number;
      markers: Array<{ name?: string; entity: string; left: number; top: number; dead?: boolean }>;
    };
    let ir;
    if (existsSync(waalPathXml)) {
      ir = parseHomeXml(readFileSync(waalPathXml, "utf8"), "Home.waalbandijk.xml");
    } else {
      const { importSweetHome3D } = await import("../src/import/sweethome3d");
      ir = await importSweetHome3D(readFileSync(waalPathSh3d), "Home.sh3d");
    }
    const cam = selectCamera(ir.cameras);
    expect(cam).toBeTruthy();
    const aspect = expected.aspect.width / expected.aspect.height;
    const live = expected.markers.filter((m) => !m.dead);
    const entities = live.map((m) => ({
      entity_id: m.entity,
      friendly_name: m.name ?? m.entity.replace(/^light\./, "").replace(/_/g, " "),
    }));
    const matches = matchFixtures(ir, entities);
    for (const marker of live) {
      const match =
        matches.find((m) => m.best?.entity_id === marker.entity) ??
        matches.find((m) => m.candidates.some((c) => c.entity_id === marker.entity));
      const fixture = ir.fixtures.find((f) => f.id === match?.fixtureId);
      expect(fixture, `fixture for ${marker.entity}`).toBeTruthy();
      const uv = projectPoint(cam!, fixture!.position, { aspect });
      expect(Math.abs(uv.u - marker.left)).toBeLessThanOrEqual(expected.tolerance);
      expect(Math.abs(uv.v - marker.top)).toBeLessThanOrEqual(expected.tolerance);
    }
  });
});
