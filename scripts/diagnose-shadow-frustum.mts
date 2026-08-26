/**
 * Light-space coverage for DirectionalLight fixed OrthoLH shadowFrustumSize.
 * Matches Babylon: LookAtLH(eye, eye+dir, up) + OrthoLH(size, size, minZ, maxZ).
 */
import { sunDirection } from "../src/sun.ts";

function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

function cross(a: number[], b: number[]): number[] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
}

function dot(a: number[], b: number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function sub(a: number[], b: number[]): number[] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}

function add(a: number[], b: number[]): number[] {
  return [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
}

function scale(a: number[], s: number): number[] {
  return [a[0]! * s, a[1]! * s, a[2]! * s];
}

function lookAtLH(eye: number[], target: number[], up: number[]) {
  const zAxis = normalize(sub(target, eye));
  let xAxis = normalize(cross(up, zAxis));
  if (Math.hypot(xAxis[0]!, xAxis[1]!, xAxis[2]!) < 1e-8) {
    xAxis = normalize(cross([0, 0, 1], zAxis));
  }
  const yAxis = cross(zAxis, xAxis);
  return (p: number[]) => {
    const t = sub(p, eye);
    return [dot(t, xAxis), dot(t, yAxis), dot(t, zAxis)];
  };
}

// Mesh AABB from appartement.scene.json → Babylon Y-up (x, height, planZ)
const bmin = [-15.831, -5.0, -163.959];
const bmax = [1507.784, 262.144, 1470.843];
const corners: number[][] = [];
for (const x of [bmin[0], bmax[0]]) {
  for (const y of [bmin[1], bmax[1]]) {
    for (const z of [bmin[2], bmax[2]]) {
      corners.push([x!, y!, z!]);
    }
  }
}

const planW = bmax[0]! - bmin[0]!;
const planD = bmax[2]! - bmin[2]!;
const planCx = (bmin[0]! + bmax[0]!) / 2;
const planCz = (bmin[2]! + bmax[2]!) / 2;
const target = [planCx, 40, planCz];
const aabbCenter = [
  (bmin[0]! + bmax[0]!) / 2,
  (bmin[1]! + bmax[1]!) / 2,
  (bmin[2]! + bmax[2]!) / 2,
];
const planDiagonal = Math.hypot(planW, planD);
const aabbDiagonal = Math.hypot(planW, bmax[1]! - bmin[1]!, planD);
const north = 180;

const cases = [
  { name: "dawn E ~08:15", az: 90, el: 14 },
  { name: "mid-morning", az: 120, el: 35 },
  { name: "noon S", az: 180, el: 55 },
  { name: "sunset W", az: 270, el: 12 },
  { name: "very low E", az: 85, el: 5 },
];

console.log(
  JSON.stringify(
    {
      planW,
      planD,
      planDiagonal,
      aabbDiagonal,
      target,
      aabbCenter,
      frustumNormal: planDiagonal * 1.12,
      frustumLow: planDiagonal * 1.22,
    },
    null,
    2,
  ),
);

for (const c of cases) {
  const toward = sunDirection(c.az, c.el, north);
  const dir = [toward.x, toward.y, toward.z];
  const lightDir = scale(dir, -1);
  const span = Math.max(planW, planD);
  const lowSun = c.el > 0 && c.el < 18;
  const shadowExtent = planDiagonal * (lowSun ? 1.22 : 1.12);
  const shadowMinZ = Math.max(40, shadowExtent * (lowSun ? 0.025 : 0.04));
  const shadowMaxZ = shadowExtent * (lowSun ? 2.4 : 2.0);
  const eye = add(target, scale(dir, span * 1.35));
  const toView = lookAtLH(eye, add(eye, lightDir), [0, 1, 0]);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZv = Infinity;
  let maxZv = -Infinity;
  for (const p of corners) {
    const v = toView(p);
    minX = Math.min(minX, v[0]!);
    maxX = Math.max(maxX, v[0]!);
    minY = Math.min(minY, v[1]!);
    maxY = Math.max(maxY, v[1]!);
    minZv = Math.min(minZv, v[2]!);
    maxZv = Math.max(maxZv, v[2]!);
  }

  const needCentered =
    2 * Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY));
  const needOffCenter = Math.max(maxX - minX, maxY - minY);
  const half = shadowExtent / 2;
  const clipped = {
    left: minX < -half,
    right: maxX > half,
    bottom: minY < -half,
    top: maxY > half,
    near: minZv < shadowMinZ,
    far: maxZv > shadowMaxZ,
  };

  console.log(`\n${c.name}`, { az: c.az, el: c.el, lowSun });
  console.log({
    lightDist: +(span * 1.35).toFixed(1),
    shadowExtent: +shadowExtent.toFixed(1),
    needCentered: +needCentered.toFixed(1),
    needOffCenter: +needOffCenter.toFixed(1),
    autoFitXY: +(needOffCenter * 1.12).toFixed(1),
    viewXY: [minX, maxX, minY, maxY].map((n) => +n.toFixed(1)),
    viewZ: [minZv, maxZv].map((n) => +n.toFixed(1)),
    shadowZ: [shadowMinZ, shadowMaxZ].map((n) => +n.toFixed(1)),
    zWasteRatio: +((shadowMaxZ - shadowMinZ) / Math.max(1, maxZv - minZv)).toFixed(2),
    xyOk: shadowExtent + 1e-6 >= needCentered,
    zOk: shadowMinZ <= minZv && shadowMaxZ >= maxZv,
    clipped,
    marginCentered: +(shadowExtent - needCentered).toFixed(1),
  });
}

console.log(
  "\nVerdict: XY of fixed frustum covers AABB; Z range is ~" +
    "2–4× wider than casters (ESM precision / bleed). Prefer autoUpdateExtends + autoCalcShadowZBounds.",
);
