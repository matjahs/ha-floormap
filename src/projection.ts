import type { Vec2, Vec3 } from "./types";
import type { CameraIR } from "./import/ir";

export interface Mat4 {
  /** Column-major 4×4 */
  m: Float64Array;
}

export function mat4Identity(): Mat4 {
  return {
    m: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Plan (X,Y,Z elev) → render Y-up (X, Z, Y). */
export function planToRender(p: Vec3): Vec3 {
  return { x: p.x, y: p.z, z: p.y };
}

/**
 * SweetHome3D PhotoRenderer look-at:
 * eye = (cam.x, cam.z, cam.y)
 * target = (cam.x - sin(yaw)*cos(pitch), cam.z - sin(pitch), cam.y + cos(yaw)*cos(pitch))
 */
export function cameraEyeTarget(cam: CameraIR): { eye: Vec3; target: Vec3; up: Vec3 } {
  const pitchCos = Math.cos(cam.pitch);
  const eye: Vec3 = { x: cam.x, y: cam.z, z: cam.y };
  const target: Vec3 = {
    x: cam.x - Math.sin(cam.yaw) * pitchCos,
    y: cam.z - Math.sin(cam.pitch),
    z: cam.y + Math.cos(cam.yaw) * pitchCos,
  };
  return { eye, target, up: { x: 0, y: 1, z: 0 } };
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const zAxis = normalize(sub(eye, target));
  const xAxis = normalize(cross(up, zAxis));
  const yAxis = cross(zAxis, xAxis);
  const m = new Float64Array(16);
  m[0] = xAxis.x;
  m[1] = yAxis.x;
  m[2] = zAxis.x;
  m[3] = 0;
  m[4] = xAxis.y;
  m[5] = yAxis.y;
  m[6] = zAxis.y;
  m[7] = 0;
  m[8] = xAxis.z;
  m[9] = yAxis.z;
  m[10] = zAxis.z;
  m[11] = 0;
  m[12] = -dot(xAxis, eye);
  m[13] = -dot(yAxis, eye);
  m[14] = -dot(zAxis, eye);
  m[15] = 1;
  return { m };
}

export function perspective(fovyRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovyRad / 2);
  const m = new Float64Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return { m };
}

export function mulMat4(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a.m[k * 4 + row]! * b.m[col * 4 + k]!;
      }
      out[col * 4 + row] = sum;
    }
  }
  return { m: out };
}

export function transformPoint(mat: Mat4, p: Vec3): { x: number; y: number; z: number; w: number } {
  const { m } = mat;
  const x = m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!;
  const y = m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!;
  const z = m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!;
  const w = m[3]! * p.x + m[7]! * p.y + m[11]! * p.z + m[15]!;
  return { x, y, z, w };
}

export interface ProjectOptions {
  aspect: number;
  near?: number;
  far?: number;
  /** If true, fieldOfView is horizontal; default vertical (SH3D pinole). */
  horizontalFov?: boolean;
}

export interface Uv {
  u: number;
  v: number;
  behind: boolean;
}

/**
 * Project a plan-space world point through a SweetHome3D camera into image UV [0,1]
 * where v=0 is the top of the image (matches HA style top/left %).
 */
export function projectPoint(cam: CameraIR, planPoint: Vec3, opts: ProjectOptions): Uv {
  const { eye, target, up } = cameraEyeTarget(cam);
  const V = lookAt(eye, target, up);
  let fovy = cam.fieldOfView;
  if (opts.horizontalFov) {
    fovy = 2 * Math.atan(Math.tan(cam.fieldOfView / 2) / opts.aspect);
  }
  const P = perspective(fovy, opts.aspect, opts.near ?? 1, opts.far ?? 100000);
  const VP = mulMat4(P, V);
  const renderP = planToRender(planPoint);
  const clip = transformPoint(VP, renderP);
  if (Math.abs(clip.w) < 1e-9) {
    return { u: 0.5, v: 0.5, behind: true };
  }
  const ndcX = clip.x / clip.w;
  const ndcY = clip.y / clip.w;
  const behind = clip.w < 0;
  const u = ndcX * 0.5 + 0.5;
  const v = 1 - (ndcY * 0.5 + 0.5);
  return { u, v, behind };
}

export function projectToPercent(
  cam: CameraIR,
  planPoint: Vec3,
  opts: ProjectOptions,
): { left: number; top: number; behind: boolean } {
  const { u, v, behind } = projectPoint(cam, planPoint, opts);
  return { left: u * 100, top: v * 100, behind };
}

export function projectPolygon(
  cam: CameraIR,
  polygon: Vec2[],
  elevation: number,
  opts: ProjectOptions,
): Vec2[] {
  return polygon.map((p) => {
    const uv = projectPoint(cam, { x: p.x, y: p.y, z: elevation }, opts);
    return { x: uv.u, y: uv.v };
  });
}

export function selectCamera(
  cameras: CameraIR[],
  preferredId?: string,
): CameraIR | undefined {
  if (preferredId) {
    const hit = cameras.find((c) => c.id === preferredId || c.name === preferredId);
    if (hit) {
      return hit;
    }
  }
  const stored = cameras.find((c) => c.attribute === "storedCamera" && c.lens === "PINHOLE");
  if (stored) {
    return stored;
  }
  return cameras.find((c) => c.attribute === "storedCamera") ?? cameras[0];
}
