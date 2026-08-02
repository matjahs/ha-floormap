import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant, LovelaceCard } from "custom-card-helpers";
import type {
  FloorplanManifest,
  MarkerState,
  RenderManifest,
  SunflowFloorplanCardConfig,
} from "./types";
import { validateConfig, stubConfig } from "./config";
import type { FloorplanIR } from "./import/ir";
import { assertIR } from "./import/ir";
import { selectCamera, projectToPercent } from "./projection";
import { preloadImages, idlePrefetch } from "./preload";
import { BakedCompositor } from "./renderer/baked/compositor";
import { renderCssFallback } from "./renderer/baked/css-fallback";
import { LightStateAnimator, entityToLightParams, mergeOverride } from "./renderer/shared/state";
import { dispatchMarkerAction } from "./renderer/shared/markers";
import { buildRoomHotspots, hitTestRoom, type RoomHotspot } from "./renderer/shared/rooms";
import type { Live3dHandle } from "./renderer/live3d/scene";

export const CARD_TYPE = "sunflow-floorplan-card";

@customElement(CARD_TYPE)
export class SunflowFloorplanCard extends LitElement implements LovelaceCard {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private _config!: SunflowFloorplanCardConfig;
  @state() private _ir: FloorplanIR | null = null;
  @state() private _renders: RenderManifest | null = null;
  @state() private _error: string | null = null;
  @state() private _missing: string[] = [];
  @state() private _floorIndex = 0;
  @state() private _useCssFallback = false;
  @state() private _markers: MarkerState[] = [];

  private _compositor: BakedCompositor | null = null;
  private _animator = new LightStateAnimator();
  private _live3d: Live3dHandle | null = null;
  private _hotspots: RoomHotspot[] = [];
  private _images = new Map<string, HTMLImageElement>();

  public static async getConfigElement() {
    await import("./editor/index");
    return document.createElement("sunflow-floorplan-card-editor");
  }

  public static getStubConfig(): SunflowFloorplanCardConfig {
    return stubConfig();
  }

  public setConfig(config: SunflowFloorplanCardConfig): void {
    this._config = validateConfig(config);
    this._error = null;
    void this._load();
  }

  public getCardSize(): number {
    return 6;
  }

