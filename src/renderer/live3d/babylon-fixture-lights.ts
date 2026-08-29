/**
 * HA fixture lights for Babylon live3d.
 * Point / strip / spot use ClusteredLightContainer on Babylon 9+ (WebGPU UBO budget).
 * Area lights use RectAreaLight on the normal path (clustered does not support them).
 */
import {
  Color3,
  PointLight,
  Quaternion,
  RectAreaLight,
  SpotLight,
  Vector3,
  type Light,
  type Scene,
} from "@babylonjs/core";
import type { FixtureKind, Vec3 } from "../../types";

export interface FixtureLightOptics {
  kind?: FixtureKind;
  direction?: Vec3;
  spotAngleDeg?: number;
  spotBlend?: number;
  areaWidth?: number;
  areaHeight?: number;
}

export interface FixtureLightHandle {
  readonly sampleCount: number;
  setIntensity(on: boolean, intensity: number, color: [number, number, number]): void;
  setSampleIntensity(
    index: number,
    on: boolean,
    intensity: number,
    color: [number, number, number],
  ): void;
  setPosition(index: number, pos: Vec3, planToRender: (p: Vec3) => Vector3): void;
  getRenderPosition(index: number): Vector3 | null;
}

type ClusteredModule = typeof import("@babylonjs/core/Lights/Clustered/clusteredLightContainer");

let clusteredModulePromise: Promise<ClusteredModule | null> | null = null;

async function loadClusteredModule(): Promise<ClusteredModule | null> {
  if (!clusteredModulePromise) {
    clusteredModulePromise = import("@babylonjs/core/Lights/Clustered/clusteredLightContainer")
      .then((mod) => mod)
      .catch(() => null);
  }
  return clusteredModulePromise;
}

function planDirToRender(dir: Vec3 | undefined): Vector3 {
  if (!dir) {
    return new Vector3(0, -1, 0);
  }
  const v = new Vector3(dir.x, dir.z, dir.y);
  if (v.lengthSquared() < 1e-12) {
    return new Vector3(0, -1, 0);
  }
  return v.normalize();
}

type FixtureBabylonLight = PointLight | SpotLight | RectAreaLight;

/** Orient so local −Z matches `aim` (RectAreaLight emission axis). */
function orientEmitMinusZ(light: RectAreaLight, aim: Vector3): void {
  const upHint =
    Math.abs(aim.y) > 0.92 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  // FromLookDirectionRH sets local +Z to `forward`; we want local −Z = aim ⇒ +Z = −aim.
  const node = light as RectAreaLight & { rotationQuaternion: Quaternion | null };
  node.rotationQuaternion = Quaternion.FromLookDirectionRH(aim.scale(-1), upHint);
}

function createPointLight(
  name: string,
  position: Vector3,
  scene: Scene,
  dontAddToScene: boolean,
): PointLight {
  const ctor = PointLight as unknown as {
    new (name: string, position: Vector3, scene?: Scene, dontAddToScene?: boolean): PointLight;
  };
  return new ctor(name, position, scene, dontAddToScene);
}

function createSpotLight(
  name: string,
  position: Vector3,
  direction: Vector3,
  angle: number,
  exponent: number,
  scene: Scene,
  dontAddToScene: boolean,
): SpotLight {
  const ctor = SpotLight as unknown as {
    new (
      name: string,
      position: Vector3,
      direction: Vector3,
      angle: number,
      exponent: number,
      scene?: Scene,
      dontAddToScene?: boolean,
    ): SpotLight;
  };
  return new ctor(name, position, direction, angle, exponent, scene, dontAddToScene);
}

