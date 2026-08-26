import { Vector3, type AbstractMesh } from "@babylonjs/core";
import type { DollhouseBounds } from "./dollhouse-view";

/** World-space bounds of loaded glTF meshes mapped to plan X/Y (render X/Z). */
export function dollhouseBoundsFromMeshes(meshes: AbstractMesh[]): DollhouseBounds | null {
  let min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  let max = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  let found = false;

  for (const mesh of meshes) {
    if (mesh.name === "skyBox") {
      continue;
    }
    mesh.computeWorldMatrix(true);
    const { min: meshMin, max: meshMax } = mesh.getHierarchyBoundingVectors(true);
    min = Vector3.Minimize(min, meshMin);
    max = Vector3.Maximize(max, meshMax);
    found = true;
  }

  if (!found || !Number.isFinite(min.x)) {
    return null;
  }

  // Render (X, Y up, Z) ↔ plan (X, Y horizontal, Z elevation).
  return {
    minX: min.x,
    maxX: max.x,
    minY: min.z,
    maxY: max.z,
  };
}
