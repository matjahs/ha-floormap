import type { HomeAssistant } from "custom-card-helpers";
import type { SunflowFloorplanCardConfig } from "../src/types";
import { CARD_TYPE, SunflowFloorplanCard } from "../src/card";
import { overridesToPlacements } from "../src/pose";
import { entityIdsFromConfig, playgroundConfig } from "./playground-config";
import { MockHass, registerHaStubs } from "./mock-hass";

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

function refreshExport(): void {
  if (!exportEl) {
    return;
  }
  const placements = overridesToPlacements(liveConfig.overrides);
  exportEl.value = JSON.stringify(placements, null, 2);
}

function mountCard(): void {
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
  refreshExport();
  setStatus(
    [
      `mode: ${liveConfig.render?.mode}`,
      `edit_mode: ${liveConfig.edit_mode}`,
      `entities: ${entityIds.length}`,
      `WebGL2: ${!!document.createElement("canvas").getContext("webgl2")}`,
    ].join("\n"),
  );
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
document.querySelector("#btn-export")?.addEventListener("click", () => {
  downloadPlacements();
});

window.addEventListener("error", (ev) => {
  setStatus(`window error: ${ev.message}`, true);
});
window.addEventListener("unhandledrejection", (ev) => {
  setStatus(`unhandled: ${String(ev.reason)}`, true);
});

mountCard();
renderToggles();
void probeAssets();
