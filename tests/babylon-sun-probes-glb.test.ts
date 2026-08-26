/**
 * Headless GLB load — validates sun probes at dawn / noon / sunset.
 * Requires dev/public/local/floorplan/appartement.glb (playground:sync).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { importBlenderScene } from "../src/import/blender";
import { eastWestPlanHintFromRooms } from "../src/sun-probe-envelope";
import { approximateSun, shadeSun, waalbandijkFloorSunContext } from "../src/sun";
import { applyGltfSceneScale, listLoadedSceneMeshes } from "../src/renderer/live3d/babylon-gltf-scene";
import { collectExteriorWallSamples, readSunProbes } from "../src/renderer/live3d/babylon-sun-probes";
import { loadGlbFile } from "./babylon-node-file-loader";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dev/public/local/floorplan");
const GLB = path.join(ROOT, "appartement.glb");
const SCENE_JSON = path.join(ROOT, "appartement.scene.json");
const NORTH = 180;
const HAS_GLB = fs.existsSync(GLB);

function facadeProbes(
  readings: ReturnType<typeof readSunProbes>,
  axis: "east" | "west",
  side: "exterior" | "interior" = "exterior",
) {
  const minNormal = axis === "east" ? 0.85 : -0.85;
  const ok =
    axis === "east"
      ? (n: number) => n > minNormal
      : (n: number) => n < minNormal;
  return readings.filter((r) => r.side === side && ok(r.normal.x));
}

function majority(
  probes: ReturnType<typeof readSunProbes>,
  pred: (p: (typeof probes)[0]) => boolean,
): boolean {
  if (probes.length === 0) {
    return false;
  }
  const hit = probes.filter(pred).length;
  return hit / probes.length >= 0.5;
}

async function loadProbeScene() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const loaded = await loadGlbFile(scene, GLB);
  applyGltfSceneScale(scene, loaded);
  const meshes = listLoadedSceneMeshes(loaded.meshes);
  const ir = importBlenderScene(JSON.parse(fs.readFileSync(SCENE_JSON, "utf8")));
  const geoHint = eastWestPlanHintFromRooms(ir.rooms);
  const samples = collectExteriorWallSamples(meshes, geoHint);
  return { scene, samples, geoHint, engine, meshes };
}

function shadedAt(iso: string) {
  const pose = approximateSun(new Date(iso));
  return shadeSun({
    ...pose,
    north: NORTH,
    mirrorX: true,
    floor: waalbandijkFloorSunContext(10),
  });
}

describe.skipIf(!HAS_GLB)("babylon sun probes on appartement.glb", () => {
  it("keeps Blender X: office east > living west under RHS", async () => {
    const { meshes } = await loadProbeScene();
    const avgX = (re: RegExp) => {
      const hits = meshes.filter((m) => re.test(m.name));
      expect(hits.length).toBeGreaterThan(0);
      let sum = 0;
      for (const m of hits) {
        m.computeWorldMatrix(true);
        const { min, max } = m.getHierarchyBoundingVectors(true);
        sum += (min.x + max.x) / 2;
      }
      return sum / hits.length;
    };
    expect(avgX(/Floor Home Office/i)).toBeGreaterThan(avgX(/Floor Living/i));
  }, 120_000);

  it("dawn: east buitenblad lit, west buitenblad not", async () => {
    const { scene, samples } = await loadProbeScene();
    expect(samples.length).toBeGreaterThan(10);
    const sh = shadedAt("2026-08-24T07:00:00+02:00");
    const readings = readSunProbes(scene, samples, sh.direction, sh.sunIntensity > 0.04);
    const east = facadeProbes(readings, "east");
    const west = facadeProbes(readings, "west");
    expect(east.length).toBeGreaterThan(0);
    expect(west.length).toBeGreaterThan(0);
    expect(majority(east, (p) => p.receivesSun)).toBe(true);
    expect(majority(east, (p) => p.ndotL > 0.5)).toBe(true);
    expect(majority(west, (p) => !p.receivesSun)).toBe(true);
    expect(majority(west, (p) => p.ndotL < -0.5)).toBe(true);
  }, 120_000);

  it("sunset: west buitenblad lit, east buitenblad not", async () => {
    const { scene, samples } = await loadProbeScene();
    const sh = shadedAt("2026-08-24T20:00:00+02:00");
    const readings = readSunProbes(scene, samples, sh.direction, sh.sunIntensity > 0.04);
    const east = facadeProbes(readings, "east");
    const west = facadeProbes(readings, "west");
    expect(majority(west, (p) => p.receivesSun)).toBe(true);
    expect(majority(east, (p) => !p.receivesSun)).toBe(true);
  }, 120_000);
});
