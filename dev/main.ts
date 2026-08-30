/// <reference types="vite/client" />
import type { HomeAssistant } from "custom-card-helpers";
import type { SunflowFloorplanCardConfig } from "../src/types";
import type { Live3dDebugInfo } from "../src/renderer/live3d/scene";
import { CARD_TYPE, SunflowFloorplanCard } from "../src/card";
import { overridesToPlacements } from "../src/pose";
import { entityIdsFromConfig, playgroundConfig } from "./playground-config";
import { MockHass, registerHaStubs } from "./mock-hass";
import { approximateSun } from "../src/sun";

const ambientFillSlider = document.querySelector("#ambient-fill") as HTMLInputElement | null;
const ambientFillValue = document.querySelector("#ambient-fill-value") as HTMLElement | null;

registerHaStubs();

if (!customElements.get(CARD_TYPE)) {
  customElements.define(CARD_TYPE, SunflowFloorplanCard);
}

let liveConfig: SunflowFloorplanCardConfig = structuredClone(playgroundConfig);
const entityIds = entityIdsFromConfig(liveConfig);
const mock = new MockHass(entityIds);
const statusEl = document.querySelector("#status") as HTMLElement;
const togglesEl = document.querySelector("#toggles") as HTMLElement;
const stageEl = document.querySelector("#stage") as HTMLElement;
const exportEl = document.querySelector("#export") as HTMLTextAreaElement | null;

let card: SunflowFloorplanCard | null = null;
let assetProbeLines: string[] = [];

function asHass(): HomeAssistant {
  return mock as unknown as HomeAssistant;
}

function setStatus(msg: string, err = false): void {
  statusEl.textContent = msg;
  statusEl.classList.toggle("err", err);
}

function syncCardHass(): void {
  if (!card) {
    return;
  }
  card.hass = {
    ...asHass(),
    states: { ...mock.states },
    entities: { ...mock.entities },
    areas: { ...mock.areas },
    callService: mock.callService.bind(mock),
  } as unknown as HomeAssistant;
}

function renderToggles(): void {
  togglesEl.replaceChildren();
  for (const id of entityIds) {
    const btn = document.createElement("button");
    btn.type = "button";
    const on = mock.states[id]?.state === "on";
    btn.classList.toggle("on", on);
    btn.textContent = `${on ? "ON " : "off"}  ${id.replace(/^light\./, "")}`;
    btn.addEventListener("click", () => {
      void mock.callService("light", "toggle", { entity_id: id });
    });
    togglesEl.append(btn);
  }
}

/** Match HA: use the real sun pose for now, not a forced night. */
function applyLiveSun(): void {
  const pose = approximateSun(new Date());
  mock.setSun(pose.azimuth, pose.elevation);
}

function refreshExport(): void {
  if (!exportEl) {
    return;
  }
  const placements = overridesToPlacements(liveConfig.overrides);
  exportEl.value = JSON.stringify(placements, null, 2);
}

function formatPlaygroundStatus(live3d: Live3dDebugInfo | null): string {
  const lines = [
    `mode: ${liveConfig.render?.mode}`,
    `edit_mode: ${liveConfig.edit_mode}`,
    `entities: ${entityIds.length}`,
    `browser WebGPU: ${!!navigator.gpu}`,
    `browser WebGL2: ${!!document.createElement("canvas").getContext("webgl2")}`,
    `requested gpu: ${liveConfig.render?.gpu ?? "webgpu"}`,
    `live3d engine: ${liveConfig.render?.engine ?? "three"}`,
    `lock_camera: ${liveConfig.render?.lock_camera !== false}`,
  ];
  if (live3d) {
    lines.push(`live3d ready: ${live3d.ready}`);
    lines.push(`active backend: ${live3d.backend ?? (live3d.fallback ? "fallback" : "pending")}`);
    if (live3d.fallback) {
      lines.push("live3d fallback: marker preview only");
    }
    if (live3d.error) {
      lines.push(`error: ${live3d.error}`);
    }
  } else {
    lines.push("live3d: loading…");
  }
  if (assetProbeLines.length > 0) {
    lines.push(...assetProbeLines);
  }
  return lines.join("\n");
}

