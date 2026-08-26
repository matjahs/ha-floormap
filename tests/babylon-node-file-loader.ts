/** Load local GLB in Node/vitest without XMLHttpRequest (ArrayBuffer path). */
import fs from "node:fs";
import type { Scene } from "@babylonjs/core/scene";
import { loadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { ISceneLoaderAsyncResult } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF";

export async function loadGlbFile(scene: Scene, glbPath: string): Promise<ISceneLoaderAsyncResult> {
  scene.useRightHandedSystem = true;
  const data = new Uint8Array(fs.readFileSync(glbPath));
  const container = await loadAssetContainerAsync(data, scene, { pluginExtension: ".glb" });
  container.addAllToScene();
  return {
    meshes: container.meshes,
    particleSystems: container.particleSystems,
    skeletons: container.skeletons,
    animationGroups: container.animationGroups,
    transformNodes: container.transformNodes,
    geometries: container.geometries,
    lights: container.lights,
    spriteManagers: container.spriteManagers,
  };
}
