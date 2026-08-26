import { Scene, TransformNode, type AbstractMesh, type Node } from "@babylonjs/core";
import type { ISceneLoaderAsyncResult } from "@babylonjs/core/Loading/sceneLoader";

/** Blender export is meters; live3d plan space is cm. Scale the whole glTF root, not each mesh. */
export const GLTF_SCENE_SCALE = 100;

/**
 * Scale Blender meters → live3d cm.
 *
 * We use Method 1: `scene.useRightHandedSystem = true` before load, so `__root__`
 * stays identity (no sz=-1 / rotY 180). Scale `__root__` if present; otherwise
 * parent scene-root nodes under one pivot. Never detach children from `__root__`
 * under left-handed AUTO — that drops the Z-flip and mirrors the building.
 *
 * Scale exactly once. A prior bug called setAll(100) and then *= 100 → 10000×,
 * which made the shadow ortho frustum (~IR cm) miss the mesh and left sealed
 * rooms fully sunlit.
 */
export function applyGltfSceneScale(
  scene: Scene,
  loaded: ISceneLoaderAsyncResult,
  scale = GLTF_SCENE_SCALE,
): TransformNode {
  const existingRoot =
    loaded.meshes.find((m) => m.name === "__root__") ??
    loaded.transformNodes.find((n) => n.name === "__root__");

  if (existingRoot) {
    existingRoot.scaling.x *= scale;
    existingRoot.scaling.y *= scale;
    existingRoot.scaling.z *= scale;
    existingRoot.computeWorldMatrix(true);
    return existingRoot;
  }

  const gltfRoot = new TransformNode("live3dGltfRoot", scene);
  const reparented = new Set<Node>();

  const tryReparent = (node: Node | null | undefined): void => {
    if (!node || reparented.has(node) || node === gltfRoot) {
      return;
    }
    const parent = node.parent;
    if (parent && parent.getClassName() !== "Scene") {
      return;
    }
    node.parent = gltfRoot;
    reparented.add(node);
  };

  for (const node of loaded.transformNodes) {
    tryReparent(node);
  }
  for (const mesh of loaded.meshes) {
    tryReparent(mesh);
  }

  gltfRoot.scaling.setAll(scale);
  gltfRoot.computeWorldMatrix(true);
  return gltfRoot;
}

export function listLoadedSceneMeshes(meshes: AbstractMesh[]): AbstractMesh[] {
  // `__root__` is the glTF transform container — not a drawable caster / bound mesh.
  return meshes.filter((mesh) => mesh.name !== "skyBox" && mesh.name !== "__root__");
}

/**
 * Meshes that may cast the directional sun shadow.
 * Never include `__root__`: `ShadowGenerator.addShadowCaster` defaults to
 * `includeDescendants = true`, which would register every child (including glass).
 */
export function listSunShadowCasterMeshes(
  meshes: AbstractMesh[],
  opts: {
    isGlass: (mesh: AbstractMesh) => boolean;
    isCeiling: (mesh: AbstractMesh) => boolean;
  },
): AbstractMesh[] {
  return listLoadedSceneMeshes(meshes).filter(
    (mesh) => !opts.isGlass(mesh) && !opts.isCeiling(mesh),
  );
}
