import type { MeshStandardMaterial } from "three";

/** Real PVC oak plank (home photo + ruler). */
export const PVC_OAK_PLANK_WIDTH_CM = 22.8;
export const PVC_OAK_PLANK_LENGTH_CM = 121;
/** Must match the baked pvc-oak.jpg atlas grid. */
export const PVC_OAK_ATLAS_COLS = 28;
export const PVC_OAK_ATLAS_ROWS = 5;

/**
 * Sample the floor map in world XZ. Atlas is a running-bond of 22.8 x 121 cm boards.
 */
export function applyHashedPlankFloor(
  mat: MeshStandardMaterial,
  opts?: {
    plankWidthCm?: number;
    plankLengthCm?: number;
    atlasCols?: number;
    atlasRows?: number;
  },
): void {
  const plankW = opts?.plankWidthCm ?? PVC_OAK_PLANK_WIDTH_CM;
  const plankL = opts?.plankLengthCm ?? PVC_OAK_PLANK_LENGTH_CM;
  const atlasCols = opts?.atlasCols ?? PVC_OAK_ATLAS_COLS;
  const atlasRows = opts?.atlasRows ?? PVC_OAK_ATLAS_ROWS;

  mat.customProgramCacheKey = () => {
    return `plank-floor:${plankW}:${plankL}:${atlasCols}:${atlasRows}`;
  };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPlankW = { value: plankW };
    shader.uniforms.uPlankL = { value: plankL };
    shader.uniforms.uAtlasCols = { value: atlasCols };
    shader.uniforms.uAtlasRows = { value: atlasRows };

    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
varying vec2 vPlankXZ;`,
    ).replace(
      "#include <project_vertex>",
      `#include <project_vertex>
vPlankXZ = (modelMatrix * vec4(transformed, 1.0)).xz;`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
varying vec2 vPlankXZ;
uniform float uPlankW;
uniform float uPlankL;
uniform float uAtlasCols;
uniform float uAtlasRows;
vec2 plankFloorUv(vec2 xz) {
  // Atlas already has the running-bond layout; map world cm onto it.
  return vec2(
    xz.x / (uAtlasCols * uPlankW),
    xz.y / (uAtlasRows * uPlankL)
  );
}`,
    ).replace(
      "texture2D( map, vMapUv )",
      "texture2D( map, plankFloorUv(vPlankXZ) )",
    );
  };
}
