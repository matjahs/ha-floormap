/**
 * Architecture floors/walls export as lit PBR; some meshes may be KHR unlit.
 * On WebGPU: strip heavy KHR extensions, keep opaque architecture lit so
 * clustered HA fixtures shade rooms. Glass must stay lit (not unlit) or panes
 * read as emissive at night — unlit albedo ignores sun/ambient.
 */
import {
  AbstractMesh,
  Color3,
  ImageProcessingConfiguration,
  MultiMaterial,
  PBRMaterial,
  StandardMaterial,
  WebGPUEngine,
  type Scene,
} from "@babylonjs/core";
import { GLTFLoader } from "@babylonjs/loaders/glTF/2.0/glTFLoader";

const WEBGPU_STRIPPED_GLTF_EXTENSIONS = [
  "KHR_materials_specular",
  "KHR_materials_ior",
  "KHR_materials_transmission",
  "KHR_materials_volume",
  "KHR_materials_sheen",
  "KHR_materials_clearcoat",
  "KHR_materials_anisotropy",
  "KHR_materials_emissive_strength",
  "KHR_materials_iridescence",
] as const;

/** RAL 9010 — matches Blender export and Three live3d. */
const RAL_9010 = new Color3(242 / 255, 239 / 255, 231 / 255);

const GLASS_MAT_RE = /flltgrey|kozijnglas|glasstransparent|windowpane|door_glass|glasssmoked|^glass(?:\.|$)/i;

export function setupBabylonGltfLighting(
  scene: Scene,
  opts: { toneMap?: "aces" | "reinhard" | "none"; exposure?: number } = {},
): void {
  const toneMap = opts.toneMap ?? "aces";
  const exposure = opts.exposure ?? 1;
  const ipc = scene.imageProcessingConfiguration;
  if (toneMap === "none") {
    ipc.isEnabled = false;
    ipc.toneMappingEnabled = false;
  } else {
    ipc.isEnabled = true;
    ipc.toneMappingEnabled = true;
    ipc.toneMappingType =
      toneMap === "reinhard"
        ? ImageProcessingConfiguration.TONEMAPPING_STANDARD
        : ImageProcessingConfiguration.TONEMAPPING_ACES;
    ipc.exposure = Number.isFinite(exposure) ? Math.max(0.05, exposure) : 1;
  }
  scene.createDefaultEnvironment({
    createSkybox: false,
    createGround: false,
    enableGroundShadow: false,
    setupImageProcessing: false,
  });
  scene.environmentIntensity = 0.06;
}

function isGlassLabel(materialName: string, meshName = ""): boolean {
  const mat = materialName.toLowerCase();
  if (GLASS_MAT_RE.test(mat)) {
    return true;
  }
  const mesh = meshName.toLowerCase();
  if (mesh.includes("glasscherm")) {
    return false;
  }
  return /windowpane|door_glass/.test(mesh);
}

function isWallLabel(label: string): boolean {
  return /^wall[_\s-]/i.test(label) || label.includes("wallwhite") || label.includes("wallexterior");
}

/** Drop KHR extensions that inflate PBR uniform-buffer count before glTF load on WebGPU. */
export function prepareBabylonGltfLoaderForWebGpu(): void {
  for (const name of WEBGPU_STRIPPED_GLTF_EXTENSIONS) {
    GLTFLoader.UnregisterExtension(name);
  }
}

function tuneUnlitMaterial(pbr: PBRMaterial, meshName: string): void {
  const isFloor = /^floor[_\s]/i.test(meshName) || /^floor_/i.test(pbr.name);
  const isWall = isWallLabel(`${pbr.name} ${meshName}`.toLowerCase());
  if (!pbr.unlit) {
    pbr.unlit = true;
  }
  pbr.maxSimultaneousLights = 0;
  pbr.environmentIntensity = 0;
  pbr.emissiveColor = Color3.Black();
  pbr.emissiveIntensity = 0;
  pbr.backFaceCulling = isFloor || isWall ? false : pbr.backFaceCulling;
  if (pbr.albedoTexture) {
    pbr.albedoTexture.gammaSpace = true;
  }
  if (pbr.name === "WallWhite" || (isWall && !pbr.albedoTexture)) {
    pbr.albedoColor = RAL_9010.clone();
  }
  if (pbr.alpha < 0.999) {
    pbr.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  }
}

function stripHeavyPbrFeatures(pbr: PBRMaterial): void {
  pbr.bumpTexture = null;
  pbr.metallicTexture = null;
  pbr.ambientTexture = null;
  pbr.lightmapTexture = null;
  pbr.reflectionTexture = null;
  pbr.emissiveTexture = null;
  pbr.emissiveColor = Color3.Black();
  pbr.emissiveIntensity = 0;
  if (pbr.sheen) {
    pbr.sheen.isEnabled = false;
  }
  if (pbr.clearCoat) {
    pbr.clearCoat.isEnabled = false;
  }
  pbr.subSurface.isRefractionEnabled = false;
  pbr.subSurface.isTranslucencyEnabled = false;
}