function refreshPlaygroundStatus(live3d: Live3dDebugInfo | null = card?.getLive3dDebug() ?? null): void {
  setStatus(formatPlaygroundStatus(live3d), Boolean(live3d?.error));
  const camBtn = document.querySelector("#btn-free-camera") as HTMLButtonElement | null;
  if (camBtn) {
    const locked = liveConfig.render?.lock_camera !== false;
    camBtn.textContent = locked ? "Free camera" : "Lock camera";
    camBtn.classList.toggle("on", !locked);
  }
  const engineBtn = document.querySelector("#btn-toggle-engine") as HTMLButtonElement | null;
  if (engineBtn) {
    const engine = liveConfig.render?.engine ?? "three";
    engineBtn.textContent = engine === "babylon" ? "Engine: Babylon" : "Engine: Three";
    engineBtn.classList.toggle("on", engine === "babylon");
  }
  const gpuBtn = document.querySelector("#btn-toggle-gpu") as HTMLButtonElement | null;
  if (gpuBtn) {
    const gpu = liveConfig.render?.gpu ?? "webgpu";
    gpuBtn.textContent = gpu === "webgpu" ? "GPU: WebGPU" : "GPU: WebGL";
    gpuBtn.classList.toggle("on", gpu === "webgpu");
    if (live3d?.backend) {
      gpuBtn.title = `Requested ${gpu}, active ${live3d.backend}`;
    }
  }
}

function mountCard(): void {
  card?.remove();
  stageEl.replaceChildren();
  card = new SunflowFloorplanCard();
  card.addEventListener("config-changed", ((ev: CustomEvent<{ config: SunflowFloorplanCardConfig }>) => {
    liveConfig = ev.detail.config;
    refreshExport();
    refreshPlaygroundStatus();
  }) as EventListener);
  card.addEventListener("live3d-status", ((ev: CustomEvent<Live3dDebugInfo>) => {
    refreshPlaygroundStatus(ev.detail);
  }) as EventListener);
  card.setConfig(liveConfig);
  syncCardHass();
  stageEl.append(card);
  refreshExport();
  refreshPlaygroundStatus(null);
}

function downloadPlacements(): void {
  const blob = new Blob([JSON.stringify(overridesToPlacements(liveConfig.overrides), null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "placements.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

async function probeAssets(): Promise<void> {
  const urls = [
    "/local/floorplan/manifest.json",
    "/local/floorplan/placements.json?v=2",
    "/local/floorplan/appartement.glb",
  ];
  assetProbeLines = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: "GET" });
      assetProbeLines.push(`${res.ok ? "ok" : "FAIL"} ${res.status} ${url}`);
    } catch (e) {
      assetProbeLines.push(`FAIL ${url} (${e instanceof Error ? e.message : e})`);
    }
  }
  refreshPlaygroundStatus();
}

mock.subscribe(() => {
  syncCardHass();
  renderToggles();
});

document.querySelector("#btn-all-on")?.addEventListener("click", () => {
  for (const id of entityIds) {
    mock.setState(id, true);
  }
});
document.querySelector("#btn-typical")?.addEventListener("click", () => {
  const brightness = Math.round(0.4 * 255);
  for (const id of entityIds) {
    mock.setState(id, true, brightness);
  }
});
document.querySelector("#btn-all-off")?.addEventListener("click", () => {
  for (const id of entityIds) {
    mock.setState(id, false);
  }
});
document.querySelector("#btn-random")?.addEventListener("click", () => {
  for (const id of entityIds) {
    mock.setState(id, Math.random() > 0.5);
  }
});
document.querySelector("#btn-reload")?.addEventListener("click", () => {
  mountCard();
  void probeAssets();
});
document.querySelector("#btn-free-camera")?.addEventListener("click", () => {
  if (!card) {
    return;
  }
  liveConfig = {
    ...liveConfig,
    render: {
      ...liveConfig.render,
      lock_camera: liveConfig.render?.lock_camera === false,
    },
  };
  card.setConfig(liveConfig);
  refreshExport();
});
document.querySelector("#btn-toggle-engine")?.addEventListener("click", () => {
  const next = liveConfig.render?.engine === "babylon" ? "three" : "babylon";
  liveConfig = {
    ...liveConfig,
    render: {
      ...liveConfig.render,
      engine: next,
    },
  };
  mountCard();
});
document.querySelector("#btn-toggle-gpu")?.addEventListener("click", () => {
  const next = liveConfig.render?.gpu === "webgl" ? "webgpu" : "webgl";
  liveConfig = {
    ...liveConfig,
    render: {
      ...liveConfig.render,
      gpu: next,
    },
  };
  mountCard();
});
document.querySelector("#btn-export")?.addEventListener("click", () => {
  downloadPlacements();
});

ambientFillSlider?.addEventListener("input", () => {
  const scale = Number(ambientFillSlider.value);
  const clamped = Number.isFinite(scale) ? Math.max(0, Math.min(4, scale)) : 1;
  if (ambientFillValue) {
    ambientFillValue.textContent = `${clamped.toFixed(2)}×`;
  }
  card?.setAmbientFillScale(clamped);
});

window.addEventListener("error", (ev) => {
  setStatus(`window error: ${ev.message}`, true);
});
window.addEventListener("unhandledrejection", (ev) => {
  setStatus(`unhandled: ${String(ev.reason)}`, true);
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    card?.remove();
    card = null;
  });
}

applyLiveSun();
mountCard();
renderToggles();
void probeAssets();
