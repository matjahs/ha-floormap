#!/usr/bin/env node
import fs from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { loadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF";
import { applyGltfSceneScale, listLoadedSceneMeshes } from "../src/renderer/live3d/babylon-gltf-scene.ts";

async function run(rhs: boolean) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = rhs;
  const data = new Uint8Array(fs.readFileSync("dev/public/local/floorplan/appartement.glb"));
  const container = await loadAssetContainerAsync(data, scene, { pluginExtension: ".glb" });
  container.addAllToScene();
  const loaded = {
    meshes: container.meshes,
    transformNodes: container.transformNodes,
    particleSystems: container.particleSystems,
    skeletons: container.skeletons,
    animationGroups: container.animationGroups,
    geometries: container.geometries,
    lights: container.lights,
    spriteManagers: container.spriteManagers,
  };
  const root = [...loaded.meshes, ...loaded.transformNodes].find((n) => n.name === "__root__");
  console.log(
    "RHS",
    rhs,
    "__root__",
    root
      ? {
          sx: root.scaling.x,
          sy: root.scaling.y,
          sz: root.scaling.z,
          rq: root.rotationQuaternion?.asArray(),
        }
      : null,
  );
  applyGltfSceneScale(scene, loaded);
  const avgX = (re: RegExp) => {
    const ms = listLoadedSceneMeshes(loaded.meshes).filter((m) => re.test(m.name));
    let s = 0;
    let n = 0;
    for (const m of ms) {
      m.computeWorldMatrix(true);
      const { min, max } = m.getHierarchyBoundingVectors(true);
      s += (min.x + max.x) / 2;
      n++;
    }
    return n ? s / n : null;
  };
  console.log("  livingX", avgX(/Floor Living/i)?.toFixed(0), "officeX", avgX(/Floor Home Office/i)?.toFixed(0));
}

await run(false);
await run(true);
