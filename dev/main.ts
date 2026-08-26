/// <reference types="vite/client" />
import type { HomeAssistant } from "custom-card-helpers";
import type { SunflowFloorplanCardConfig } from "../src/types";
import type { Live3dDebugInfo } from "../src/renderer/live3d/scene";
import { CARD_TYPE, SunflowFloorplanCard } from "../src/card";
import { overridesToPlacements } from "../src/pose";
import { entityIdsFromConfig, playgroundConfig } from "./playground-config";
import { MockHass, registerHaStubs } from "./mock-hass";
import { approximateSun, playgroundSunPresets } from "../src/sun";
import { mountCompassOverlay } from "./compass-overlay";

const SUN_PRESETS = playgroundSunPresets();

function labelSunPreset(key: keyof typeof SUN_PRESETS, fallback: string): string {
  if (key === "afternoon") {
    return "16:12";
  }
  const labels: Record<string, string> = {
    dawn: "07:00",
    noon: "13:00",
    sunset: "20:00",
    night: "23:00",
  };
  const time = labels[key] ?? "";
  return time ? `${fallback} ${time}` : fallback;
}

function wireSunPresetButtons(): void {
  const map: Array<[string, keyof typeof SUN_PRESETS]> = [
    ["#sun-dawn", "dawn"],
    ["#sun-noon", "noon"],
    ["#sun-afternoon", "afternoon"],
    ["#sun-sunset", "sunset"],
    ["#sun-night", "night"],
  ];
  for (const [sel, key] of map) {
    const btn = document.querySelector(sel) as HTMLButtonElement | null;
    if (!btn) {
      continue;
    }
    const base = btn.textContent?.replace(/\s+\d{2}:\d{2}$/, "") ?? key;
    btn.textContent = labelSunPreset(key, base);
  }
}

/** Summer reference day at Waalbandijk — 15‑minute steps for a smooth 24h lap. */
const TIMELAPSE_STEPS = 96;
const TIMELAPSE_MS = 110;
const TIMELAPSE_DAY = "2026-08-24";
const TIMELAPSE_TZ = "+02:00";

let timelapseTimer: number | null = null;
let timelapseStep = 0;
let timelapseClockLabel = "";
const sunTimelapseBtn = document.querySelector("#sun-timelapse") as HTMLButtonElement | null;
const sunScrub = document.querySelector("#sun-scrub") as HTMLInputElement | null;
const sunClockEl = document.querySelector("#sun-clock") as HTMLElement | null;
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

let sunFollowClock = true;
const sunStatusEl = document.querySelector("#sun-status") as HTMLElement | null;
const sunProbesEl = document.querySelector("#sun-probes") as HTMLElement | null;

function refreshSunProbes(): void {
  if (!sunProbesEl || !card) {
    return;
  }
  const probes = card.getSunProbes();
  if (probes.length === 0) {
    sunProbesEl.textContent = "(geen probes — Babylon + scene_glb vereist)";
    return;
  }
  const lit = probes.filter((p) => p.receivesSun);
  const ext = probes.filter((p) => p.side === "exterior");
  const extLit = ext.filter((p) => p.receivesSun);
  const lines = [
    `lit ${lit.length}/${probes.length} (buitenblad ${extLit.length}/${ext.length})`,
    ...probes.map((p) => {
      const flag = p.receivesSun ? "YES" : p.facingSun ? "occ" : "no ";
      const short = p.wallName.replace(/^Wall_\d+\s+/, "").slice(0, 28);
      return `${flag} ${p.side[0]} ${short}  n·L=${p.ndotL.toFixed(2)}`;
    }),
  ];
  sunProbesEl.textContent = lines.join("\n");
}

function refreshSunStatus(): void {
  const st = mock.states["sun.sun"];
  const az = Number(st?.attributes.azimuth ?? 0);
  const el = Number(st?.attributes.elevation ?? 0);
  if (sunStatusEl) {
    const mode = timelapseTimer !== null
      ? " (24h lap)"
      : sunFollowClock
        ? " (clock)"
        : "";
    const clock = timelapseClockLabel ? ` · ${timelapseClockLabel}` : "";
    sunStatusEl.textContent = `${st?.state ?? "?"} · azimuth ${az.toFixed(0)}° · elevation ${el.toFixed(0)}°${clock}${mode}`;
  }
  if (sunClockEl && timelapseClockLabel) {
    sunClockEl.textContent = timelapseClockLabel;
  }
  if (sunScrub && document.activeElement !== sunScrub) {
    sunScrub.value = String(timelapseStep);
  }
  if (sunTimelapseBtn) {
    const playing = timelapseTimer !== null;
    sunTimelapseBtn.textContent = playing ? "Stop lap" : "24h lap";
    sunTimelapseBtn.classList.toggle("on", playing);
  }
  // Card applies sun asynchronously via hass; probe readout one frame later.
  window.requestAnimationFrame(() => refreshSunProbes());
}

