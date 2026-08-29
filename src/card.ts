import { LitElement, css, html, svg, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { HomeAssistant, LovelaceCard } from "custom-card-helpers";
import { fireEvent } from "custom-card-helpers";
import type {
  FixtureOverride,
  FloorplanManifest,
  MarkerState,
  RenderManifest,
  SunflowFloorplanCardConfig,
  Vec3,
} from "./types";
import { validateConfig, stubConfig } from "./config";
import type { FloorplanIR } from "./import/ir";
import { assertIR } from "./import/ir";
import { importFml } from "./import/fml";
import {
  importBlenderScene,
  mergeEntitiesFromBlenderFixtures,
} from "./import/blender";
import { selectCamera, projectToPercent } from "./projection";
import {
  mergePlacementsIntoOverrides,
  positionTuple,
  resolveFixturePose,
  type PlacementsFile,
} from "./pose";
import {
  buildGroupTapHotspots,
  clientToStagePercent,
  discoverGroupIds,
  findGroupConfig,
  groupHue,
  hitTapEdge,
  hitTapVertex,
  hitTestGroupTap,
  memberEntitiesForGroup,
  type GroupTapHotspot,
} from "./groups";
import { normalizeRoomId, resolveEntityRoom } from "./ha-room";
import {
  averageStripParams,
  paramsForStripSamples,
  resolveFixtureKind,
  resolveStripEnd,
  resolveStripSamples,
  segmentMidpoint,
} from "./strip";
import { preloadImages, idlePrefetch } from "./preload";
import { BakedCompositor } from "./renderer/baked/compositor";
import { renderCssFallback } from "./renderer/baked/css-fallback";
import { LightStateAnimator, entityToLightParams, mergeOverride } from "./renderer/shared/state";
import { dispatchMarkerAction, isDefaultToggleAction } from "./renderer/shared/markers";
import {
  buildRoomHotspots,
  buildRoomHotspotsLive3d,
  hitTestRoom,
  roomDisplayName,
  type RoomHotspot,
} from "./renderer/shared/rooms";
import type { Live3dHandle, Live3dDebugInfo } from "./renderer/live3d/scene";
import { resolvePlanNorthDeg, resolveCardFloorSun, sunShadingFromHass } from "./sun";

export const CARD_TYPE = "sunflow-floorplan-card";

/** Register once — HA can load the module via resources and cache/reload races. */
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
  @state() private _editing = false;
  /** Draw group tap_area polygons on the stage (edit_mode). */
  @state() private _drawingTap = false;
  @state() private _drawingGroupId: string | null = null;
  @state() private _draftTapPoints: [number, number][] = [];
  /** Cursor position in stage % while drawing (rubber-band). */
  @state() private _drawCursor: [number, number] | null = null;
  /** Index of the tap vertex currently being dragged, if any. */
  @state() private _dragTapIndex: number | null = null;
  /** live3d requested but WebGL unavailable — marker-only preview */
  @state() private _live3dFallback = false;
  /** Confirm before turning a whole room on/off (floor tap, chip, or drawn area). */
  @state() private _roomPrompt: { groupId: string; entities: string[] } | null = null;

  private _compositor: BakedCompositor | null = null;
  private _animator = new LightStateAnimator();
  private _live3d: Live3dHandle | null = null;
  private _live3dFrameId = 0;
  /** Last live3d backing-store size — avoid redundant engine.setSize on WebGPU. */
  private _live3dViewport: { width: number; height: number } | null = null;
  /** Stable DOM node — Lit re-parents but never destroys it (WebGPU canvas must stay mounted). */
  private readonly _canvasHostEl: HTMLDivElement = document.createElement("div");
  private _hotspots: RoomHotspot[] = [];
  private _groupTapHotspots: GroupTapHotspot[] = [];
  private _images = new Map<string, HTMLImageElement>();
  /** Last-click tracking for crude double-tap detection */
  private _lastTapAt = 0;
  private _lastTapFixture = "";
  /** Marker press tracking for touch tap / long-press */
  private _markerPress: {
    key: string;
    fixtureId: string;
    segmentIndex?: number;
    x: number;
    y: number;
    startedAt: number;
    holdTimer: number;
    held: boolean;
  } | null = null;
  private _dragFixture: string | null = null;
  private _dragMoved = false;
  private _boundPointerDown = (ev: PointerEvent) => this._onPointerDown(ev);
  private _boundPointerMove = (ev: PointerEvent) => this._onPointerMove(ev);
  private _boundPointerUp = (ev: PointerEvent) => this._onPointerUp(ev);

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
    this._editing = false;
    this._drawingTap = false;
    this._drawingGroupId = null;
    this._draftTapPoints = [];
    this._drawCursor = null;
    this._dragTapIndex = null;
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

  /** Playground debug: geographic N vs plan +Y on screen. */
  public getCompassBearings(): import("./compass").CompassBearings | null {
    return this._live3d?.getCompassBearings() ?? null;
  }

  /** Playground debug: exterior wall face sun sensors. */
  public getSunProbes(): import("./sun-probes").SunProbeReading[] {
    return this._live3d?.getSunProbes() ?? [];
  }

  /** Playground: scale hemisphere / fill / IBL ambient (1 = default). */
  public setAmbientFillScale(scale: number): void {
    this._live3d?.setAmbientFillScale(scale);
    this._live3d?.render();
  }

  /** Playground debug: active WebGPU/WebGL backend after live3d init. */
  public getLive3dDebug(): Live3dDebugInfo {
    return {
      ready: !!this._live3d,
      fallback: this._live3dFallback,
      backend: this._live3d?.rendererBackend ?? null,
      engine: this._config?.render?.engine ?? "three",
      requestedGpu: this._config?.render?.gpu ?? "webgpu",
      error: this._error,
    };
  }

  private _emitLive3dStatus(): void {
    this.dispatchEvent(
      new CustomEvent("live3d-status", {
        bubbles: true,
        composed: true,
        detail: this.getLive3dDebug(),
      }),
    );
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this._canvasHostEl.className = "sf-canvas-host";
    this._animator.setOnFrame(() => this._paint());
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._detachEditListeners();
    this._stopLive3dLoop();
    this._animator.dispose();
    this._compositor?.dispose();
    this._compositor = null;
    this._live3d?.dispose();
    this._live3d = null;
    this._live3dViewport = null;
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("hass") && this._config) {
      // Avoid Lit "change-in-update": hass sync may request a marker re-render.
      queueMicrotask(() => {
        if (this._config) {
          this._syncHassState();
        }
      });
    }
    // Lit clears empty host children on render; re-attach imperative canvas.
    this._ensureCanvasMounted();
  }

  private _usesBabylonRenderLoop(): boolean {
    return (this._config?.render?.engine ?? "three") === "babylon";
  }

  private _live3dHostPixelSize(host: HTMLElement): { width: number; height: number } {
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height || rect.width * (405 / 720)));
    return { width, height };
  }

  private _styleLive3dCanvas(canvas: HTMLCanvasElement): void {
    canvas.style.width = "100%";
    canvas.style.height = "100%";
  }

  /** Set canvas backing store only before the GPU engine is created. */
  private _primeLive3dCanvas(canvas: HTMLCanvasElement, host: HTMLElement): void {
    const { width, height } = this._live3dHostPixelSize(host);
    canvas.width = width;
    canvas.height = height;
    this._styleLive3dCanvas(canvas);
    this._live3dViewport = { width, height };
  }

  /** Resize via engine.setSize — never mutate canvas.width/height after GPU init. */
  private _resizeLive3dIfNeeded(host: HTMLElement): void {
    if (!this._live3d) {
      return;
    }
    const { width, height } = this._live3dHostPixelSize(host);
    const prev = this._live3dViewport;
    if (prev && prev.width === width && prev.height === height) {
      return;
    }
    this._live3d.resize(width, height);
    this._live3dViewport = { width, height };
  }

  private _ensureCanvasMounted(): void {
    const canvas = this._live3d?.canvas ?? this._compositor?.canvas ?? null;
    if (canvas && !this._canvasHostEl.contains(canvas)) {
      canvas.className = "sf-gl";
      this._canvasHostEl.replaceChildren(canvas);
    }
    const stage = this._canvasHostEl.closest(".sf-stage") as HTMLElement | null;
    if (stage && this._live3d) {
      this._resizeLive3dIfNeeded(stage);
      this._syncEditInteraction();
    }
    if (!this._usesBabylonRenderLoop()) {
      this._live3d?.render();
    }
  }

  private _stopLive3dLoop(): void {
    if (this._live3dFrameId) {
      cancelAnimationFrame(this._live3dFrameId);
      this._live3dFrameId = 0;
    }
  }

  private _startLive3dLoop(): void {
    this._stopLive3dLoop();
    const tick = () => {
      this._live3dFrameId = requestAnimationFrame(tick);
      if (!this._live3d) {
        this._stopLive3dLoop();
        return;
      }
      this._live3d.render();
    };
    this._live3dFrameId = requestAnimationFrame(tick);
  }

  private async _load(): Promise<void> {
    try {
      let ir = this._config.ir ? assertIR(this._config.ir) : null;
      let renders = this._config.renders ?? null;
      let overrides = { ...(this._config.overrides ?? {}) };

      if (this._config.manifest) {
        const res = await fetch(this._config.manifest);
        if (!res.ok) {
          throw new Error(`Failed to load manifest: ${res.status}`);
        }
        const data = (await res.json()) as FloorplanManifest;
        ir = assertIR(data.ir);
        renders = data.renders;
      }

      if (this._config.placements) {
        const res = await fetch(this._config.placements, { cache: "no-store" });
        if (res.ok) {
          const placements = (await res.json()) as PlacementsFile;
          overrides = mergePlacementsIntoOverrides(overrides, placements);
          this._config = { ...this._config, overrides };
        }
      }

      if (this._config.scene_glb || this._config.scene) {
        const sceneIr = await this._loadBlenderScene();
        if (!ir) {
          ir = sceneIr;
        } else {
          ir = {
            ...ir,
            walls: [],
            rooms: [],
            furniture: [],
            openings: [],
            fixtures: sceneIr.fixtures,
            cameras: sceneIr.cameras,
            bounds: sceneIr.bounds,
            environment: {
              ...ir.environment,
              ...sceneIr.environment,
            },
            source: sceneIr.source,
          };
        }
      } else if (this._config.fml) {
        const fmlIr = await this._loadFmlScene();
        if (!ir) {
          ir = fmlIr;
        } else {
          // Keep SH3D/light fixtures; swap visual geometry to Floorplanner FML + GLBs.
          ir = {
            ...ir,
            walls: fmlIr.walls,
            rooms: fmlIr.rooms,
            furniture: fmlIr.furniture,
            openings: fmlIr.openings,
            bounds: fmlIr.bounds,
            cameras: [...fmlIr.cameras, ...ir.cameras],
            environment: {
              ...ir.environment,
              ...fmlIr.environment,
            },
            source: {
              ...ir.source,
              kind: "floorplanner-fml",
              file: `${ir.source.file}+${fmlIr.source.file}`,
            },
          };
        }
      }

      this._ir = ir;
      this._renders = renders;
      if (ir?.fixtures?.length) {
        this._config = {
          ...this._config,
          entities: mergeEntitiesFromBlenderFixtures(
            this._config.entities,
            ir.fixtures,
          ),
        };
      }

      const mode = this._config.render?.mode ?? "live3d";
      this._live3dFallback = false;
      if (mode === "live3d") {
        try {
          await this._initLive3d();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/webgl|webgpu|renderer/i.test(msg)) {
            this._live3dFallback = true;
            this._stopLive3dLoop();
            this._live3d?.dispose();
            this._live3d = null;
          } else {
            throw e;
          }
        }
      } else {
        this._stopLive3dLoop();
        await this._initBaked();
      }
      this._syncHassState(true);
      this._rebuildMarkers();
      this.requestUpdate();
      this._emitLive3dStatus();
    } catch (e) {
      this._error = e instanceof Error ? e.message : String(e);
      this._emitLive3dStatus();
    }
  }

  private _sceneSidecarUrl(): string {
    if (this._config.scene) {
      return this._config.scene;
    }
    const glb = this._config.scene_glb;
    if (!glb) {
      throw new Error("scene_glb or scene is required");
    }
    if (/\.glb$/i.test(glb)) {
      return glb.replace(/\.glb$/i, ".scene.json");
    }
    return `${glb}.scene.json`;
  }

  private async _loadBlenderScene(): Promise<FloorplanIR> {
    const url = this._sceneSidecarUrl();
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to load Blender scene: ${res.status} ${url}`);
    }
    const raw = await res.json();
    return importBlenderScene(raw, url.split("/").pop() ?? "appartement.scene.json");
  }

  private async _loadFmlScene(): Promise<FloorplanIR> {
    const url = this._config.fml!;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to load FML: ${res.status}`);
    }
    const raw = await res.json();
    let glbMap: Record<string, string> | undefined;
    if (this._config.fml_glb_map) {
      const mapRes = await fetch(this._config.fml_glb_map);
      if (mapRes.ok) {
        glbMap = (await mapRes.json()) as Record<string, string>;
      }
    }
    let materials: import("./import/fml").FmlMaterialMap | undefined;
    if (this._config.fml_materials) {
      const matRes = await fetch(this._config.fml_materials);
      if (matRes.ok) {
        materials = (await matRes.json()) as import("./import/fml").FmlMaterialMap;
      }
    }
    return importFml(raw, url.split("/").pop() ?? "project.fml", {
      glbMap,
      assetsBase: this._config.fml_assets,
      openingAssets: !!this._config.fml_assets,
      materials,
      defaultFloor: this._config.fml_default_floor
        ? {
          texture: this._config.fml_default_floor.texture,
          tileWidthCm: this._config.fml_default_floor.tile_width_cm,
          tileHeightCm: this._config.fml_default_floor.tile_height_cm,
          excludeNameIncludes: this._config.fml_default_floor.exclude_name_includes,
        }
        : undefined,
      roomFloors: this._config.fml_room_floors?.map((f) => ({
        nameIncludes: f.name_includes,
        texture: f.texture,
        tileWidthCm: f.tile_width_cm,
        tileHeightCm: f.tile_height_cm,
      })),
    });
  }

  private _posesFromConfig(): Record<string, Vec3> {
    const poses: Record<string, Vec3> = {};
    if (!this._ir) {
      return poses;
    }
    for (const fx of this._ir.fixtures) {
      const pose = resolveFixturePose(this._ir, fx.id, this._config.overrides);
      if (pose) {
        poses[fx.id] = pose;
      }
    }
    return poses;
  }

  private _stripEndsFromConfig(): Record<string, Vec3> {
    const ends: Record<string, Vec3> = {};
    if (!this._ir) {
      return ends;
    }
    for (const fx of this._ir.fixtures) {
      const end = resolveStripEnd(this._ir, fx.id, this._config.overrides);
      if (end) {
        ends[fx.id] = end;
      }
    }
    return ends;
  }

  private async _initBaked(): Promise<void> {
    const renders = this._renders;
    if (!renders?.base) {
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
      this._ensureCanvasMounted();
      this._paint();
    });
  }

  /** WebGPU (Babylon/Three) needs the canvas connected before engine init. */
  private _live3dStageEl(): HTMLElement | null {
    return (
      (this._canvasHostEl.closest(".sf-stage") as HTMLElement | null)
      ?? (this.renderRoot?.querySelector(".sf-stage") as HTMLElement | null)
    );
  }

  private _mountLive3dCanvas(canvas: HTMLCanvasElement): void {
    this._canvasHostEl.replaceChildren(canvas);
    const stage = this._live3dStageEl();
    if (stage) {
      this._primeLive3dCanvas(canvas, stage);
    }
  }

  private async _initLive3d(): Promise<void> {
    if (!this._ir) {
      throw new Error("live3d mode requires IR (manifest or inline ir)");
    }
    await this.updateComplete;
    if (!this._canvasHostEl.isConnected) {
      this.requestUpdate();
      await this.updateComplete;
    }
    const canvas = document.createElement("canvas");
    canvas.className = "sf-gl";
    if (!this._canvasHostEl.isConnected) {
      throw new Error("live3d canvas host not mounted — cannot init WebGPU");
    }
    this._mountLive3dCanvas(canvas);
    const cam = this._currentCamera();
    const levelId = this._currentLevelId();
    const elev = this._ir.levels.find((l) => l.id === levelId)?.elevation ?? 0;
    this._live3d?.dispose();
    this._stopLive3dLoop();
    this._live3dViewport = null;
    const { createLive3dRenderer } = await import("./renderer/live3d/scene");
    this._live3d = await createLive3dRenderer(this._ir, canvas, cam, {
      poses: this._posesFromConfig(),
      stripEnds: this._stripEndsFromConfig(),
      levelElevation: elev,
      editableFixtureIds: Object.keys(this._config.entities ?? {}),
      editableFixtureLabels: this._editFixtureLabels().labels,
      editableFixtureRooms: this._editFixtureLabels().rooms,
      sceneGltfUrl: this._config.scene_glb,
      planNorthDeg: resolvePlanNorthDeg(
        this._config?.render?.north,
        this._ir?.environment?.planNorthDeg,
      ),
      gpu: this._config?.render?.gpu ?? "webgpu",
      engine: this._config?.render?.engine ?? "three",
      lockCamera: this._config?.render?.lock_camera !== false,
      homeView: this._homeViewFromConfig(),
      inspector: this._config?.render?.inspector === true,
    });
    this._ensureCanvasMounted();
    const stage = this._canvasHostEl.closest(".sf-stage") as HTMLElement | null;
    if (stage && this._live3d) {
      this._resizeLive3dIfNeeded(stage);
    }
    this._syncEditInteraction();
    this._syncSun();
    if (this._config?.render?.engine !== "babylon") {
      this._startLive3dLoop();
    }
  }

  private _editFixtureLabels(): {
    labels: Record<string, string>;
    rooms: Record<string, string>;
  } {
    const labels: Record<string, string> = {};
    const rooms: Record<string, string> = {};
    for (const [fixtureId, ent] of Object.entries(this._config.entities ?? {})) {
      const friendly = this.hass?.states?.[ent.entity]?.attributes?.friendly_name;
      const raw = typeof friendly === "string" && friendly.trim()
        ? friendly
        : ent.entity;
      const lightName = raw
        .replace(/^light\./i, "")
        .replace(/_/g, " ")
        .trim()
        .slice(0, 28);
      const room = ent.group?.trim()
        ? {
          id: normalizeRoomId(ent.group),
          name: ent.group.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          source: "config" as const,
        }
        : resolveEntityRoom(this.hass, ent.entity);
      if (room) {
        rooms[fixtureId] = room.id;
        labels[fixtureId] = `${room.name.slice(0, 16)} · ${lightName}`.slice(0, 36);
      } else {
        labels[fixtureId] = lightName.slice(0, 32);
      }
    }
    return { labels, rooms };
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

  private _isLive3d(): boolean {
    return (this._config.render?.mode ?? "live3d") === "live3d";
  }

  private _homeViewFromConfig():
    | {
        eye: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
        fovDeg?: number;
      }
    | undefined {
    const hv = this._config.render?.home_view;
    if (!hv?.eye || !hv?.target) {
      return undefined;
    }
    return {
      eye: { x: hv.eye[0], y: hv.eye[1], z: hv.eye[2] },
      target: { x: hv.target[0], y: hv.target[1], z: hv.target[2] },
      fovDeg: hv.fovDeg,
    };
  }

  private _projectMarkerPos(pos: Vec3): { left: number; top: number } | null {
    const live3d = this._isLive3d() && this._live3d && this._cameraLocked();
    if (live3d) {
      const pct = this._live3d!.projectPlanToScreenPercent(pos);
      if (!pct || pct.behind) {
        return null;
      }
      if (pct.left < -5 || pct.left > 105 || pct.top < -5 || pct.top > 105) {
        return null;
      }
      return { left: pct.left, top: pct.top };
    }
    const cam = this._currentCamera();
    if (!cam) {
      return null;
    }
    const pct = projectToPercent(cam, pos, { aspect: this._aspect() });
    return { left: pct.left, top: pct.top };
  }

  private _rebuildMarkers(): void {
    const ir = this._ir;
    const entities = this._config.entities ?? {};
    const overrides = this._config.overrides ?? {};
    const markers: MarkerState[] = [];
    const live3d = this._isLive3d();

    for (const [fixtureId, ent] of Object.entries(entities)) {
      const fixture = ir?.fixtures.find((f) => f.id === fixtureId);
      const o = overrides[fixtureId];
      const kind = resolveFixtureKind(fixture, o);
      const start = resolveFixturePose(ir, fixtureId, overrides);
      const end = resolveStripEnd(ir, fixtureId, overrides);
      const segments = ent.segments;

      if (segments && segments.length > 0 && start && end && kind === "strip") {
        for (let si = 0; si < segments.length; si++) {
          const seg = segments[si]!;
          const mid = segmentMidpoint(start, end, seg);
          let left: number | undefined;
          let top: number | undefined;
          if (!live3d && o?.marker && si === 0) {
            left = o.marker[0];
            top = o.marker[1];
          }
          if (left === undefined || top === undefined) {
            const pct = this._projectMarkerPos(mid);
            if (pct) {
              left = pct.left;
              top = pct.top;
            }
          }
          if (left === undefined || top === undefined) {
            continue;
          }
          const params =
            this._animator.get(`${fixtureId}#${si}`) ??
            entityToLightParams(this.hass?.states?.[seg.entity], {
              gamma: this._config.render?.gamma,
              ...mergeOverride({ power: fixture?.power }, o),
            });
          markers.push({
            fixtureId,
            entity: seg.entity,
            left,
            top,
            params,
            group: ent.group,
            segmentIndex: si,
            friendlyName: this.hass?.states?.[seg.entity]?.attributes?.friendly_name as
              | string
              | undefined,
          });
        }
        continue;
      }

      let left: number | undefined;
      let top: number | undefined;
      if (!live3d && o?.marker) {
        left = o.marker[0];
        top = o.marker[1];
      }
      if ((left === undefined || top === undefined) && start) {
        const pct = this._projectMarkerPos(start);
        if (pct) {
          left = pct.left;
          top = pct.top;
        }
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
        group: ent.group,
        friendlyName: this.hass?.states?.[ent.entity]?.attributes?.friendly_name as
          | string
          | undefined,
      });
    }
    this._markers = markers;
    this._groupTapHotspots = this._hasBlenderRooms()
      ? []
      : buildGroupTapHotspots(this._config.groups);
    this._rebuildRoomHotspots();
  }

  private _hasBlenderRooms(): boolean {
    return (this._ir?.rooms?.length ?? 0) > 0;
  }

  private _rebuildRoomHotspots(): void {
    const ir = this._ir;
    if (!ir?.rooms?.length) {
      this._hotspots = [];
      return;
    }
    const levelId = this._currentLevelId();
    const floorHeightCm =
      typeof this._config.render?.floor_height_m === "number" &&
      this._config.render.floor_height_m > 0
        ? this._config.render.floor_height_m * 100
        : undefined;
    const hotspotOpts = floorHeightCm !== undefined ? { floorHeightCm } : undefined;
    const live3d = this._isLive3d() && this._live3d && this._cameraLocked();
    if (live3d) {
      this._hotspots = buildRoomHotspotsLive3d(
        ir,
        (planPos) => {
          return this._live3d!.projectPlanToScreenPercent(planPos);
        },
        levelId,
        hotspotOpts,
      );
      return;
    }
    const cam = this._currentCamera();
    if (cam) {
      this._hotspots = buildRoomHotspots(ir, cam, this._aspect(), levelId, hotspotOpts);
    } else {
      this._hotspots = [];
    }
  }

  private _syncSun(): void {
    if (!this._live3d) {
      return;
    }
    const ambient = this._config?.render?.ambient ?? "sun";
    const north = resolvePlanNorthDeg(
      this._config?.render?.north,
      this._ir?.environment?.planNorthDeg,
    );
    const floor = resolveCardFloorSun({
      render: this._config?.render,
      environment: this._ir?.environment,
    });
    this._live3d.setSun(
      sunShadingFromHass(
        this.hass,
        ambient,
        north,
        new Date(),
        floor,
        this._config?.render?.mirror_x === true,
      ),
    );
    this._live3d.render();
  }

  private _syncHassState(snap = false): void {
    this._syncSun();
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
      const master = entityToLightParams(st, { ...merged, gamma });
      if (snap) {
        this._animator.snap(fixtureId, master);
      } else {
        this._animator.setTarget(fixtureId, master, transition);
      }

      const kind = resolveFixtureKind(fixture, o);
      const segments = ent.segments;
      if (segments && segments.length > 0 && kind === "strip") {
        const segParams = new Map<number, import("./types").LightParams>();
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i]!;
          const sst = this.hass.states[seg.entity];
          if (!sst) {
            missing.push(seg.entity);
          }
          const sp = entityToLightParams(sst, { ...merged, gamma });
          segParams.set(i, sp);
          const key = `${fixtureId}#${i}`;
          if (snap) {
            this._animator.snap(key, sp);
          } else {
            this._animator.setTarget(key, sp, transition);
          }
        }
        const samples = resolveStripSamples(fixture, o);
        const sampleParams = paramsForStripSamples(samples, segments, segParams, master);
        this._live3d?.setLightSamples(fixtureId, sampleParams);
        // Baked: average segments into the fixture layer
        const avg = averageStripParams(sampleParams);
        if (snap) {
          this._animator.snap(fixtureId, avg);
        } else {
          this._animator.setTarget(fixtureId, avg, transition);
        }
      } else {
        this._live3d?.setLight(fixtureId, master);
      }

      const pose = resolveFixturePose(this._ir, fixtureId, this._config.overrides);
      if (pose) {
        const end = resolveStripEnd(this._ir, fixtureId, this._config.overrides);
        if (end && kind === "strip") {
          this._live3d?.setStripPose(fixtureId, pose, end);
        } else {
          this._live3d?.setLightPosition(fixtureId, pose);
        }
      }
    }
    this._missing = missing;
    this._rebuildMarkers();
    this._paint();
  }

  private _markerSignature(): string {
    return this._markers
      .map(
        (m) =>
          `${m.fixtureId}:${m.params.on ? 1 : 0}:${Math.round(m.params.intensity * 20)}:${m.left.toFixed(1)}:${m.top.toFixed(1)}`,
      )
      .join("|");
  }

  private _paint(): void {
    const params = this._animator.getAll();
    if (this._compositor?.available) {
      this._compositor.render(params);
    }
    this._live3d?.render();
    const before = this._markerSignature();
    this._rebuildMarkers();
    // Skip Lit updates when marker DOM would be identical (prevents canvas host thrash).
    if (before !== this._markerSignature()) {
      queueMicrotask(() => this.requestUpdate());
    }
  }

  private _onMarkerAction(
    action: string,
    fixtureId: string,
    segmentIndex?: number,
  ): void {
    if (this._editing || !this.hass) {
      return;
    }
    const ent = this._config.entities?.[fixtureId];
    if (!ent) {
      return;
    }
    const seg =
      segmentIndex !== undefined ? ent.segments?.[segmentIndex] : undefined;
    const actionConfig = seg
      ? {
          entity: seg.entity,
          tap_action: seg.tap_action ?? ent.tap_action,
          hold_action: seg.hold_action ?? ent.hold_action,
          double_tap_action: seg.double_tap_action ?? ent.double_tap_action,
        }
      : ent;

    if (action === "tap" && isDefaultToggleAction(actionConfig)) {
      const animKey =
        segmentIndex !== undefined ? `${fixtureId}#${segmentIndex}` : fixtureId;
      const cur = this._animator.get(animKey);
      if (cur) {
        const next = {
          ...cur,
          on: !cur.on,
          intensity: cur.on ? 0 : Math.max(cur.intensity, 0.5),
        };
        this._animator.setTarget(animKey, next, this._config.render?.transition ?? 400);
        this._paint();
      }
    }
    dispatchMarkerAction(this, this.hass, actionConfig, action);
  }

  private _onMarkerPointerDown(ev: PointerEvent, m: MarkerState): void {
    if (ev.button !== undefined && ev.button !== 0) {
      return;
    }
    ev.stopPropagation();
    const key = `${m.fixtureId}:${m.segmentIndex ?? -1}`;
    this._clearMarkerPress();
    const holdTimer = window.setTimeout(() => {
      if (!this._markerPress || this._markerPress.key !== key) {
        return;
      }
      this._markerPress.held = true;
      this._onMarkerAction("hold", m.fixtureId, m.segmentIndex);
    }, 500);
    this._markerPress = {
      key,
      fixtureId: m.fixtureId,
      segmentIndex: m.segmentIndex,
      x: ev.clientX,
      y: ev.clientY,
      startedAt: Date.now(),
      holdTimer,
      held: false,
    };
    try {
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    } catch {
      // ignore
    }
  }

  private _onMarkerPointerUp(ev: PointerEvent, m: MarkerState): void {
    ev.stopPropagation();
    const press = this._markerPress;
    const key = `${m.fixtureId}:${m.segmentIndex ?? -1}`;
    if (!press || press.key !== key) {
      return;
    }
    const moved =
      Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 12;
    const held = press.held;
    this._clearMarkerPress();
    if (held || moved) {
      return;
    }
    const now = Date.now();
    if (now - this._lastTapAt < 350 && this._lastTapFixture === key) {
      this._lastTapAt = 0;
      this._onMarkerAction("double_tap", m.fixtureId, m.segmentIndex);
      return;
    }
    this._lastTapAt = now;
    this._lastTapFixture = key;
    this._onMarkerAction("tap", m.fixtureId, m.segmentIndex);
  }

  private _onMarkerPointerCancel(): void {
    this._clearMarkerPress();
  }

  private _clearMarkerPress(): void {
    if (this._markerPress?.holdTimer) {
      window.clearTimeout(this._markerPress.holdTimer);
    }
    this._markerPress = null;
  }

  private _onMarkerContextMenu(ev: Event): void {
    ev.preventDefault();
    ev.stopPropagation();
  }

  private _stagePointerPercent(
    ev: PointerEvent | MouseEvent,
  ): { stage: HTMLElement; rect: DOMRect; point: [number, number] } | null {
    const stage = ev.currentTarget as HTMLElement;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return {
      stage,
      rect,
      point: clientToStagePercent(rect, ev.clientX, ev.clientY),
    };
  }

  private _tapHitThresholds(rect: DOMRect): { vertex: number; edge: number } {
    const px = Math.min(rect.width, rect.height);
    const vertex = Math.max(3.5, (24 / px) * 100);
    return { vertex, edge: Math.max(2, vertex * 0.55) };
  }

  private _beginTapDrag(index: number, stage: HTMLElement, pointerId: number): void {
    this._dragTapIndex = index;
    this._drawCursor = null;
    if (stage.setPointerCapture) {
      stage.setPointerCapture(pointerId);
    }
    stage.style.cursor = "grabbing";
  }

  private _endTapDrag(stage?: HTMLElement): void {
    if (this._dragTapIndex === null) {
      return;
    }
    this._dragTapIndex = null;
    if (stage) {
      stage.style.cursor = "";
    }
    this.requestUpdate();
  }

  private _moveTapPoint(index: number, point: [number, number]): void {
    const next = this._draftTapPoints.slice();
    next[index] = point;
    this._draftTapPoints = next;
  }

  private _removeTapPoint(index: number): void {
    if (index < 0 || index >= this._draftTapPoints.length) {
      return;
    }
    this._draftTapPoints = this._draftTapPoints.filter((_, i) => i !== index);
    if (this._dragTapIndex === index) {
      this._dragTapIndex = null;
    } else if (this._dragTapIndex !== null && this._dragTapIndex > index) {
      this._dragTapIndex -= 1;
    }
    this.requestUpdate();
  }

  private _onStagePointerMove = (ev: PointerEvent): void => {
    if (!this._drawingTap || !this._drawingGroupId) {
      return;
    }
    const hit = this._stagePointerPercent(ev);
    if (!hit) {
      return;
    }
    if (this._dragTapIndex !== null) {
      this._moveTapPoint(this._dragTapIndex, hit.point);
      this.requestUpdate();
      return;
    }
    const { vertex, edge } = this._tapHitThresholds(hit.rect);
    if (hitTapVertex(this._draftTapPoints, hit.point, vertex) >= 0) {
      hit.stage.style.cursor = "grab";
    } else if (hitTapEdge(this._draftTapPoints, hit.point, edge)) {
      hit.stage.style.cursor = "copy";
    } else {
      hit.stage.style.cursor = "";
    }
    const next = hit.point;
    const prev = this._drawCursor;
    if (prev && Math.abs(prev[0] - next[0]) < 0.15 && Math.abs(prev[1] - next[1]) < 0.15) {
      return;
    }
    this._drawCursor = next;
    this.requestUpdate();
  };

  private _onStagePointerLeave = (): void => {
    if (this._dragTapIndex !== null) {
      return;
    }
    if (this._drawCursor === null) {
      return;
    }
    this._drawCursor = null;
    this.requestUpdate();
  };

  private _onStagePointerUp = (ev: PointerEvent): void => {
    if (this._dragTapIndex === null) {
      return;
    }
    this._endTapDrag(ev.currentTarget as HTMLElement);
  };

  private _onStagePointerDown = (ev: PointerEvent): void => {
    if (!this._drawingTap || ev.button !== 0) {
      return;
    }
    if (!this._drawingGroupId) {
      return;
    }
    const hit = this._stagePointerPercent(ev);
    if (!hit) {
      return;
    }
    const { vertex, edge } = this._tapHitThresholds(hit.rect);
    const vtx = hitTapVertex(this._draftTapPoints, hit.point, vertex);
    if (vtx >= 0) {
      this._beginTapDrag(vtx, hit.stage, ev.pointerId);
      ev.preventDefault();
      this.requestUpdate();
      return;
    }
    const edgeHit = hitTapEdge(this._draftTapPoints, hit.point, edge);
    if (edgeHit) {
      const next = this._draftTapPoints.slice();
      next.splice(edgeHit.insertAt, 0, edgeHit.point);
      this._draftTapPoints = next;
      this._beginTapDrag(edgeHit.insertAt, hit.stage, ev.pointerId);
      ev.preventDefault();
      this.requestUpdate();
      return;
    }
    if (this._draftTapPoints.length >= 3) {
      // Closed polygon: empty clicks do not append (use an edge to add).
      return;
    }
    this._draftTapPoints = [...this._draftTapPoints, hit.point];
    this._drawCursor = hit.point;
    ev.preventDefault();
    this.requestUpdate();
  };

  private _onStageDblClick = (ev: MouseEvent): void => {
    if (!this._drawingTap || !this._drawingGroupId) {
      return;
    }
    const hit = this._stagePointerPercent(ev);
    if (!hit) {
      return;
    }
    const { vertex } = this._tapHitThresholds(hit.rect);
    const vtx = hitTapVertex(this._draftTapPoints, hit.point, vertex);
    if (vtx < 0) {
      return;
    }
    ev.preventDefault();
    this._removeTapPoint(vtx);
  };

  private _onStageContextMenu = (ev: MouseEvent): void => {
    if (!this._drawingTap) {
      return;
    }
    ev.preventDefault();
    if (!this._drawingGroupId) {
      return;
    }
    const hit = this._stagePointerPercent(ev);
    if (!hit) {
      return;
    }
    const { vertex } = this._tapHitThresholds(hit.rect);
    const vtx = hitTapVertex(this._draftTapPoints, hit.point, vertex);
    if (vtx >= 0) {
      this._removeTapPoint(vtx);
    }
  };

  private _onStageClick(ev: MouseEvent): void {
    if (this._roomPrompt) {
      return;
    }
    if (this._drawingTap) {
      ev.preventDefault();
      return;
    }
    if (this._editing || this._dragMoved) {
      this._dragMoved = false;
      return;
    }
    const target = ev.target as HTMLElement | null;
    if (target?.closest?.(".sf-marker")) {
      return;
    }
    const stage = ev.currentTarget as HTMLElement;
    const rect = stage.getBoundingClientRect();
    const u = (ev.clientX - rect.left) / rect.width;
    const v = (ev.clientY - rect.top) / rect.height;

    // Floor-mesh rooms (plan-space) take precedence over screen-space group overlays.
    const hit = hitTestRoom(this._hotspots, u, v);
    if (hit && this.hass) {
      if (this._promptRoomControl(hit.room.id)) {
        return;
      }
    }

    const groupHit = hitTestGroupTap(this._groupTapHotspots, u, v);
    if (groupHit && this.hass) {
      this._promptRoomControl(groupHit.groupId);
      return;
    }
  }

  /** Entity ids for fixtures whose plan position lies in a Blender floor room. */
  private _entitiesInFloorRoom(roomId: string): string[] {
    const ir = this._ir;
    if (!ir?.fixtures?.length || !this._config.entities) {
      return [];
    }
    const out: string[] = [];
    for (const fx of ir.fixtures) {
      if (fx.roomId !== roomId) {
        continue;
      }
      const ent = this._config.entities[fx.id];
      if (!ent?.entity) {
        continue;
      }
      out.push(ent.entity);
      for (const seg of ent.segments ?? []) {
        out.push(seg.entity);
      }
    }
    return out;
  }

  private _onGroupChipClick(gid: string, ev: Event): void {
    ev.stopPropagation();
    if (this._drawingTap) {
      this._selectTapGroup(gid);
      return;
    }
    this._promptRoomControl(gid);
  }

  /** Collect lights for a room/group and open the confirm sheet. Returns false if none. */
  private _promptRoomControl(groupId: string): boolean {
    if (!this.hass) {
      return false;
    }
    const entities = this._entitiesForRoomControl(groupId);
    if (entities.length === 0) {
      return false;
    }
    this._roomPrompt = { groupId, entities };
    this.requestUpdate();
    return true;
  }

  private _entitiesForRoomControl(groupId: string): string[] {
    const members = memberEntitiesForGroup(this._config, groupId, this.hass, this._ir);
    if (members.length > 0) {
      return members;
    }
    const floor = this._entitiesInFloorRoom(groupId);
    if (floor.length > 0) {
      return floor;
    }
    const master = findGroupConfig(this._config, groupId)?.entity;
    return master ? [master] : [];
  }

  private _dismissRoomPrompt(): void {
    this._roomPrompt = null;
    this.requestUpdate();
  }

  private _applyRoomPrompt(mode: "on" | "off"): void {
    const prompt = this._roomPrompt;
    if (!prompt || !this.hass) {
      return;
    }
    void this.hass.callService("light", mode === "on" ? "turn_on" : "turn_off", {
      entity_id: prompt.entities,
    });
    this._roomPrompt = null;
    this.requestUpdate();
  }

  private _roomPromptSummary(): { on: number; off: number; total: number } {
    const entities = this._roomPrompt?.entities ?? [];
    let on = 0;
    let off = 0;
    for (const id of entities) {
      const st = this.hass?.states?.[id]?.state;
      if (st === "on") {
        on += 1;
      } else if (st === "off") {
        off += 1;
      }
    }
    return { on, off, total: entities.length };
  }

  private _selectTapGroup(gid: string): void {
    // Persist in-progress draft for the previous group before switching.
    if (
      this._drawingGroupId &&
      this._drawingGroupId !== gid &&
      this._draftTapPoints.length >= 3
    ) {
      this._commitTapArea(this._drawingGroupId, this._draftTapPoints);
    }
    this._drawingGroupId = gid;
    const existing = findGroupConfig(this._config, gid)?.tap_area;
    this._draftTapPoints = existing ? existing.map(([a, b]) => [a, b] as [number, number]) : [];
    this._dragTapIndex = null;
    this._drawCursor = null;
    this.requestUpdate();
  }

  private _toggleDrawingTap(): void {
    if (this._drawingTap) {
      if (this._drawingGroupId && this._draftTapPoints.length >= 3) {
        this._exitDrawingTap(true);
      } else {
        this._exitDrawingTap(false);
      }
      return;
    }
    if (this._editing) {
      this._editing = false;
      this._syncEditInteraction();
    }
    this._drawingTap = true;
    this._drawCursor = null;
    const configured = Object.keys(this._config.groups ?? {})
      .map((id) => normalizeRoomId(id) || id)
      .filter(Boolean);
    const ids = discoverGroupIds(this._config, this.hass);
    const pick = configured[0] ?? ids[0];
    if (pick) {
      this._selectTapGroup(pick);
    } else {
      this._drawingGroupId = null;
      this._draftTapPoints = [];
    }
    this._syncDrawInteraction();
    this.requestUpdate();
  }

  private _exitDrawingTap(commit: boolean): void {
    if (commit && this._drawingGroupId && this._draftTapPoints.length >= 3) {
      this._commitTapArea(this._drawingGroupId, this._draftTapPoints);
    }
    this._drawingTap = false;
    this._drawingGroupId = null;
    this._draftTapPoints = [];
    this._drawCursor = null;
    this._dragTapIndex = null;
    this._syncDrawInteraction();
    this.requestUpdate();
  }

  /** Keep draw/edit cursors in sync; honour lock_camera for orbit vs dollhouse. */
  private _syncDrawInteraction(): void {
    if (!this._live3d) {
      return;
    }
    this._live3d.setEditTopDown(false);
    this._syncCameraInteraction();
    this._live3d.canvas.style.cursor = this._drawingTap
      ? "crosshair"
      : this._editing
        ? "grab"
        : "";
    this._live3d.render();
  }

  private _cameraLocked(): boolean {
    return this._config.render?.lock_camera !== false;
  }

  private _syncCameraInteraction(): void {
    if (!this._live3d) {
      return;
    }
    const freeCam = !this._cameraLocked();
    this._live3d.setOrbitEnabled(freeCam && !this._dragFixture);
    this._live3d.canvas.style.pointerEvents =
      this._editing || this._drawingTap || freeCam ? "auto" : "none";
  }

  private _undoTapPoint(): void {
    if (this._draftTapPoints.length === 0) {
      return;
    }
    this._draftTapPoints = this._draftTapPoints.slice(0, -1);
    this.requestUpdate();
  }

  private _clearDraftTap(): void {
    this._draftTapPoints = [];
    this.requestUpdate();
  }

  private _finishTapArea(): void {
    if (!this._drawingGroupId || this._draftTapPoints.length < 3) {
      return;
    }
    this._commitTapArea(this._drawingGroupId, this._draftTapPoints);
    this._exitDrawingTap(false);
  }

  private _commitTapArea(groupId: string, points: [number, number][]): void {
    const id = normalizeRoomId(groupId) || groupId;
    const prev = findGroupConfig(this._config, id) ?? this._config.groups?.[groupId] ?? {};
    const groups = { ...(this._config.groups ?? {}) };
    // Drop any differently-cased duplicate key for the same room.
    for (const key of Object.keys(groups)) {
      if (normalizeRoomId(key) === id && key !== id) {
        delete groups[key];
      }
    }
    groups[id] = {
      ...prev,
      tap_area: points.map(([a, b]) => [a, b] as [number, number]),
    };
    this._config = { ...this._config, groups };
    this._groupTapHotspots = buildGroupTapHotspots(groups);
    fireEvent(this, "config-changed", { config: this._config });
    this.requestUpdate();
  }

  private _deleteTapArea(): void {
    if (!this._drawingGroupId) {
      return;
    }
    const gid = normalizeRoomId(this._drawingGroupId) || this._drawingGroupId;
    const prev = findGroupConfig(this._config, gid);
    if (!prev?.tap_area) {
      this._draftTapPoints = [];
      this.requestUpdate();
      return;
    }
    const nextGroup = { ...prev };
    delete nextGroup.tap_area;
    const groups = { ...(this._config.groups ?? {}) };
    for (const key of Object.keys(groups)) {
      if (normalizeRoomId(key) === gid) {
        delete groups[key];
      }
    }
    groups[gid] = Object.keys(nextGroup).length > 0 ? nextGroup : {};
    this._config = { ...this._config, groups };
    this._groupTapHotspots = buildGroupTapHotspots(groups);
    this._draftTapPoints = [];
    fireEvent(this, "config-changed", { config: this._config });
    this.requestUpdate();
  }

  private _tapAreaOverlay(): unknown {
    const saved = Object.entries(this._config.groups ?? {}).filter(
      ([, g]) => g.tap_area && g.tap_area.length >= 3,
    );
    const drafting = this._drawingTap && !!this._drawingGroupId;
    const draftPts = this._draftTapPoints;
    const showDraft = drafting && draftPts.length > 0;
    if (saved.length === 0 && !this._drawingTap) {
      return nothing;
    }
    const hue = groupHue(this._drawingGroupId ?? "x");
    const dragging = this._dragTapIndex !== null;
    const cursor = dragging ? null : this._drawCursor;
    const showRubber = drafting && !dragging && draftPts.length > 0 && draftPts.length < 3;
    const rubberPts = showRubber && cursor ? [...draftPts, cursor] : draftPts;
    const rubberLine = rubberPts.map(([l, t]) => `${l},${t}`).join(" ");
    const labelAt = (pts: [number, number][]): { x: number; y: number } | null => {
      if (pts.length === 0) {
        return null;
      }
      const x = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const y = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      return { x, y };
    };
    const draftLabel = labelAt(draftPts);
    const needMore = Math.max(0, 3 - draftPts.length);
    // Lit `html` puts children in the HTML namespace, so <circle>/<polygon>
    // inside <svg> never paint. Use `svg` for every SVG descendant.
    return html`
      <svg
        class="sf-tap-areas ${this._drawingTap ? "sf-tap-drawing" : ""}"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        ${this._drawingTap
          ? svg`<rect class="sf-tap-dim" x="0" y="0" width="100" height="100"></rect>`
          : nothing}
        ${saved.map(([gid, g]) => {
          if (this._drawingTap && gid === this._drawingGroupId) {
            return nothing;
          }
          const pts = (g.tap_area ?? []).map(([l, t]) => `${l},${t}`).join(" ");
          const gHue = groupHue(gid);
          const mid = labelAt((g.tap_area ?? []) as [number, number][]);
          return svg`
            <polygon
              class="sf-tap-poly ${this._drawingTap ? "sf-tap-poly-muted" : ""}"
              points=${pts}
              style="--sf-group-hue:${gHue}"
            ></polygon>
            ${mid
              ? svg`<text
                  class="sf-tap-label ${this._drawingTap ? "sf-tap-label-muted" : ""}"
                  x=${mid.x}
                  y=${mid.y}
                  style="--sf-group-hue:${gHue}"
                >${gid}</text>`
              : nothing}
          `;
        })}
        ${showDraft && draftPts.length >= 3
          ? svg`<polygon
              class="sf-tap-poly sf-tap-draft"
              points=${draftPts.map(([l, t]) => `${l},${t}`).join(" ")}
              style="--sf-group-hue:${hue}"
            ></polygon>`
          : nothing}
        ${drafting && showRubber && rubberPts.length >= 2
          ? svg`<polyline
              class="sf-tap-rubber"
              points=${rubberLine}
              style="--sf-group-hue:${hue}"
            ></polyline>`
          : nothing}
        ${drafting && cursor && draftPts.length < 3
          ? svg`<circle
              class="sf-tap-cursor"
              cx=${cursor[0]}
              cy=${cursor[1]}
              r="2.2"
              style="--sf-group-hue:${hue}"
            ></circle>`
          : nothing}
        ${draftLabel && this._drawingGroupId
          ? svg`<text
              class="sf-tap-label sf-tap-label-draft"
              x=${draftLabel.x}
              y=${draftLabel.y}
              style="--sf-group-hue:${hue}"
            >${this._drawingGroupId} (${draftPts.length})</text>`
          : nothing}
        ${this._drawingTap && !this._drawingGroupId
          ? svg`<text class="sf-tap-hint" x="50" y="50">Select a room chip to start drawing</text>`
          : nothing}
        ${drafting && draftPts.length === 0
          ? svg`<text class="sf-tap-hint" x="50" y="50">Click to place the first corner</text>`
          : nothing}
        ${drafting && needMore > 0 && draftPts.length > 0
          ? svg`<text class="sf-tap-hint" x="50" y="8"
              >${needMore} more click${needMore === 1 ? "" : "s"} to close the room</text>`
          : nothing}
      </svg>
      ${drafting
        ? html`<div class="sf-tap-pins" aria-hidden="true">
            ${draftPts.map(
              ([l, t], i) => html`
                <div
                  class="sf-tap-pin ${i === this._dragTapIndex
                    ? "sf-tap-pin-dragging"
                    : i === draftPts.length - 1
                      ? "sf-tap-pin-latest"
                      : ""}"
                  style="left:${l}%;top:${t}%;--sf-group-hue:${hue}"
                >
                  ${i + 1}
                </div>
              `,
            )}
          </div>`
        : nothing}
    `;
  }

  private _activateGroup(groupId: string, action: string): void {
    if (!this.hass) {
      return;
    }
    const g = findGroupConfig(this._config, groupId) ?? {};
    const master = g.entity;
    if (master) {
      dispatchMarkerAction(this, this.hass, {
        entity: master,
        tap_action: g.tap_action,
        hold_action: g.hold_action,
        double_tap_action: g.double_tap_action,
      }, action);
      return;
    }
    const members = memberEntitiesForGroup(this._config, groupId, this.hass, this._ir);
    if (members.length === 0) {
      return;
    }
    if (action === "tap" && isDefaultToggleAction(g)) {
      void this.hass.callService("light", "toggle", { entity_id: members });
      return;
    }
    // Fall back to first member for more-info / custom actions without master entity.
    dispatchMarkerAction(
      this,
      this.hass,
      {
        entity: members[0]!,
        tap_action: g.tap_action,
        hold_action: g.hold_action,
        double_tap_action: g.double_tap_action,
      },
      action,
    );
  }

  private _allOff(): void {
    if (!this.hass) {
      return;
    }
    const ids = new Set<string>();
    for (const ent of Object.values(this._config.entities ?? {})) {
      ids.add(ent.entity);
      for (const seg of ent.segments ?? []) {
        ids.add(seg.entity);
      }
    }
    void this.hass.callService("light", "turn_off", { entity_id: [...ids] });
  }

  private _toggleEditing(): void {
    if (this._drawingTap) {
      this._exitDrawingTap(false);
    }
    this._editing = !this._editing;
    this._syncEditInteraction();
    this.requestUpdate();
  }

  private _toggleCameraLock(): void {
    const locked = !this._cameraLocked();
    this._config = {
      ...this._config,
      render: {
        ...this._config.render,
        lock_camera: locked,
      },
    };
    this._syncCameraInteraction();
    if (locked) {
      this._live3d?.resetHomeView();
    }
    this._rebuildMarkers();
    this._live3d?.render();
    fireEvent(this, "config-changed", { config: this._config });
    this.requestUpdate();
  }

  private _inspectorEnabled(): boolean {
    return this._config?.render?.inspector === true;
  }

  private _toggleInspector(): void {
    if (!this._config || !this._usesBabylonRenderLoop()) {
      return;
    }
    const enabled = !this._inspectorEnabled();
    this._config = {
      ...this._config,
      render: {
        ...this._config.render,
        inspector: enabled,
      },
    };
    this._live3d?.setInspector(enabled);
    fireEvent(this, "config-changed", { config: this._config });
    this.requestUpdate();
  }

  private async _copyHomeView(): Promise<void> {
    if (!this._live3d) {
      return;
    }
    const view = this._live3d.getHomeView();
    const yaml = [
      "home_view:",
      `  eye: [${view.eye.map((n) => Number(n.toFixed(1))).join(", ")}]`,
      `  target: [${view.target.map((n) => Number(n.toFixed(1))).join(", ")}]`,
      `  fovDeg: ${Number(view.fovDeg.toFixed(2))}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(yaml);
    } catch {
      // ignore clipboard failures
    }
    console.info("[sunflow] home_view\n%s", yaml);
  }

  private _syncEditInteraction(): void {
    if (!this._live3d) {
      return;
    }
    const canvas = this._live3d.canvas;
    canvas.removeEventListener("pointerdown", this._boundPointerDown, true);
    this._live3d.setHandlesVisible(this._editing);
    this._live3d.setEditTopDown(false);
    this._syncCameraInteraction();
    if (this._editing) {
      canvas.addEventListener("pointerdown", this._boundPointerDown, true);
      canvas.style.cursor = "grab";
    } else if (this._drawingTap) {
      canvas.style.cursor = "crosshair";
    } else if (!this._cameraLocked()) {
      canvas.style.cursor = "grab";
    } else {
      window.removeEventListener("pointermove", this._boundPointerMove);
      window.removeEventListener("pointerup", this._boundPointerUp);
      this._dragFixture = null;
      canvas.style.cursor = "";
    }
    this._live3d.render();
  }

  private _detachEditListeners(): void {
    const canvas = this._live3d?.canvas;
    if (canvas) {
      canvas.removeEventListener("pointerdown", this._boundPointerDown, true);
    }
    window.removeEventListener("pointermove", this._boundPointerMove);
    window.removeEventListener("pointerup", this._boundPointerUp);
    this._dragFixture = null;
  }

  private _onPointerDown(ev: PointerEvent): void {
    if (!this._editing || !this._live3d) {
      return;
    }
    const allowed = new Set(Object.keys(this._config.entities ?? {}));
    const id = this._live3d.pickFixture(ev.clientX, ev.clientY, allowed);
    if (!id) {
      return;
    }
    this._dragFixture = id;
    this._dragMoved = false;
    this._live3d.setOrbitEnabled(false);
    window.addEventListener("pointermove", this._boundPointerMove);
    window.addEventListener("pointerup", this._boundPointerUp);
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }

  private _onPointerMove(ev: PointerEvent): void {
    if (!this._dragFixture || !this._live3d) {
      return;
    }
    const pos = this._live3d.raycastFloor(ev.clientX, ev.clientY, this._dragFixture);
    if (!pos) {
      return;
    }
    this._dragMoved = true;
    this._live3d.setLightPosition(this._dragFixture, pos);
    this._live3d.render();
  }

  private _onPointerUp(ev: PointerEvent): void {
    window.removeEventListener("pointermove", this._boundPointerMove);
    window.removeEventListener("pointerup", this._boundPointerUp);
    const fixtureId = this._dragFixture;
    this._dragFixture = null;
    this._syncCameraInteraction();
    if (!fixtureId || !this._live3d || !this._dragMoved) {
      return;
    }
    const pos = this._live3d.raycastFloor(ev.clientX, ev.clientY, fixtureId);
    if (!pos) {
      return;
    }
    this._commitPosition(fixtureId, pos);
  }

  private _commitPosition(fixtureId: string, pos: Vec3): void {
    const prev = this._config.overrides?.[fixtureId] ?? {};
    const fx = this._ir?.fixtures.find((f) => f.id === fixtureId);
    const kind = resolveFixtureKind(fx, prev);
    const oldStart = resolveFixturePose(this._ir, fixtureId, this._config.overrides);
    const oldEnd = resolveStripEnd(this._ir, fixtureId, this._config.overrides);
    const nextOverride: FixtureOverride = {
      ...prev,
      position: positionTuple(pos),
    };
    if (kind === "strip" && oldStart && oldEnd) {
      nextOverride.end = positionTuple({
        x: oldEnd.x + (pos.x - oldStart.x),
        y: oldEnd.y + (pos.y - oldStart.y),
        z: oldEnd.z + (pos.z - oldStart.z),
      });
    }
    delete nextOverride.marker;
    const overrides = {
      ...(this._config.overrides ?? {}),
      [fixtureId]: nextOverride,
    };
    this._config = { ...this._config, overrides };
    if (nextOverride.end) {
      this._live3d?.setStripPose(fixtureId, pos, {
        x: nextOverride.end[0],
        y: nextOverride.end[1],
        z: nextOverride.end[2],
      });
    } else {
      this._live3d?.setLightPosition(fixtureId, pos);
    }
    this._rebuildMarkers();
    fireEvent(this, "config-changed", { config: this._config });
    this.requestUpdate();
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
    const mode = this._config.render?.mode ?? "live3d";
    const groupIds = discoverGroupIds(this._config, this.hass, this._ir);
    const hasBlenderRooms = this._hasBlenderRooms();
    const canEdit =
      !!this._config.edit_mode && mode === "live3d" && !this._live3dFallback;
    const canDrawTap = !!this._config.edit_mode && groupIds.length > 0 && !hasBlenderRooms;
    const canFreeCam = mode === "live3d" && !this._live3dFallback;
    const canInspector =
      mode === "live3d" && !this._live3dFallback && this._usesBabylonRenderLoop();
    const roomPrompt = this._roomPrompt;
    const roomPromptName = roomPrompt
      ? roomDisplayName(this._ir, roomPrompt.groupId)
      : "";
    const roomPromptStats = roomPrompt ? this._roomPromptSummary() : null;

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
      ${groupIds.length > 0
        ? html`
            <div class="sf-groups">
              ${groupIds.map((gid) => {
                const hue = groupHue(gid);
                const selected = this._drawingTap && this._drawingGroupId === gid;
                return html`
                  <button
                    class="sf-group-chip ${selected ? "active" : ""}"
                    style="--sf-group-hue:${hue}"
                    title=${this._drawingTap
                      ? `Draw tap area for ${gid}`
                      : `Control ${roomDisplayName(this._ir, gid)}`}
                    @click=${(ev: Event) => this._onGroupChipClick(gid, ev)}
                    @contextmenu=${(ev: Event) => {
                      if (this._drawingTap) {
                        ev.preventDefault();
                        return;
                      }
                      ev.preventDefault();
                      this._activateGroup(gid, "hold");
                    }}
                  >
                    ${roomDisplayName(this._ir, gid)}
                  </button>
                `;
              })}
            </div>
          `
        : nothing}
      ${this._editing
        ? html`<div class="sf-edit-banner">Edit lights — drag pink floor markers</div>`
        : nothing}
      ${this._drawingTap
        ? html`<div class="sf-edit-banner">
            Draw room tap area${this._drawingGroupId
              ? html` for <strong>${this._drawingGroupId}</strong>
                  — ${this._draftTapPoints.length} corner${this._draftTapPoints.length === 1
                    ? ""
                    : "s"}${this._draftTapPoints.length > 0
                    ? html` at
                        ${this._draftTapPoints
                          .map(([l, t]) => `${l.toFixed(0)},${t.toFixed(0)}`)
                          .join(" · ")}`
                    : nothing}`
              : html` — select a room chip first`}:
            numbered pins mark each click. Drag a pin to move it, click an edge
            to insert a corner, double-click or right-click a pin to remove.
            <span class="sf-draw-actions">
              <button
                ?disabled=${this._draftTapPoints.length === 0}
                @click=${() => this._undoTapPoint()}
              >
                Undo
              </button>
              <button
                ?disabled=${this._draftTapPoints.length === 0}
                @click=${() => this._clearDraftTap()}
              >
                Clear
              </button>
              <button
                ?disabled=${!this._drawingGroupId || this._draftTapPoints.length < 3}
                @click=${() => this._finishTapArea()}
              >
                Finish (${this._draftTapPoints.length})
              </button>
              <button
                ?disabled=${!this._drawingGroupId}
                @click=${() => this._deleteTapArea()}
              >
                Delete area
              </button>
              <button @click=${() => this._exitDrawingTap(false)}>Cancel</button>
            </span>
          </div>`
        : nothing}
      ${this._live3dFallback
        ? html`<div class="sf-edit-banner">
            live3d GPU unavailable — marker preview only (drag edit disabled)
          </div>`
        : nothing}
      <div
        class="sf-stage ${this._editing || this._drawingTap ? "sf-editing" : ""} ${this
          ._drawingTap
          ? "sf-drawing-tap"
          : ""}"
        style="aspect-ratio: ${aspect}"
        @click=${this._onStageClick}
        @pointerdown=${this._onStagePointerDown}
        @pointermove=${this._onStagePointerMove}
        @pointerup=${this._onStagePointerUp}
        @pointercancel=${this._onStagePointerUp}
        @pointerleave=${this._onStagePointerLeave}
        @dblclick=${this._onStageDblClick}
        @contextmenu=${this._onStageContextMenu}
      >
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
          : this._canvasHostEl}
        ${this._tapAreaOverlay()}
        ${!this._editing && !this._drawingTap && this._cameraLocked()
          ? html`
              <div class="sf-markers">
                ${this._markers.map((m) => {
                  const hue = m.group !== undefined ? groupHue(m.group) : undefined;
                  return html`
                    <button
                      class="sf-marker ${m.params.unavailable || m.params.unknown
                        ? "sf-marker-warn"
                        : ""} ${m.params.on ? "sf-marker-on" : ""} ${m.group
                        ? "sf-marker-grouped"
                        : ""}"
                      style="left:${m.left}%;top:${m.top}%;${hue !== undefined
                        ? `--sf-group-hue:${hue}`
                        : ""}"
                      title=${m.friendlyName ?? m.entity}
                      aria-label=${m.friendlyName ?? m.entity}
                      @pointerdown=${(ev: PointerEvent) => this._onMarkerPointerDown(ev, m)}
                      @pointerup=${(ev: PointerEvent) => this._onMarkerPointerUp(ev, m)}
                      @pointercancel=${() => this._onMarkerPointerCancel()}
                      @click=${(ev: Event) => ev.stopPropagation()}
                      @contextmenu=${(ev: Event) => this._onMarkerContextMenu(ev)}
                    >
                      <span class="sf-dot" style="opacity:${m.params.on ? 1 : 0.35}"></span>
                      ${m.params.on
                        ? html`<span class="sf-pct"
                            >${Math.round(m.params.intensity * 100)}%</span
                          >`
                        : nothing}
                    </button>
                  `;
                })}
              </div>
            `
          : !this._editing && !this._drawingTap && !this._cameraLocked()
            ? html`<div class="sf-cam-hint">Lock camera to control lights</div>`
            : nothing}
      </div>
      <div class="sf-controls">
        <button @click=${this._allOff}>All off</button>
        ${canFreeCam
          ? html`<button
              class=${this._cameraLocked() ? "" : "active"}
              @click=${() => this._toggleCameraLock()}
            >
              ${this._cameraLocked() ? "Free camera" : "Lock camera"}
            </button>`
          : nothing}
        ${canFreeCam && !this._cameraLocked()
          ? html`<button @click=${() => void this._copyHomeView()}>Copy home view</button>`
          : nothing}
        ${canInspector
          ? html`<button
              class=${this._inspectorEnabled() ? "active" : ""}
              @click=${() => this._toggleInspector()}
            >
              ${this._inspectorEnabled() ? "Inspector on" : "Inspector"}
            </button>`
          : nothing}
        ${canEdit
          ? html`<button class=${this._editing ? "active" : ""} @click=${this._toggleEditing}>
              ${this._editing ? "Done editing" : "Edit lights"}
            </button>`
          : nothing}
        ${canDrawTap
          ? html`<button
              class=${this._drawingTap ? "active" : ""}
              @click=${() => this._toggleDrawingTap()}
            >
              ${this._drawingTap ? "Done tap areas" : "Draw tap area"}
            </button>`
          : nothing}
      </div>
      ${roomPrompt && roomPromptStats
        ? html`
            <div
              class="sf-room-prompt-backdrop"
              @click=${() => this._dismissRoomPrompt()}
            ></div>
            <div
              class="sf-room-prompt"
              role="dialog"
              aria-modal="true"
              aria-label=${`Control ${roomPromptName}`}
              @click=${(ev: Event) => ev.stopPropagation()}
            >
              <div class="sf-room-prompt-title">${roomPromptName}</div>
              <div class="sf-room-prompt-meta">
                ${roomPromptStats.total} light${roomPromptStats.total === 1 ? "" : "s"}
                · ${roomPromptStats.on} on · ${roomPromptStats.off} off
              </div>
              <div class="sf-room-prompt-actions">
                <button
                  class="sf-room-prompt-on"
                  @click=${() => this._applyRoomPrompt("on")}
                >
                  Turn on
                </button>
                <button
                  class="sf-room-prompt-off"
                  @click=${() => this._applyRoomPrompt("off")}
                >
                  Turn off
                </button>
                <button @click=${() => this._dismissRoomPrompt()}>Cancel</button>
              </div>
            </div>
          `
        : nothing}
    `;
  }

  protected override firstUpdated(): void {
    if ((this._config.render?.mode ?? "live3d") === "baked" && this._compositor) {
      this._attachCanvas();
    }
  }

  static override styles = css`
    :host {
      display: block;
      position: relative;
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
    .sf-floors button,
    .sf-controls button,
    .sf-group-chip {
      min-height: 44px;
      padding: 0 0.75rem;
      border-radius: 8px;
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: inherit;
      cursor: pointer;
    }
    .sf-groups {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      margin-bottom: 0.5rem;
    }
    .sf-group-chip {
      border-color: hsl(var(--sf-group-hue, 200) 55% 45%);
      box-shadow: inset 0 0 0 2px hsl(var(--sf-group-hue, 200) 55% 45% / 0.35);
    }
    .sf-floors button.active,
    .sf-controls button.active,
    .sf-group-chip.active {
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
    .sf-edit-banner {
      background: #2a3a28;
      color: #c8e6c9;
      padding: 0.35rem 0.6rem;
      border-radius: 6px;
      font-size: 0.85rem;
      margin-bottom: 0.5rem;
    }
    .sf-draw-actions {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      margin-left: 0.5rem;
      vertical-align: middle;
    }
    .sf-draw-actions button {
      min-height: 32px;
      padding: 0 0.5rem;
      border-radius: 6px;
      border: 1px solid #6a8f6c;
      background: #1e2e1c;
      color: #c8e6c9;
      cursor: pointer;
      font-size: 0.8rem;
    }
    .sf-draw-actions button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .sf-stage {
      position: relative;
      width: 100%;
      min-height: 280px;
      background: #111;
      border-radius: 8px;
      overflow: hidden;
    }
    .sf-stage.sf-editing {
      outline: 2px solid var(--primary-color, #6ea8fe);
    }
    .sf-stage.sf-drawing-tap {
      cursor: crosshair;
      outline: 2px solid hsl(var(--sf-group-hue, 200) 65% 55%);
      touch-action: none;
      user-select: none;
    }
    .sf-stage.sf-drawing-tap .sf-canvas-host,
    .sf-stage.sf-drawing-tap .sf-gl {
      /* Let stage receive clicks; WebGL must not sit above the SVG overlay. */
      pointer-events: none;
    }
    .sf-tap-areas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 5;
      overflow: visible;
    }
    .sf-tap-pins {
      position: absolute;
      inset: 0;
      z-index: 40;
      pointer-events: none;
    }
    .sf-tap-pin {
      position: absolute;
      transform: translate(-50%, -50%);
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: hsl(var(--sf-group-hue, 200) 80% 48%);
      border: 2px solid #fff;
      color: #fff;
      font-size: 12px;
      font-weight: 800;
      line-height: 24px;
      text-align: center;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.55);
    }
    .sf-tap-pin-latest {
      background: #fff;
      color: #111;
      border-color: hsl(var(--sf-group-hue, 200) 90% 45%);
      box-shadow: 0 0 0 3px hsl(var(--sf-group-hue, 200) 80% 50% / 0.45),
        0 2px 8px rgba(0, 0, 0, 0.55);
    }
    .sf-tap-pin-dragging {
      width: 34px;
      height: 34px;
      line-height: 30px;
      font-size: 13px;
      background: #fff;
      color: #111;
      border-color: hsl(var(--sf-group-hue, 200) 90% 40%);
      box-shadow: 0 0 0 4px hsl(var(--sf-group-hue, 200) 80% 50% / 0.55),
        0 4px 12px rgba(0, 0, 0, 0.6);
      z-index: 1;
    }
    .sf-tap-dim {
      fill: rgba(8, 10, 14, 0.38);
    }
    .sf-tap-poly {
      fill: hsl(var(--sf-group-hue, 200) 70% 55% / 0.35);
      stroke: hsl(var(--sf-group-hue, 200) 90% 65%);
      stroke-width: 2.5;
      vector-effect: non-scaling-stroke;
    }
    .sf-tap-poly-muted {
      fill: hsl(var(--sf-group-hue, 200) 40% 45% / 0.1);
      stroke: hsl(var(--sf-group-hue, 200) 40% 55% / 0.45);
      stroke-width: 1.5;
      vector-effect: non-scaling-stroke;
    }
    .sf-tap-draft {
      fill: hsl(var(--sf-group-hue, 200) 75% 55% / 0.4);
      stroke: #fff;
      stroke-width: 3;
      vector-effect: non-scaling-stroke;
      animation: sf-tap-pulse 1.2s ease-in-out infinite;
    }
    .sf-tap-rubber {
      fill: none;
      stroke: #fff;
      stroke-width: 2.5;
      stroke-dasharray: 8 5;
      vector-effect: non-scaling-stroke;
      filter: drop-shadow(0 0 2px hsl(var(--sf-group-hue, 200) 90% 50%));
    }
    .sf-tap-close-hint {
      fill: none;
      stroke: hsl(var(--sf-group-hue, 200) 80% 70% / 0.7);
      stroke-width: 2;
      stroke-dasharray: 4 4;
      vector-effect: non-scaling-stroke;
    }
    .sf-tap-vertex {
      fill: hsl(var(--sf-group-hue, 200) 90% 55%);
      stroke: #fff;
      stroke-width: 2;
      vector-effect: non-scaling-stroke;
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.65));
    }
    .sf-tap-vertex-latest {
      fill: #fff;
      stroke: hsl(var(--sf-group-hue, 200) 90% 45%);
      stroke-width: 2.5;
    }
    .sf-tap-cursor {
      fill: hsl(var(--sf-group-hue, 200) 90% 60% / 0.45);
      stroke: #fff;
      stroke-width: 2;
      vector-effect: non-scaling-stroke;
    }
    .sf-tap-vertex-num {
      fill: #111;
      font-size: 3.2px;
      font-weight: 800;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
      paint-order: stroke;
      stroke: #fff;
      stroke-width: 0.55px;
    }
    .sf-tap-label {
      fill: #fff;
      font-size: 3.6px;
      font-weight: 800;
      text-anchor: middle;
      dominant-baseline: middle;
      pointer-events: none;
      paint-order: stroke fill;
      stroke: rgba(0, 0, 0, 0.85);
      stroke-width: 0.7px;
    }
    .sf-tap-label-muted {
      fill: hsl(var(--sf-group-hue, 200) 30% 80% / 0.75);
      font-size: 2.8px;
      font-weight: 600;
    }
    .sf-tap-label-draft {
      font-size: 4px;
    }
    .sf-tap-hint {
      fill: #fff;
      font-size: 4px;
      font-weight: 700;
      text-anchor: middle;
      dominant-baseline: middle;
      pointer-events: none;
      paint-order: stroke fill;
      stroke: rgba(0, 0, 0, 0.9);
      stroke-width: 0.75px;
    }
    @keyframes sf-tap-pulse {
      0%,
      100% {
        fill: hsl(var(--sf-group-hue, 200) 75% 55% / 0.32);
      }
      50% {
        fill: hsl(var(--sf-group-hue, 200) 80% 58% / 0.5);
      }
    }
    .sf-canvas-host {
      position: absolute;
      inset: 0;
      z-index: 0;
    }
    .sf-gl {
      width: 100%;
      height: 100%;
      display: block;
    }
    .sf-markers {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 4;
    }
    .sf-cam-hint {
      position: absolute;
      left: 50%;
      bottom: 0.75rem;
      transform: translateX(-50%);
      z-index: 4;
      padding: 0.35rem 0.75rem;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      font-size: 0.8rem;
      pointer-events: none;
    }
    .sf-marker {
      pointer-events: auto;
      position: absolute;
      transform: translate(-50%, -50%);
      min-width: 48px;
      min-height: 48px;
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
      touch-action: manipulation;
      -webkit-user-select: none;
      user-select: none;
    }
    .sf-marker-warn {
      outline: 2px solid var(--error-color, #db4437);
    }
    .sf-marker-on {
      background: rgba(40, 60, 20, 0.65);
    }
    .sf-marker-grouped {
      box-shadow: 0 0 0 2px hsl(var(--sf-group-hue, 200) 55% 50% / 0.85);
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
    .sf-room-prompt-backdrop {
      position: absolute;
      inset: 0;
      z-index: 40;
      background: rgba(0, 0, 0, 0.45);
    }
    .sf-room-prompt {
      position: absolute;
      left: 50%;
      top: 50%;
      z-index: 41;
      transform: translate(-50%, -50%);
      width: min(22rem, calc(100% - 1.5rem));
      padding: 1rem 1.1rem;
      border-radius: 12px;
      border: 1px solid var(--divider-color);
      background: var(--card-background-color, #1c1c1c);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
    }
    .sf-room-prompt-title {
      font-size: 1.15rem;
      font-weight: 650;
      margin-bottom: 0.25rem;
    }
    .sf-room-prompt-meta {
      font-size: 0.9rem;
      opacity: 0.75;
      margin-bottom: 0.9rem;
    }
    .sf-room-prompt-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }
    .sf-room-prompt-actions button {
      flex: 1 1 5.5rem;
      min-height: 48px;
      padding: 0 0.75rem;
      border-radius: 8px;
      border: 1px solid var(--divider-color);
      background: var(--secondary-background-color, #2a2a2a);
      color: inherit;
      cursor: pointer;
      font-size: 1rem;
    }
    .sf-room-prompt-on {
      background: var(--primary-color) !important;
      color: var(--text-primary-color, #fff) !important;
      border-color: transparent !important;
    }
    .sf-room-prompt-off {
      background: var(--error-color, #db4437) !important;
      color: #fff !important;
      border-color: transparent !important;
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

if (!customElements.get(CARD_TYPE)) {
  try {
    customElements.define(CARD_TYPE, SunflowFloorplanCard);
  } catch {
    // Lovelace ?v= cache-bust vs chunk import of ../sunflow-floorplan-card.js
    // are different module URLs; both may race past get() before define().
  }
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TYPE,
  name: "Sunflow Floorplan",
  description: "Dynamic floorplan lighting from SweetHome3D / live3d",
  preview: true,
  documentationURL: "https://github.com/matjahs/ha-floormap",
});

declare global {
  interface HTMLElementTagNameMap {
    "sunflow-floorplan-card": SunflowFloorplanCard;
  }
}
