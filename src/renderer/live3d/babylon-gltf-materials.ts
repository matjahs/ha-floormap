/**
 * glTF from Blender is PBR. Babylon needs IBL (environment texture) or materials stay black.
 * Three live3d collapses to Lambert; here we tune PBR + optional glass handling.
 */
import type { Scene } from "@babylonjs/core";
import { PBRMaterial, StandardMaterial } from "@babylonjs/core";

const GLASS_RE = /glass|glasstransparent|windowpane|door_glass/i;

export function setupBabylonGltfLighting(scene: Scene): void {
  scene.createDefaultEnvironment({
    createSkybox: false,
    enableGroundShadow: false,
    cameraExposure: 1.05,
  });
  scene.environmentIntensity = 0.72;
}

export function tuneBabylonGltfMaterials(scene: Scene): void {
  for (const mat of scene.materials) {
    if (!(mat instanceof PBRMaterial)) {
      continue;
    }
    mat.environmentIntensity = 0.85;
    mat.directIntensity = 1.1;
    mat.specularIntensity = 0.35;
    const label = `${mat.name}`.toLowerCase();
    if (GLASS_RE.test(label)) {
      mat.alpha = 0.35;
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      mat.metallic = 0;
      mat.roughness = 0.08;
      mat.indexOfRefraction = 1.45;
    }
  }
}

export function isBabylonGlassMaterial(meshName: string, material: unknown): boolean {
  if (material instanceof PBRMaterial || material instanceof StandardMaterial) {
    return GLASS_RE.test(`${material.name} ${meshName}`);
  }
  return GLASS_RE.test(meshName);
}
