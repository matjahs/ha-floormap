import type { HomeAssistant } from "custom-card-helpers";
import type { SunflowFloorplanCardConfig } from "../src/types";
import { CARD_TYPE, SunflowFloorplanCard } from "../src/card";
import { overridesToPlacements } from "../src/pose";
import { entityIdsFromConfig, playgroundConfig } from "./playground-config";
import { MockHass, registerHaStubs } from "./mock-hass";
import { approximateSun, playgroundSunPresets } from "../src/sun";
import { mountCompassOverlay } from "./compass-overlay";

const SUN_PRESETS = playgroundSunPresets();

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
  // Object spread drops class methods (callService). Bind explicitly.
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

let sunFollowClock = true;
const sunStatusEl = document.querySelector("#sun-status") as HTMLElement | null;

function refreshSunStatus(): void {
  const st = mock.states["sun.sun"];
  const az = Number(st?.attributes.azimuth ?? 0);
  const el = Number(st?.attributes.elevation ?? 0);
  if (sunStatusEl) {
    sunStatusEl.textContent = `${st?.state ?? "?"} · azimuth ${az.toFixed(0)}° · elevation ${el.toFixed(0)}°${sunFollowClock ? " (clock)" : ""}`;
  }
}

function applySun(azimuth: number, elevation: number, followClock: boolean): void {
  sunFollowClock = followClock;
  mock.setSun(azimuth, elevation);
  refreshSunStatus();
}

function applyClockSun(): void {
  const pose = approximateSun(new Date());
  applySun(pose.azimuth, pose.elevation, true);
}

function refreshExport(): void {
  if (!exportEl) {
    return;
  }
  const placements = overridesToPlacements(liveConfig.overrides);
  exportEl.value = JSON.stringify(placements, null, 2);
}

let disposeCompass: (() => void) | null = null;

function mountCard(): void {
  disposeCompass?.();
  stageEl.replaceChildren();
  card = new SunflowFloorplanCard();
  card.addEventListener("config-changed", ((ev: CustomEvent<{ config: SunflowFloorplanCardConfig }>) => {
    liveConfig = ev.detail.config;
    refreshExport();
    setStatus(`placements updated (${Object.keys(overridesToPlacements(liveConfig.overrides)).length} fixtures)`);
  }) as EventListener);
  card.setConfig(liveConfig);
  syncCardHass();
  stageEl.append(card);
  disposeCompass = mountCompassOverlay(stageEl, { getCard: () => card });
  refreshExport();
  setStatus(
    [
      `mode: ${liveConfig.render?.mode}`,
      `edit_mode: ${liveConfig.edit_mode}`,
      `entities: ${entityIds.length}`,
      `WebGPU: ${!!navigator.gpu}`,
      `WebGL2: ${!!document.createElement("canvas").getContext("webgl2")}`,
      `live3d gpu: ${liveConfig.render?.gpu ?? "webgpu"}`,
      `live3d engine: ${liveConfig.render?.engine ?? "three"}`,
      `lock_camera: ${liveConfig.render?.lock_camera !== false}`,
    ].join("\n"),
  );
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
  ];
  const lines: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: "GET" });
      lines.push(`${res.ok ? "ok" : "FAIL"} ${res.status} ${url}`);
    } catch (e) {
      lines.push(`FAIL ${url} (${e instanceof Error ? e.message : e})`);
    }
  }
  setStatus(lines.join("\n"), lines.some((l) => l.startsWith("FAIL")));
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
  const btn = document.querySelector("#btn-free-camera") as HTMLButtonElement | null;
  if (btn) {
    const locked = liveConfig.render?.lock_camera !== false;
    btn.textContent = locked ? "Free camera" : "Lock camera";
    btn.classList.toggle("on", !locked);
  }
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
document.querySelector("#btn-export")?.addEventListener("click", () => {
  downloadPlacements();
});

document.querySelector("#sun-dawn")?.addEventListener("click", () => {
  applySun(SUN_PRESETS.dawn.azimuth, SUN_PRESETS.dawn.elevation, false);
});
document.querySelector("#sun-noon")?.addEventListener("click", () => {
  applySun(SUN_PRESETS.noon.azimuth, SUN_PRESETS.noon.elevation, false);
});
document.querySelector("#sun-afternoon")?.addEventListener("click", () => {
  applySun(SUN_PRESETS.afternoon.azimuth, SUN_PRESETS.afternoon.elevation, false);
});
document.querySelector("#sun-sunset")?.addEventListener("click", () => {
  applySun(SUN_PRESETS.sunset.azimuth, SUN_PRESETS.sunset.elevation, false);
});
document.querySelector("#sun-night")?.addEventListener("click", () => {
  applySun(SUN_PRESETS.night.azimuth, SUN_PRESETS.night.elevation, false);
});
document.querySelector("#sun-now")?.addEventListener("click", () => {
  applyClockSun();
});

window.setInterval(() => {
  if (sunFollowClock) {
    applyClockSun();
  }
}, 30000);

window.addEventListener("error", (ev) => {
  setStatus(`window error: ${ev.message}`, true);
});
window.addEventListener("unhandledrejection", (ev) => {
  setStatus(`unhandled: ${String(ev.reason)}`, true);
});

mountCard();
renderToggles();
applyClockSun();
void probeAssets();
