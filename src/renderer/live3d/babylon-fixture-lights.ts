/**
 * HA fixture point lights for Babylon live3d.
 * Uses ClusteredLightContainer on Babylon 9+ (WebGPU UBO budget); falls back to
 * plain PointLights on older builds.
 */
import { Color3, PointLight, Vector3, type Scene } from "@babylonjs/core";
import type { Vec3 } from "../../types";

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

export async function createFixtureLightSystem(
  scene: Scene,
  fixtureLightScale: number,
): Promise<{
  createGroup(
    fixtureId: string,
    positions: Vec3[],
    hexColor: string,
    range: number,
    planToRender: (p: Vec3) => Vector3,
  ): FixtureLightHandle;
  finalize(): void;
  dispose(): void;
}> {
  const clusteredMod = await loadClusteredModule();
  const useClustered = clusteredMod !== null;
  if (useClustered && clusteredMod) {
    clusteredMod.RegisterClusteredLightContainer();
  }

  const groups = new Map<string, PointLight[]>();
  const pendingClusteredLights: PointLight[] = [];
  let clusteredContainer: InstanceType<ClusteredModule["ClusteredLightContainer"]> | null = null;

  const createGroup = (
    fixtureId: string,
    positions: Vec3[],
    hexColor: string,
    range: number,
    planToRender: (p: Vec3) => Vector3,
  ): FixtureLightHandle => {
    const col = Color3.FromHexString(hexColor || "#fff2d6");
    const lights: PointLight[] = [];
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
    groups.set(fixtureId, lights);

    return {
      sampleCount: lights.length,
      setIntensity(on, intensity, color) {
        for (const pl of lights) {
          pl.intensity = on ? intensity * fixtureLightScale : 0;
          pl.diffuse = new Color3(color[0], color[1], color[2]);
        }
      },
      setSampleIntensity(index, on, intensity, color) {
        const pl = lights[index];
        if (!pl) {
          return;
        }
        pl.intensity = on ? intensity * fixtureLightScale : 0;
        pl.diffuse = new Color3(color[0], color[1], color[2]);
      },
      setPosition(index, pos, toRender) {
        const pl = lights[index];
        if (!pl) {
          return;
        }
        pl.position.copyFrom(toRender(pos));
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
    clusteredContainer.maxRange = 2000;
  };

  const dispose = (): void => {
    clusteredContainer?.dispose();
    clusteredContainer = null;
    for (const lights of groups.values()) {
      for (const pl of lights) {
        pl.dispose();
      }
    }
    groups.clear();
  };

  return { createGroup, finalize, dispose };
}
