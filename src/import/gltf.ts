/**
 * glTF / GLB / OBJ geometry fallback — extracts a bounding box and empty fixture list.
 * Fixture placement is manual in the editor.
 */

import { emptyIR, type FloorplanIR } from "./ir";

export function importGltfJson(json: unknown, fileName = "model.gltf"): FloorplanIR {
  const ir = emptyIR("gltf", fileName);
  ir.levels = [{ id: "ground", name: "Ground", elevation: 0, height: 250, visible: true }];

  // Best-effort: read accessor min/max if present
  const root = json as {
    accessors?: Array<{ min?: number[]; max?: number[] }>;
  };
  let minX = 0;
  let minY = 0;
  let minZ = 0;
  let maxX = 0;
  let maxY = 0;
  let maxZ = 0;
  let any = false;
  for (const acc of root.accessors ?? []) {
    if (acc.min && acc.max && acc.min.length >= 3 && acc.max.length >= 3) {
      any = true;
      minX = Math.min(minX, acc.min[0]!);
      minY = Math.min(minY, acc.min[1]!);
      minZ = Math.min(minZ, acc.min[2]!);
      maxX = Math.max(maxX, acc.max[0]!);
      maxY = Math.max(maxY, acc.max[1]!);
      maxZ = Math.max(maxZ, acc.max[2]!);
    }
  }
  if (any) {
    // glTF Y-up → plan XZ horizontal, Y elevation loosely mapped
    ir.bounds = {
      min: { x: minX * 100, y: minZ * 100, z: minY * 100 },
      max: { x: maxX * 100, y: maxZ * 100, z: maxY * 100 },
    };
  }
  return ir;
}

export function importObj(objText: string, fileName = "model.obj"): FloorplanIR {
  const ir = emptyIR("obj", fileName);
  ir.levels = [{ id: "ground", name: "Ground", elevation: 0, height: 250, visible: true }];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const line of objText.split(/\r?\n/)) {
    if (!line.startsWith("v ")) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    const x = Number.parseFloat(parts[1] ?? "0");
    const y = Number.parseFloat(parts[2] ?? "0");
    const z = Number.parseFloat(parts[3] ?? "0");
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  if (Number.isFinite(minX)) {
    ir.bounds = {
      min: { x: minX, y: minZ, z: minY },
      max: { x: maxX, y: maxZ, z: maxY },
    };
  }
  return ir;
}
