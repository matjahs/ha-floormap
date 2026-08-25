/** Blender export prefix for room ceiling meshes (not fixture names like "Living ceiling 4"). */
export const CEILING_NAME_RE = /sfceiling_/i;

export interface CeilingLike {
  name: string;
  parent: CeilingLike | null;
}

/** True when this mesh or an ancestor was tagged in Blender Ceilings collection. */
export function isCeilingObject(obj: CeilingLike): boolean {
  let cur: CeilingLike | null = obj;
  while (cur) {
    if (CEILING_NAME_RE.test(cur.name)) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}
