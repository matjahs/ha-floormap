import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { FreeCamera, MultiMaterial, PBRMaterial, Scene, Vector3 } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import {
  applyGltfSceneScale,
  GLTF_SCENE_SCALE,
  listLoadedSceneMeshes,
  listSunShadowCasterMeshes,
} from "../src/renderer/live3d/babylon-gltf-scene";
import { isBabylonCeiling } from "../src/renderer/live3d/babylon-ceilings";
import {
  isBabylonGlassMaterial,
  prepareBabylonGltfMaterials,
} from "../src/renderer/live3d/babylon-gltf-materials";
import { loadGlbFile } from "./babylon-node-file-loader";

describe("babylon gltf scene scale", () => {
  it("uses cm scale factor for Blender meter exports", () => {
    expect(GLTF_SCENE_SCALE).toBe(100);
  });

  it("scales __root__ exactly once (m → cm), not 10000×", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.activeCamera = new FreeCamera("c", new Vector3(0, 0, 0), scene);
    const loaded = await loadGlbFile(scene, "dev/public/local/floorplan/appartement.glb");
    const root = applyGltfSceneScale(scene, loaded);
    expect(root.scaling.x).toBeCloseTo(GLTF_SCENE_SCALE, 5);
    expect(root.scaling.y).toBeCloseTo(GLTF_SCENE_SCALE, 5);
    expect(root.scaling.z).toBeCloseTo(GLTF_SCENE_SCALE, 5);

    const floor = loaded.meshes.find((m) => /Floor Living/i.test(m.name));
    expect(floor).toBeTruthy();
    floor!.computeWorldMatrix(true);
    const box = floor!.getBoundingInfo().boundingBox;
    const widthCm = box.maximumWorld.x - box.minimumWorld.x;
    // Living floor is ~7.7 m → ~770 cm after a single ×100.
    expect(widthCm).toBeGreaterThan(700);
    expect(widthCm).toBeLessThan(900);
    engine.dispose();
  });

  it("excludes __root__ and glass from sun shadow casters", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.activeCamera = new FreeCamera("c", new Vector3(0, 0, 0), scene);
    const loaded = await loadGlbFile(scene, "dev/public/local/floorplan/appartement.glb");
    applyGltfSceneScale(scene, loaded);

    const meshIsGlassOnly = (mesh: (typeof loaded.meshes)[number]): boolean => {
      const mat = mesh.material;
      if (!mat) {
        return isBabylonGlassMaterial(mesh.name, null);
      }
      if (mat instanceof MultiMaterial) {
        const subs = mat.subMaterials.filter((m): m is NonNullable<typeof m> => m != null);
        return subs.length > 0 && subs.every((m) => isBabylonGlassMaterial(mesh.name, m));
      }
      return isBabylonGlassMaterial(mesh.name, mat);
    };

    const sceneMeshes = listLoadedSceneMeshes(loaded.meshes);
    expect(sceneMeshes.some((m) => m.name === "__root__")).toBe(false);

    const casters = listSunShadowCasterMeshes(loaded.meshes, {
      isGlass: meshIsGlassOnly,
      isCeiling: isBabylonCeiling,
    });
    expect(casters.some((m) => m.name === "__root__")).toBe(false);
    const glassInCasters = casters.filter(meshIsGlassOnly);
    expect(glassInCasters).toEqual([]);
    // appartement.glb has window panes that must not cast.
    const glassInScene = sceneMeshes.filter(meshIsGlassOnly);
    expect(glassInScene.length).toBeGreaterThanOrEqual(10);
    engine.dispose();
  });

  it("keeps glass lit so night ambient can dim panes (not unlit emission)", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.activeCamera = new FreeCamera("c", new Vector3(0, 0, 0), scene);
    const loaded = await loadGlbFile(scene, "dev/public/local/floorplan/appartement.glb");
    applyGltfSceneScale(scene, loaded);
    prepareBabylonGltfMaterials(scene, false);

    const glassMats: PBRMaterial[] = [];
    for (const mesh of loaded.meshes) {
      const mat = mesh.material;
      if (mat instanceof PBRMaterial && isBabylonGlassMaterial(mesh.name, mat)) {
        glassMats.push(mat);
      }
    }
    expect(glassMats.length).toBeGreaterThanOrEqual(1);
    for (const mat of glassMats) {
      expect(mat.unlit).toBe(false);
      expect(mat.emissiveIntensity ?? 0).toBe(0);
      expect(mat.alpha).toBeLessThan(1);
    }
    engine.dispose();
  });
});
