export const FULLSCREEN_VERT = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
out vec2 vUv;
void main() {
  vec2 p = POS[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

export function makeAccumulateFrag(maxLights: number): string {
  return `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uBase;
uniform sampler2D uCi[${maxLights}];
uniform int uCount;
uniform vec3 uColor[${maxLights}];
uniform float uIntensity[${maxLights}];
uniform float uExposure;
uniform int uToneMap; // 0 none, 1 reinhard, 2 aces
uniform int uDifferenceBaked; // 1 if Ci already (overlay-base)

vec3 srgbToLinear(vec3 c) {
  bvec3 cutoff = lessThanEqual(c, vec3(0.04045));
  vec3 higher = pow((c + 0.055) / 1.055, vec3(2.4));
  vec3 lower = c / 12.92;
  return mix(higher, lower, vec3(cutoff));
}

vec3 linearToSrgb(vec3 c) {
  bvec3 cutoff = lessThanEqual(c, vec3(0.0031308));
  vec3 higher = 1.055 * pow(c, vec3(1.0/2.4)) - 0.055;
  vec3 lower = c * 12.92;
  return mix(higher, lower, vec3(cutoff));
}

vec3 aces(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 baseS = texture(uBase, vUv).rgb;
  vec3 L = srgbToLinear(baseS);
  for (int i = 0; i < ${maxLights}; i++) {
    if (i >= uCount) break;
    vec3 sampleS = texture(uCi[i], vUv).rgb;
    vec3 Ci;
    if (uDifferenceBaked == 1) {
      Ci = srgbToLinear(sampleS);
    } else {
      Ci = max(srgbToLinear(sampleS) - srgbToLinear(baseS), vec3(0.0));
    }
    L += Ci * uIntensity[i] * uColor[i];
  }
  L *= uExposure;
  vec3 mapped;
  if (uToneMap == 1) {
    mapped = L / (vec3(1.0) + L);
  } else if (uToneMap == 2) {
    mapped = aces(L);
  } else {
    mapped = clamp(L, 0.0, 1.0);
  }
  outColor = vec4(linearToSrgb(mapped), 1.0);
}
`;
}

export const BLIT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
void main() {
  outColor = texture(uTex, vUv);
}
`;