function applySun(azimuth: number, elevation: number, followClock: boolean): void {
  sunFollowClock = followClock;
  mock.setSun(azimuth, elevation);
  refreshSunStatus();
}

function applyClockSun(): void {
  stopSunTimelapse();
  timelapseClockLabel = "";
  const pose = approximateSun(new Date());
  applySun(pose.azimuth, pose.elevation, true);
}

function timelapseDateForStep(step: number): Date {
  const minutes = ((step % TIMELAPSE_STEPS) * (24 * 60)) / TIMELAPSE_STEPS;
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return new Date(
    `${TIMELAPSE_DAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${TIMELAPSE_TZ}`,
  );
}

function formatTimelapseClock(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${TIMELAPSE_DAY} ${hh}:${mm}`;
}

function applyTimelapseStep(step: number, keepPlaying: boolean): void {
  timelapseStep = ((step % TIMELAPSE_STEPS) + TIMELAPSE_STEPS) % TIMELAPSE_STEPS;
  const d = timelapseDateForStep(timelapseStep);
  timelapseClockLabel = formatTimelapseClock(d);
  const pose = approximateSun(d);
  applySun(pose.azimuth, pose.elevation, false);
  if (!keepPlaying && timelapseTimer === null) {
    refreshSunStatus();
  }
}

function stopSunTimelapse(): void {
  if (timelapseTimer !== null) {
    window.clearInterval(timelapseTimer);
    timelapseTimer = null;
  }
  if (sunTimelapseBtn) {
    sunTimelapseBtn.textContent = "24h lap";
    sunTimelapseBtn.classList.remove("on");
  }
}

function startSunTimelapse(): void {
  stopSunTimelapse();
  // Fixtures off so window sun / ambient read clearly.
  for (const id of entityIds) {
    mock.setState(id, false);
  }
  applyTimelapseStep(timelapseStep, true);
  timelapseTimer = window.setInterval(() => {
    applyTimelapseStep(timelapseStep + 1, true);
  }, TIMELAPSE_MS);
  refreshSunStatus();
}

function toggleSunTimelapse(): void {
  if (timelapseTimer !== null) {
    stopSunTimelapse();
    refreshSunStatus();
    return;
  }
  startSunTimelapse();
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

let disposeCompass: (() => void) | null = null;

function mountCard(): void {
  disposeCompass?.();
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
  disposeCompass = mountCompassOverlay(stageEl, { getCard: () => card });
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

document.querySelector("#sun-dawn")?.addEventListener("click", () => {
  stopSunTimelapse();
  timelapseClockLabel = "";
  applySun(SUN_PRESETS.dawn.azimuth, SUN_PRESETS.dawn.elevation, false);
});
document.querySelector("#sun-noon")?.addEventListener("click", () => {
  stopSunTimelapse();
  timelapseClockLabel = "";
  applySun(SUN_PRESETS.noon.azimuth, SUN_PRESETS.noon.elevation, false);
});
document.querySelector("#sun-afternoon")?.addEventListener("click", () => {
  stopSunTimelapse();
  timelapseClockLabel = "";
  applySun(SUN_PRESETS.afternoon.azimuth, SUN_PRESETS.afternoon.elevation, false);
});
document.querySelector("#sun-sunset")?.addEventListener("click", () => {
  stopSunTimelapse();
  timelapseClockLabel = "";
  applySun(SUN_PRESETS.sunset.azimuth, SUN_PRESETS.sunset.elevation, false);
});
document.querySelector("#sun-night")?.addEventListener("click", () => {
  stopSunTimelapse();
  timelapseClockLabel = "";
  applySun(SUN_PRESETS.night.azimuth, SUN_PRESETS.night.elevation, false);
});
document.querySelector("#sun-now")?.addEventListener("click", () => {
  applyClockSun();
});
sunTimelapseBtn?.addEventListener("click", () => {
  toggleSunTimelapse();
});
sunScrub?.addEventListener("input", () => {
  stopSunTimelapse();
  const step = Number(sunScrub.value);
  applyTimelapseStep(Number.isFinite(step) ? step : 0, false);
});

ambientFillSlider?.addEventListener("input", () => {
  const scale = Number(ambientFillSlider.value);
  const clamped = Number.isFinite(scale) ? Math.max(0, Math.min(4, scale)) : 1;
  if (ambientFillValue) {
    ambientFillValue.textContent = `${clamped.toFixed(2)}×`;
  }
  card?.setAmbientFillScale(clamped);
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

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stopSunTimelapse();
    disposeCompass?.();
    card?.remove();
    card = null;
  });
}

mountCard();
renderToggles();
wireSunPresetButtons();
applyClockSun();
void probeAssets();
