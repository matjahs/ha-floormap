import type { FloorplanIR, CameraIR } from "../../import/ir";
import type { LightParams } from "../../types";
import { cameraEyeTarget } from "../../projection";
import type {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  PointLight,
  Color,
} from "three";

export interface Live3dHandle {
  canvas: HTMLCanvasElement;
  setLight(fixtureId: string, params: LightParams): void;
  setCamera(cam: CameraIR): void;
  resize(width: number, height: number): void;
  render(): void;
  dispose(): void;
}

/**
 * Dynamic three.js scene from IR. Loaded only in live3d mode.
 */
export async function createLive3dRenderer(
  ir: FloorplanIR,
  canvas: HTMLCanvasElement,
  initialCamera?: CameraIR,
): Promise<Live3dHandle> {
  const THREE = await import("three");
  const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");

  const renderer: WebGLRenderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene: Scene = new THREE.Scene();
  scene.background = new THREE.Color(ir.environment.skyColor ?? "#87ceeb");

  const camera: PerspectiveCamera = new THREE.PerspectiveCamera(50, 1, 1, 100000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  const amb = new THREE.AmbientLight(ir.environment.ambientColor ?? "#404040", 0.35);
  scene.add(amb);

  const sun = new THREE.DirectionalLight(0xfff2e0, 0.4);
  sun.position.set(500, 1000, 300);
  sun.castShadow = true;
  scene.add(sun);

  const floorMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.9 });
  for (const room of ir.rooms) {
    if (room.polygon.length < 3) {
      continue;
    }
    const shape = new THREE.Shape();
    room.polygon.forEach((p, i) => {
      if (i === 0) {
        shape.moveTo(p.x, p.y);
      } else {
        shape.lineTo(p.x, p.y);
      }
    });
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const elev = ir.levels.find((l) => l.id === room.levelId)?.elevation ?? 0;
    const mesh = new THREE.Mesh(geo, floorMat);
    mesh.position.y = elev;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  const wallMat = new THREE.MeshStandardMaterial({ color: 0xe8e4dc });
  for (const wall of ir.walls) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const len = Math.hypot(dx, dy) || 1;
    const height = wall.height ?? 250;
    const geo = new THREE.BoxGeometry(len, height, wall.thickness);
    const mesh = new THREE.Mesh(geo, wallMat);
    mesh.position.set(
      (wall.start.x + wall.end.x) / 2,
      height / 2 + (ir.levels.find((l) => l.id === wall.levelId)?.elevation ?? 0),
      (wall.start.y + wall.end.y) / 2,
    );
    mesh.rotation.y = -Math.atan2(dy, dx);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  const lights = new Map<string, PointLight>();
  for (const fx of ir.fixtures) {
    const col = new THREE.Color(fx.color) as Color;
    const pl = new THREE.PointLight(col, 0, fx.diameter ? fx.diameter * 20 : 400, 2);
    pl.position.set(fx.position.x, fx.position.z, fx.position.y);
    pl.castShadow = true;
    scene.add(pl);
    lights.set(fx.id, pl);
  }

  const applyCamera = (cam: CameraIR) => {
    const { eye, target } = cameraEyeTarget(cam);
    camera.fov = (cam.fieldOfView * 180) / Math.PI;
    camera.position.set(eye.x, eye.y, eye.z);
    camera.lookAt(target.x, target.y, target.z);
    controls.target.set(target.x, target.y, target.z);
    camera.updateProjectionMatrix();
    controls.update();
  };

  if (initialCamera) {
    applyCamera(initialCamera);
  } else if (ir.cameras[0]) {
    applyCamera(ir.cameras[0]);
  }

  let idleTimer = 0;
  controls.addEventListener("start", () => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1) * 0.5);
  });
  controls.addEventListener("end", () => {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.render(scene, camera);
    }, 150);
  });

  return {
    canvas,
    setLight(fixtureId, params) {
      const pl = lights.get(fixtureId);
      if (!pl) {
        return;
      }
      pl.intensity = params.intensity * 800;
      pl.color.setRGB(params.color[0], params.color[1], params.color[2]);
    },
    setCamera(cam) {
      applyCamera(cam);
    },
    resize(width, height) {
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    },
    render() {
      controls.update();
      renderer.render(scene, camera);
    },
    dispose() {
      window.clearTimeout(idleTimer);
      controls.dispose();
      renderer.dispose();
      scene.traverse((obj) => {
        const mesh = obj as import("three").Mesh;
        if (mesh.geometry) {
          mesh.geometry.dispose();
        }
        if (mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            m.dispose();
          }
        }
      });
      lights.clear();
    },
  };
}