function tuneLitMaterial(pbr: PBRMaterial, meshName: string): void {
  stripHeavyPbrFeatures(pbr);
  pbr.unlit = false;
  pbr.maxSimultaneousLights = 8;
  pbr.environmentIntensity = 0.06;
  // Direct must dominate over residual IBL so window/wall patches read on vertical faces.
  pbr.directIntensity = 1.28;
  pbr.specularIntensity = 0.12;
  pbr.metallic = Math.min(pbr.metallic ?? 0, 0.06);
  pbr.roughness = Math.max(pbr.roughness ?? 1, 0.58);
  const glass = isGlassLabel(pbr.name, meshName);
  const isFloor = /^floor[_\s]/i.test(meshName) || /^floor_/i.test(pbr.name);
  const isWall = isWallLabel(`${pbr.name} ${meshName}`.toLowerCase());
  pbr.backFaceCulling = isFloor || glass || isWall ? false : pbr.backFaceCulling;
  if (pbr.albedoTexture) {
    pbr.albedoTexture.gammaSpace = true;
  }
  if (pbr.name === "WallWhite" || (isWall && !pbr.albedoTexture && pbr.name !== "WallTopBlack")) {
    pbr.albedoColor = RAL_9010.clone();
  }
  if (glass) {
    pbr.alpha = 0.35;
    pbr.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    pbr.metallic = 0;
    pbr.roughness = 0.22;
    pbr.specularIntensity = 0.35;
    pbr.indexOfRefraction = 1.45;
    // Cool tint, but keep albedo dim enough that night ambient does not read as emission.
    pbr.albedoColor = Color3.Lerp(pbr.albedoColor, new Color3(0.55, 0.62, 0.7), 0.45);
    pbr.environmentIntensity = 0.02;
  } else {
    pbr.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
    pbr.opacityTexture = null;
  }
}

function simplifyPbrForWebGpu(pbr: PBRMaterial, meshName: string): void {
  // Glass must be lit — unlit panes keep full albedo when the sun is down.
  if (isGlassLabel(pbr.name, meshName)) {
    tuneLitMaterial(pbr, meshName);
    return;
  }
  if (pbr.unlit) {
    stripHeavyPbrFeatures(pbr);
    pbr.opacityTexture = null;
    pbr.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
    pbr.environmentIntensity = 0;
    pbr.specularIntensity = 0;
    pbr.metallic = 0;
    pbr.roughness = 1;
    pbr.maxSimultaneousLights = 0;
    tuneUnlitMaterial(pbr, meshName);
    return;
  }
  tuneLitMaterial(pbr, meshName);
}

function processMeshMaterials(mesh: AbstractMesh, webGpu: boolean): number {
  const mat = mesh.material;
  if (!mat) {
    return 0;
  }
  let count = 0;
  const handle = (sub: PBRMaterial): void => {
    if (webGpu) {
      simplifyPbrForWebGpu(sub, mesh.name);
    } else if (isGlassLabel(sub.name, mesh.name)) {
      // Export may mark panes KHR_unlit; still light them so night dims the glass.
      tuneLitMaterial(sub, mesh.name);
    } else if (sub.unlit) {
      tuneUnlitMaterial(sub, mesh.name);
    } else {
      tuneLitMaterial(sub, mesh.name);
    }
    count++;
  };
  if (mat instanceof MultiMaterial) {
    for (const sub of mat.subMaterials) {
      if (sub instanceof PBRMaterial) {
        handle(sub);
      }
    }
    return count;
  }
  if (mat instanceof PBRMaterial) {
    handle(mat);
    return 1;
  }
  return 0;
}

/** Tune materials for WebGPU: keep lit architecture; unlit only for export-unlit non-glass. */
export function simplifyBabylonGltfMaterialsForWebGpu(scene: Scene): number {
  const engine = scene.getEngine();
  if (!(engine instanceof WebGPUEngine)) {
    return 0;
  }
  let count = 0;
  for (const mesh of scene.meshes) {
    count += processMeshMaterials(mesh, true);
  }
  return count;
}

export function tuneBabylonGltfMaterials(scene: Scene): void {
  for (const mesh of scene.meshes) {
    processMeshMaterials(mesh, false);
  }
  for (const mat of scene.materials) {
    if (!(mat instanceof PBRMaterial)) {
      continue;
    }
    if (mat.unlit) {
      continue;
    }
    mat.maxSimultaneousLights = 8;
    mat.environmentIntensity = Math.min(mat.environmentIntensity ?? 0.06, 0.08);
    mat.directIntensity = Math.min(Math.max(mat.directIntensity ?? 1, 1.15), 1.32);
    mat.specularIntensity = Math.min(mat.specularIntensity ?? 0.12, 0.14);
    mat.metallic = Math.min(mat.metallic ?? 0, 0.06);
    mat.roughness = Math.max(mat.roughness ?? 1, 0.52);
    const isGlass = isGlassLabel(mat.name);
    if (!isGlass) {
      mat.subSurface.isRefractionEnabled = false;
      mat.subSurface.isTranslucencyEnabled = false;
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
      if (mat.sheen) {
        mat.sheen.isEnabled = false;
      }
    }
    if (isGlass) {
      mat.alpha = 0.35;
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      mat.metallic = 0;
      mat.roughness = Math.max(mat.roughness ?? 0.22, 0.18);
      mat.indexOfRefraction = 1.45;
      mat.environmentIntensity = Math.min(mat.environmentIntensity ?? 0.02, 0.03);
      mat.emissiveColor = Color3.Black();
      mat.emissiveIntensity = 0;
    }
  }
}

export function prepareBabylonGltfMaterials(scene: Scene, webGpu: boolean): void {
  if (webGpu) {
    simplifyBabylonGltfMaterialsForWebGpu(scene);
    return;
  }
  tuneBabylonGltfMaterials(scene);
}

/**
 * True when WebGPU should keep a material shadeless.
 * Glass is excluded — it must receive lights so night ambient dims the panes.
 */
export function shouldKeepUnlitOnWebGpu(materialName: string, meshName = "", alreadyUnlit = false): boolean {
  if (isGlassLabel(materialName, meshName)) {
    return false;
  }
  return alreadyUnlit;
}

export function isBabylonGlassMaterial(meshName: string, material: unknown): boolean {
  if (material instanceof PBRMaterial || material instanceof StandardMaterial) {
    return isGlassLabel(material.name, meshName);
  }
  return isGlassLabel("", meshName);
}