  public getGridOptions() {
    return {
      columns: 12,
      rows: 6,
      min_columns: 6,
      min_rows: 3,
    };
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this._animator.setOnFrame(() => this._paint());
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._animator.dispose();
    this._compositor?.dispose();
    this._compositor = null;
    this._live3d?.dispose();
    this._live3d = null;
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("hass") && this._config) {
      this._syncHassState();
    }
  }

  private async _load(): Promise<void> {
    try {
      let ir = this._config.ir ? assertIR(this._config.ir) : null;
      let renders = this._config.renders ?? null;

      if (this._config.manifest) {
        const res = await fetch(this._config.manifest);
        if (!res.ok) {
          throw new Error(`Failed to load manifest: ${res.status}`);
        }
        const data = (await res.json()) as FloorplanManifest;
        ir = assertIR(data.ir);
        renders = data.renders;
      }

      this._ir = ir;
      this._renders = renders;

      const mode = this._config.render?.mode ?? "baked";
      if (mode === "live3d") {
        await this._initLive3d();
      } else {
        await this._initBaked();
      }
      this._syncHassState(true);
      this._rebuildMarkers();
    } catch (e) {
      this._error = e instanceof Error ? e.message : String(e);
    }
  }

  private async _initBaked(): Promise<void> {
    const renders = this._renders;
    if (!renders?.base) {
      // Allow marker-only mode without renders
      return;
    }
    const urls = [renders.base, ...renders.passes.map((p) => this._resolveOverlay(p.path))];
    idlePrefetch(urls);
    this._images = await preloadImages(urls);

    const canvas = this.renderRoot?.querySelector("canvas.sf-gl") as HTMLCanvasElement | null;
    this._compositor?.dispose();
    this._compositor = new BakedCompositor(canvas ?? undefined);
    if (!this._compositor.available) {
      this._useCssFallback = true;
      return;
    }
    this._useCssFallback = false;
    const baseImg = this._images.get(renders.base);
    if (!baseImg) {
      throw new Error(`Base image failed to load: ${renders.base}`);
    }
    await this._compositor.setBase(baseImg);
    this._compositor.clearLayers();
    this._compositor.setOptions({
      toneMap: this._config.render?.tone_map ?? "aces",
      exposure: this._config.render?.exposure ?? 1,
      differenceBaked: renders.differenceBaked ?? false,
    });

    for (const pass of renders.passes) {
      const url = this._resolveOverlay(pass.path);
      const img = this._images.get(url);
      if (img) {
        this._compositor.addLayer(pass.fixtureId, img);
      }
    }
    this._attachCanvas();
  }

  private _resolveOverlay(path: string): string {
    if (path.startsWith("/") || path.startsWith("http")) {
      return path;
    }
    const base = this._renders?.base ?? "";
    const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "/local/floorplan/";
    return dir + path;
  }

  private _attachCanvas(): void {
    requestAnimationFrame(() => {
      const host = this.renderRoot?.querySelector(".sf-canvas-host") as HTMLElement | null;
      if (host && this._compositor && !host.contains(this._compositor.canvas)) {
        this._compositor.canvas.className = "sf-gl";
        host.replaceChildren(this._compositor.canvas);
      }
      this._paint();
    });
  }

  private async _initLive3d(): Promise<void> {
    if (!this._ir) {
      throw new Error("live3d mode requires IR (manifest or inline ir)");
    }
    await this.updateComplete;
    const canvas = document.createElement("canvas");
    canvas.className = "sf-gl";
    const cam = this._currentCamera();
    this._live3d?.dispose();
    const { createLive3dRenderer } = await import("./renderer/live3d/scene");
    this._live3d = await createLive3dRenderer(this._ir, canvas, cam);
    const host = this.renderRoot?.querySelector(".sf-canvas-host") as HTMLElement | null;
    if (host) {
      host.replaceChildren(canvas);
      const rect = host.getBoundingClientRect();
      this._live3d.resize(Math.max(1, rect.width), Math.max(1, rect.height * (405 / 720)));
    }
  }

  private _currentCamera() {
    const floors = this._config.floors ?? [];
    const floor = floors[this._floorIndex];
    return this._ir ? selectCamera(this._ir.cameras, floor?.camera) : undefined;
  }

  private _currentLevelId(): string | undefined {
    const floors = this._config.floors ?? [];
    return floors[this._floorIndex]?.level ?? this._ir?.levels[0]?.id;
  }

  private _aspect(): number {
    const res = this._renders?.resolution;
    if (res) {
      return res.width / res.height;
    }
    const env = this._ir?.environment;
    if (env?.photoWidth && env?.photoHeight) {
      return env.photoWidth / env.photoHeight;
    }
    return 720 / 405;
  }

  private _rebuildMarkers(): void {
    const ir = this._ir;
    const cam = this._currentCamera();
    const entities = this._config.entities ?? {};
    const overrides = this._config.overrides ?? {};
    const markers: MarkerState[] = [];
    const aspect = this._aspect();

    for (const [fixtureId, ent] of Object.entries(entities)) {
      const fixture = ir?.fixtures.find((f) => f.id === fixtureId);
      const o = overrides[fixtureId];
      let left = o?.marker?.[0];
      let top = o?.marker?.[1];
      if ((left === undefined || top === undefined) && fixture && cam) {
        const pct = projectToPercent(cam, fixture.position, { aspect });
        left = pct.left;
        top = pct.top;
      }
      if (left === undefined || top === undefined) {
        continue;
      }
      const params =
        this._animator.get(fixtureId) ??
        entityToLightParams(this.hass?.states?.[ent.entity], {
          gamma: this._config.render?.gamma,
          ...mergeOverride({ power: fixture?.power }, o),
        });
      markers.push({
        fixtureId,
        entity: ent.entity,
        left,
        top,
        params,
        friendlyName: this.hass?.states?.[ent.entity]?.attributes?.friendly_name as
          | string
          | undefined,
      });
    }
    this._markers = markers;

    if (ir && cam) {
      this._hotspots = buildRoomHotspots(ir, cam, aspect, this._currentLevelId());
    }
  }

  private _syncHassState(snap = false): void {
    if (!this._config?.entities || !this.hass) {
      return;
    }
    const missing: string[] = [];
    const transition = this._config.render?.transition ?? 400;
    const gamma = this._config.render?.gamma ?? 2.2;

    for (const [fixtureId, ent] of Object.entries(this._config.entities)) {
      const st = this.hass.states[ent.entity];
      if (!st) {
        missing.push(ent.entity);
      }
      const fixture = this._ir?.fixtures.find((f) => f.id === fixtureId);
      const o = this._config.overrides?.[fixtureId];
      const merged = mergeOverride({ power: fixture?.power }, o);
      const params = entityToLightParams(st, { ...merged, gamma });
      if (snap) {
        this._animator.snap(fixtureId, params);
      } else {
        this._animator.setTarget(fixtureId, params, transition);
      }
      this._live3d?.setLight(fixtureId, params);
    }
    this._missing = missing;
    this._rebuildMarkers();
    this._paint();
  }

  private _paint(): void {
    const params = this._animator.getAll();
    if (this._compositor?.available) {
      this._compositor.render(params);
    }
    this._live3d?.render();
    this._rebuildMarkers();
    this.requestUpdate();
  }

  private _onMarkerAction(action: string, _entity: string, fixtureId: string): void {
    if (!this.hass) {
      return;
    }
    const ent = this._config.entities?.[fixtureId];
    if (!ent) {
      return;
    }
    // Optimistic toggle
    if (action === "tap") {
      const cur = this._animator.get(fixtureId);
      if (cur) {
        const next = {
          ...cur,
          on: !cur.on,
          intensity: cur.on ? 0 : Math.max(cur.intensity, 0.5),
        };
        this._animator.setTarget(fixtureId, next, this._config.render?.transition ?? 400);
        this._paint();
      }
    }
    dispatchMarkerAction(this, this.hass, ent, action);
  }

  private _onStageClick(ev: MouseEvent): void {
    const stage = ev.currentTarget as HTMLElement;
    const rect = stage.getBoundingClientRect();
    const u = (ev.clientX - rect.left) / rect.width;
    const v = (ev.clientY - rect.top) / rect.height;
    const hit = hitTestRoom(this._hotspots, u, v);
    if (!hit || !this.hass) {
      return;
    }
    const area = hit.areaId;
    const ents = Object.values(this._config.entities ?? {})
      .map((e) => e.entity)
      .filter((id) => {
        const st = this.hass.states[id];
        const areaId = (st?.attributes as { area_id?: string } | undefined)?.area_id;
        return area && (areaId === area || st?.entity_id.includes(area));
      });
    if (ents.length === 0) {
      return;
    }
    void this.hass.callService("light", "toggle", { entity_id: ents });
  }

  private _allOff(): void {
    if (!this.hass) {
      return;
    }
    const ids = Object.values(this._config.entities ?? {}).map((e) => e.entity);
    void this.hass.callService("light", "turn_off", { entity_id: ids });
  }

  protected override render() {
    if (this._error) {
      return html`<ha-alert alert-type="error">${this._error}</ha-alert>`;
    }
    if (!this._config) {
      return nothing;
    }

    const aspect = this._aspect();
    const floors = this._config.floors ?? [];
    const showBadge = this._config.show_warning_badge !== false && this._missing.length > 0;
    const params = this._animator.getAll();
    const mode = this._config.render?.mode ?? "baked";

    return html`
      ${this._config.title
        ? html`<div class="sf-title">${this._config.title}</div>`
        : nothing}
      ${floors.length > 1
        ? html`
            <div class="sf-floors">
              ${floors.map(
                (f, i) => html`
                  <button
                    class=${i === this._floorIndex ? "active" : ""}
                    @click=${() => {
                      this._floorIndex = i;
                      this._rebuildMarkers();
                      const cam = this._currentCamera();
                      if (cam) {
                        this._live3d?.setCamera(cam);
                      }
                    }}
                  >
                    ${f.level}
                  </button>
                `,
              )}
            </div>
          `
        : nothing}
      ${showBadge
        ? html`<div class="sf-badge" title=${this._missing.join(", ")}>
            ${this._missing.length} entities not found
          </div>`
        : nothing}
      <div class="sf-stage" style="aspect-ratio: ${aspect}" @click=${this._onStageClick}>
        ${mode === "baked" && this._useCssFallback && this._renders
          ? renderCssFallback(
              this._renders.base,
              this._renders.passes.map((p) => ({
                fixtureId: p.fixtureId,
                url: this._resolveOverlay(p.path),
              })),
              params,
              aspect,
            )
          : html`<div class="sf-canvas-host"></div>`}
        <div class="sf-markers">
          ${this._markers.map(
            (m) => html`
              <button
                class="sf-marker ${m.params.unavailable || m.params.unknown
                  ? "sf-marker-warn"
                  : ""}"
                style="left:${m.left}%;top:${m.top}%"
                title=${m.friendlyName ?? m.entity}
                @click=${(ev: Event) => {
                  ev.stopPropagation();
                  this._onMarkerAction("tap", m.entity, m.fixtureId);
                }}
              >
                <span class="sf-dot" style="opacity:${m.params.on ? 1 : 0.35}"></span>
                ${m.params.on
                  ? html`<span class="sf-pct">${Math.round(m.params.intensity * 100)}%</span>`
                  : nothing}
              </button>
            `,
          )}
        </div>
      </div>
      <div class="sf-controls">
        <button @click=${this._allOff}>All off</button>
      </div>
    `;
  }

  protected override firstUpdated(): void {
    if ((this._config.render?.mode ?? "baked") === "baked" && this._compositor) {
      this._attachCanvas();
    }
  }

  static override styles = css`
    :host {
      display: block;
      color: var(--primary-text-color);
    }
    .sf-title {
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    .sf-floors {
      display: flex;
      gap: 0.35rem;
      margin-bottom: 0.5rem;
    }
    .sf-floors button {
      min-height: 44px;
      padding: 0 0.75rem;
      border-radius: 8px;
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: inherit;
      cursor: pointer;
    }
    .sf-floors button.active {
      background: var(--primary-color);
      color: var(--text-primary-color, #fff);
    }
    .sf-badge {
      background: var(--warning-color, #f4b400);
      color: #111;
      padding: 0.25rem 0.5rem;
      border-radius: 6px;
      font-size: 0.85rem;
      margin-bottom: 0.5rem;
    }
    .sf-stage {
      position: relative;
      width: 100%;
      background: #111;
      border-radius: 8px;
      overflow: hidden;
    }
    .sf-canvas-host,
    .sf-gl {
      width: 100%;
      height: 100%;
      display: block;
    }
    .sf-markers {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .sf-marker {
      pointer-events: auto;
      position: absolute;
      transform: translate(-50%, -50%);
      min-width: 44px;
      min-height: 44px;
      border: none;
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.45);
      color: #fff;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 4px;
    }
    .sf-marker-warn {
      outline: 2px solid var(--error-color, #db4437);
    }
    .sf-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #ffe08a;
    }
    .sf-pct {
      font-size: 0.65rem;
      line-height: 1;
    }
    .sf-controls {
      margin-top: 0.5rem;
      display: flex;
      gap: 0.5rem;
    }
    .sf-controls button {
      min-height: 44px;
      padding: 0 0.85rem;
      border-radius: 8px;
      border: 1px solid var(--divider-color);
      background: var(--secondary-background-color);
      color: inherit;
      cursor: pointer;
    }
    .sf-css-stack {
      position: relative;
      width: 100%;
      overflow: hidden;
    }
    .sf-css-base,
    .sf-css-layer {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      pointer-events: none;
    }
    .sf-css-base {
      position: relative;
    }
  `;
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TYPE,
  name: "Sunflow Floorplan",
  description: "Dynamic floorplan lighting from SweetHome3D / baked light passes",
  preview: true,
  documentationURL: "https://github.com/matjahs/ha-floormap",
});

declare global {
  interface HTMLElementTagNameMap {
    "sunflow-floorplan-card": SunflowFloorplanCard;
  }
}
