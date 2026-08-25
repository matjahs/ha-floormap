import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  PVC_OAK_ATLAS_COLS,
  PVC_OAK_ATLAS_ROWS,
  PVC_OAK_PLANK_LENGTH_CM,
  PVC_OAK_PLANK_WIDTH_CM,
  applyHashedPlankFloor,
} from "../src/renderer/live3d/plank-floor-material";

describe("hashed plank floor", () => {
  it("uses 22.8 x 121 cm boards", () => {
    expect(PVC_OAK_PLANK_WIDTH_CM).toBe(22.8);
    expect(PVC_OAK_PLANK_LENGTH_CM).toBe(121);
    expect(PVC_OAK_ATLAS_COLS).toBe(28);
    expect(PVC_OAK_ATLAS_ROWS).toBe(5);
  });

  it("injects world-space plank UVs into MeshStandardMaterial", () => {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    applyHashedPlankFloor(mat);
    expect(mat.customProgramCacheKey()).toContain("plank-floor");
    const shader = {
      uniforms: {} as Record<string, { value: number }>,
      vertexShader: "#include <common>\n#include <project_vertex>\n",
      fragmentShader:
        "#include <common>\nvec4 sampledDiffuseColor = texture2D( map, vMapUv );\n",
    };
    mat.onBeforeCompile(shader as never, undefined as never);
    expect(shader.uniforms.uPlankW.value).toBe(22.8);
    expect(shader.uniforms.uPlankL.value).toBe(121);
    expect(shader.vertexShader).toContain("vPlankXZ");
    expect(shader.fragmentShader).toContain("plankFloorUv");
    expect(shader.fragmentShader).not.toContain("texture2D( map, vMapUv )");
  });
});