export async function createFixtureLightSystem(
  scene: Scene,
  fixtureLightScale: number,
  areaLightScale = fixtureLightScale * 0.45,
): Promise<{
  createGroup(
    fixtureId: string,
    positions: Vec3[],
    hexColor: string,
    range: number,
    planToRender: (p: Vec3) => Vector3,
    optics?: FixtureLightOptics,
  ): FixtureLightHandle;
  finalize(): void;
  dispose(): void;
}> {
  const clusteredMod = await loadClusteredModule();
  const useClustered = clusteredMod !== null;
  if (useClustered && clusteredMod) {
    clusteredMod.RegisterClusteredLightContainer();
  }

  const groups = new Map<string, FixtureBabylonLight[]>();
  const pendingClusteredLights: Light[] = [];
  let clusteredContainer: InstanceType<ClusteredModule["ClusteredLightContainer"]> | null = null;

  const createGroup = (
    fixtureId: string,
    positions: Vec3[],
    hexColor: string,
    range: number,
    planToRender: (p: Vec3) => Vector3,
    optics: FixtureLightOptics = {},
  ): FixtureLightHandle => {
    const col = Color3.FromHexString(hexColor || "#fff2d6");
    const kind = optics.kind ?? "point";
    const lights: FixtureBabylonLight[] = [];
    const scale = kind === "area" ? areaLightScale : fixtureLightScale;

    if (kind === "area") {
      const pos = planToRender(positions[0]!);
      const w = Math.max(5, optics.areaWidth ?? 40);
      const h = Math.max(5, optics.areaHeight ?? 40);
      const area = new RectAreaLight(`fx_${fixtureId}_0`, pos, w, h, scene);
      area.diffuse = col;
      area.intensity = 0;
      orientEmitMinusZ(area, planDirToRender(optics.direction));
      lights.push(area);
    } else if (kind === "spot") {
      const aim = planDirToRender(optics.direction);
      const angleRad = ((optics.spotAngleDeg ?? 45) * Math.PI) / 180;
      const blend = Math.min(1, Math.max(0, optics.spotBlend ?? 0.15));
      const exponent = Math.max(1, 2 + (1 - blend) * 48);
      for (let i = 0; i < positions.length; i++) {
        const spot = createSpotLight(
          `fx_${fixtureId}_${i}`,
          planToRender(positions[i]!),
          aim.clone(),
          angleRad,
          exponent,
          scene,
          useClustered,
        );
        spot.diffuse = col;
        spot.intensity = 0;
        spot.range = range;
        lights.push(spot);
        if (useClustered) {
          pendingClusteredLights.push(spot);
        }
      }
    } else {
      for (let i = 0; i < positions.length; i++) {
        const pl = createPointLight(
          `fx_${fixtureId}_${i}`,
          planToRender(positions[i]!),
          scene,
          useClustered,
        );
        pl.diffuse = col;
        pl.intensity = 0;
        pl.range = range;
        lights.push(pl);
        if (useClustered) {
          pendingClusteredLights.push(pl);
        }
      }
    }

    groups.set(fixtureId, lights);

    return {
      sampleCount: lights.length,
      setIntensity(on, intensity, color) {
        for (const light of lights) {
          light.intensity = on ? intensity * scale : 0;
          light.diffuse = new Color3(color[0], color[1], color[2]);
        }
      },
      setSampleIntensity(index, on, intensity, color) {
        const light = lights[index];
        if (!light) {
          return;
        }
        light.intensity = on ? intensity * scale : 0;
        light.diffuse = new Color3(color[0], color[1], color[2]);
      },
      setPosition(index, pos, toRender) {
        const light = lights[index];
        if (!light) {
          return;
        }
        light.position.copyFrom(toRender(pos));
        if (light instanceof SpotLight && optics.direction) {
          light.direction.copyFrom(planDirToRender(optics.direction));
        }
        if (light instanceof RectAreaLight) {
          orientEmitMinusZ(light, planDirToRender(optics.direction));
        }
      },
      getRenderPosition(index) {
        return lights[index]?.position ?? null;
      },
    };
  };

  const finalize = (): void => {
    if (!useClustered || !clusteredMod || pendingClusteredLights.length === 0 || clusteredContainer) {
      return;
    }
    clusteredContainer = new clusteredMod.ClusteredLightContainer(
      "fixtures",
      pendingClusteredLights,
      scene,
    );
    clusteredContainer.maxRange = 2400;
  };

  const dispose = (): void => {
    clusteredContainer?.dispose();
    clusteredContainer = null;
    for (const lights of groups.values()) {
      for (const light of lights) {
        light.dispose();
      }
    }
    groups.clear();
  };

  return { createGroup, finalize, dispose };
}
