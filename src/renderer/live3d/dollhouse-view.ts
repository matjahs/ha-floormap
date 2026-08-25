import type { FloorplanIR } from "../../import/ir";

export interface DollhouseFrame {
  eye: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  fovDeg: number;
  near: number;
  far: number;
  distance: number;
}

export interface DollhouseBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Fit the plan to the canvas; keep Blender DollhouseCam look direction, not its 35 m eye height. */
export function computeDollhouseFrame(
  ir: FloorplanIR,
  opts: {
    levelElevation?: number;
    aspect: number;
    bounds?: DollhouseBounds;
  },
): DollhouseFrame {
  const minX = opts.bounds?.minX ?? ir.bounds.min.x;
  const maxX = opts.bounds?.maxX ?? ir.bounds.max.x;
  const minY = opts.bounds?.minY ?? ir.bounds.min.y;
  const maxY = opts.bounds?.maxY ?? ir.bounds.max.y;
  const cx = (minX + maxX) / 2;
  const cz = (minY + maxY) / 2;
  const spanX = Math.max(100, maxX - minX);
  const spanY = Math.max(100, maxY - minY);
  const fitSpan = Math.max(spanX, spanY) * 1.06;
  const aspect = Math.max(0.5, opts.aspect);
  const view = ir.environment.dollhouseView;
  const bird = ir.cameras.find((c) => /bird\s*view/i.test(c.name ?? ""));
  const floorCam = ir.cameras.find((c) => /^floorplan$/i.test(c.name ?? ""));
  const fovDeg = view?.fovDeg ?? 42;
  const fovRad = view
    ? (fovDeg * Math.PI) / 180
    : bird?.fieldOfView ?? floorCam?.fieldOfView ?? (52 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(fovRad / 2) * aspect);
  const fitDist = Math.max(
    fitSpan / 2 / Math.tan(fovRad / 2),
    spanX / 2 / Math.tan(hFov / 2),
    spanY / 2 / Math.tan(fovRad / 2),
  );
  const elev = opts.levelElevation ?? 0;
  const distance = Math.max(fitDist * 0.9, 400);
  const polar = 0.26;
  const baseX = view?.eye.x ?? bird?.x ?? floorCam?.x ?? cx;
  const baseY = view?.eye.z ?? bird?.y ?? floorCam?.y ?? cz;
  const toCx = cx - baseX;
  const toCy = cz - baseY;
  const az = Math.hypot(toCx, toCy) > 1 ? Math.atan2(toCy, toCx) : -Math.PI / 2;
  const horiz = Math.sin(polar) * distance;
  const eye = {
    x: cx - Math.cos(az) * horiz,
    y: elev + Math.cos(polar) * distance,
    z: cz - Math.sin(az) * horiz,
  };
  const target = { x: cx, y: elev + 40, z: cz };
  return {
    eye,
    target,
    fovDeg: (fovRad * 180) / Math.PI,
    near: Math.max(10, distance / 80),
    far: Math.max(200000, distance * 20),
    distance,
  };
}
