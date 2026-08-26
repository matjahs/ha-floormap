/**
 * Invisible ceiling casters for Babylon dollhouse sun occlusion.
 *
 * Roland pattern (playground): hide the visible mesh, leave a separate clone
 * that casts shadows with `material.disableColorWrite = true` (depth write stays
 * on so ShadowGenerator still sees the slab).
 *
 * layerMask keeps the shadow clone out of the dollhouse camera (open-roof view).
 * Shadow RTTs with an explicit renderList do not filter that layerMask.
 */
import {
  AbstractMesh,
  Color3,
  Material,
  StandardMaterial,
  type Camera,
  type Scene,
} from "@babylonjs/core";
import { CEILING_NAME_RE } from "./ceilings";

/** Bit excluded from the default camera layerMask (0x0fffffff). */
export const LIVE3D_CEILING_LAYER = 0x10000000;

const DO_NOT_RENDER_MAT = "do-not-render";
const SHADOW_CASTER_SUFFIX = "_shadowCaster";

export function isBabylonCeiling(node: { name: string; parent: unknown }): boolean {
  let cur: { name: string; parent: unknown } | null = node;
  while (cur) {
    if (CEILING_NAME_RE.test(cur.name)) {
      return true;
    }
    cur = cur.parent as { name: string; parent: unknown } | null;
  }
  return false;
}

/** True for the invisible clone produced by {@link prepareShadowOnlyCeiling}. */
export function isCeilingShadowCaster(mesh: { name: string }): boolean {
  return mesh.name.endsWith(SHADOW_CASTER_SUFFIX);
}

/** Material flags for the invisible shadow-caster clone. */
export function shadowOnlyCeilingMaterialFlags(): {
  alpha: number;
  disableColorWrite: boolean;
  disableDepthWrite: boolean;
  backFaceCulling: boolean;
  transparencyMode: number;
} {
  return {
    alpha: 1,
    disableColorWrite: true,
    // Keep depth write — ShadowGenerator needs the slab in the depth buffer.
    disableDepthWrite: false,
    backFaceCulling: false,
    transparencyMode: Material.MATERIAL_OPAQUE,
  };
}

/** Exclude ceiling layer from a dollhouse / orbit camera. */
export function applyCeilingLayerMaskToCamera(camera: Camera): void {
  camera.layerMask = camera.layerMask & ~LIVE3D_CEILING_LAYER;
}

/**
 * Hide the visible ceiling and return a Roland-style shadow-only clone.
 * Caller must `removeShadowCaster(visible)` and `addShadowCaster(clone)`.
 * Applies invisible material + ceiling layerMask to the clone root and all
 * descendant meshes (glTF multi-material `_primitive*` children).
 */
export function prepareShadowOnlyCeiling(mesh: AbstractMesh, scene?: Scene): AbstractMesh {
  const scn = scene ?? mesh.getScene();
  const flags = shadowOnlyCeilingMaterialFlags();

  const shadowMesh = mesh.clone(`${mesh.name}${SHADOW_CASTER_SUFFIX}`, mesh.parent);
  if (!shadowMesh) {
    throw new Error(`Babylon: failed to clone ceiling shadow caster for ${mesh.name}`);
  }

  const mat = new StandardMaterial(`${DO_NOT_RENDER_MAT}_${mesh.uniqueId}`, scn);
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = Color3.Black();
  mat.alpha = flags.alpha;
  mat.disableColorWrite = flags.disableColorWrite;
  mat.disableDepthWrite = flags.disableDepthWrite;
  mat.backFaceCulling = flags.backFaceCulling;
  mat.transparencyMode = flags.transparencyMode;

  const applyShadowOnly = (node: AbstractMesh): void => {
    node.material = mat;
    node.isPickable = false;
    node.receiveShadows = false;
    node.layerMask = LIVE3D_CEILING_LAYER;
  };
  applyShadowOnly(shadowMesh);
  for (const child of shadowMesh.getChildMeshes()) {
    applyShadowOnly(child);
  }

  // Visible slab off — shadow clone keeps casting (Roland click-tree pattern).
  mesh.setEnabled(false);
  mesh.receiveShadows = false;

  return shadowMesh;
}
