#!/usr/bin/env node
/** Quick sun-probe report for appartement.glb at dawn/noon/sunset. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { importBlenderScene } from "../src/import/blender.js";
import { eastWestPlanHintFromRooms } from "../src/sun-probe-envelope.js";
import { approximateSun, shadeSun, waalbandijkFloorSunContext } from "../src/sun.js";
import { applyGltfSceneScale, listLoadedSceneMeshes } from "../src/renderer/live3d/babylon-gltf-scene.js";
import { collectExteriorWallSamples, readSunProbes } from "../src/renderer/live3d/babylon-sun-probes.js";
import { loadGlbFile } from "../tests/babylon-node-file-loader.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dev/public/local/floorplan");
const NORTH = 180;

const TIMES = [
  ["Dawn 07:00", "2026-08-24T07:00:00+02:00"],
  ["Noon 13:00", "2026-08-24T13:00:00+02:00"],
  ["Sunset 20:00", "2026-08-24T20:00:00+02:00"],
] as const;

function groupSummary(
  readings: ReturnType<typeof readSunProbes>,
  needle: string,
  side: "exterior" | "interior" = "exterior",
) {
  const rows = readings.filter(
    (r) => r.side === side && r.wallName.toLowerCase().includes(needle.toLowerCase()),
  );
  const lit = rows.filter((r) => r.receivesSun).length;
  const avgN = rows.length
    ? rows.reduce((s, r) => s + r.ndotL, 0) / rows.length
    : 0;
  return { count: rows.length, lit, avgN };
}

async function main() {
  const glb = path.join(ROOT, "appartement.glb");
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const loaded = await loadGlbFile(scene, glb);
  applyGltfSceneScale(scene, loaded);
  const meshes = listLoadedSceneMeshes(loaded.meshes);
  const ir = importBlenderScene(JSON.parse(fs.readFileSync(path.join(ROOT, "appartement.scene.json"), "utf8")));
  const geoHint = eastWestPlanHintFromRooms(ir.rooms);
  const samples = collectExteriorWallSamples(meshes, geoHint);
  console.log(`Probes: ${samples.length} (exterior ${samples.filter((s) => s.side === "exterior").length})`);
  if (geoHint) {
    console.log(`Geo hint: westX=${geoHint.westX.toFixed(0)} eastX=${geoHint.eastX.toFixed(0)}\n`);
  } else {
    console.log("Geo hint: (none)\n");
  }

  for (const [label, iso] of TIMES) {
    const pose = approximateSun(new Date(iso));
    const sh = shadeSun({ ...pose, north: NORTH, floor: waalbandijkFloorSunContext(10) });
    const readings = readSunProbes(scene, samples, sh.direction, sh.sunIntensity > 0.04);
    const ext = readings.filter((r) => r.side === "exterior");
    const extLit = ext.filter((r) => r.receivesSun);
    console.log(`=== ${label} elev=${pose.elevation.toFixed(1)}° dir=(${sh.direction.x.toFixed(2)},${sh.direction.y.toFixed(2)},${sh.direction.z.toFixed(2)}) ===`);
    console.log(`lit ${readings.filter((r) => r.receivesSun).length}/${readings.length} (buitenblad ${extLit.length}/${ext.length})`);
    for (const name of ["Office", "Bedroom", "Living", "Balcony"]) {
      const g = groupSummary(readings, name);
      if (g.count > 0) {
        console.log(`  ${name}: ${g.lit}/${g.count} lit  avg n·L=${g.avgN.toFixed(2)}`);
      }
    }
    const bad = ext.filter((r) => r.occluded && r.facingSun);
    if (bad.length) {
      console.log(`  WARN exterior occ while facing: ${bad.map((b) => b.wallName).join(", ")}`);
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
