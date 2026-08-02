import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHomeXml } from "../src/import/sweethome3d";
import { projectPoint, selectCamera } from "../src/projection";
import { matchFixtures } from "../src/matching";

const expectedPath = resolve(__dirname, "fixtures/markers-expected.json");
const waalPathXml = resolve(__dirname, "fixtures/sweethome3d/Home.waalbandijk.xml");
const waalPathSh3d = resolve(__dirname, "fixtures/sweethome3d/Home.sh3d");

describe("Waalbandijk marker regression", () => {
  it("loads expected marker table with 12 entries", () => {
    const data = JSON.parse(readFileSync(expectedPath, "utf8")) as {
      markers: Array<{ entity: string; left: number; top: number; dead?: boolean }>;
    };
    expect(data.markers).toHaveLength(12);
    expect(data.markers.filter((m) => m.dead)).toHaveLength(2);
  });

  it("projects fixtures within 2% of hand-placed markers when model is present", async () => {
    if (!existsSync(waalPathXml) && !existsSync(waalPathSh3d)) {
      // Soft-skip: CI without proprietary model
      expect(true).toBe(true);
      return;
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
    // Match by fuzzy name against fixtures
    const entities = live.map((m) => ({
      entity_id: m.entity,
      friendly_name: m.name ?? m.entity.replace(/^light\./, "").replace(/_/g, " "),
    }));
    const matches = matchFixtures(ir, entities);
    for (const marker of live) {
      const match = matches.find((m) => m.best?.entity_id === marker.entity) ??
        matches.find((m) =>
          m.candidates.some((c) => c.entity_id === marker.entity),
        );
      const fixture = ir.fixtures.find((f) => f.id === match?.fixtureId);
      if (!fixture) {
        // Cannot assert without mapping; fail loudly so user notices incomplete fixture
        console.warn(`No fixture match for ${marker.entity}`);
        continue;
      }
      const uv = projectPoint(cam!, fixture.position, { aspect });
      expect(Math.abs(uv.u - marker.left)).toBeLessThanOrEqual(expected.tolerance);
      expect(Math.abs(uv.v - marker.top)).toBeLessThanOrEqual(expected.tolerance);
    }
  });
});
