import { Scene, TransformNode, type AbstractMesh, type Node } from "@babylonjs/core";
import type { ISceneLoaderAsyncResult } from "@babylonjs/core/Loading/sceneLoader";

/** Blender export is meters; live3d plan space is cm. Scale the whole glTF root, not each mesh. */
export const GLTF_SCENE_SCALE = 100;

/**
 * glTF from Blender has many scene-root nodes (no __root__). Per-mesh scaling leaves
 * translations in meters and stacks geometry. Parent everything under one node instead.
 */
export function applyGltfSceneScale(
  scene: Scene,
  loaded: ISceneLoaderAsyncResult,
  scale = GLTF_SCENE_SCALE,
): TransformNode {
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
  return meshes.filter((mesh) => mesh.name !== "skyBox");
}
