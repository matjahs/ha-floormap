import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
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
import { selectCamera, projectToPercent } from "./projection";
import {
  mergePlacementsIntoOverrides,
  positionTuple,
  resolveFixturePose,
  type PlacementsFile,
} from "./pose";
import {
  buildGroupTapHotspots,
  discoverGroupIds,
  findGroupConfig,
  groupHue,
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
  @state() private _editing = false;
  /** Draw group tap_area polygons on the stage (edit_mode). */
  @state() private _drawingTap = false;
  @state() private _drawingGroupId: string | null = null;
  @state() private _draftTapPoints: [number, number][] = [];
  /** Cursor position in stage % while drawing (rubber-band). */
  @state() private _drawCursor: [number, number] | null = null;
  /** live3d requested but WebGL unavailable — marker-only preview */
  @state() private _live3dFallback = false;

  private _compositor: BakedCompositor | null = null;
  private _animator = new LightStateAnimator();
  private _live3d: Live3dHandle | null = null;
  private _hotspots: RoomHotspot[] = [];
  private _groupTapHotspots: GroupTapHotspot[] = [];
  private _images = new Map<string, HTMLImageElement>();
  /** Last-click tracking for crude double-tap detection */
  private _lastTapAt = 0;
  private _lastTapFixture = "";
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
    this._detachEditListeners();
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
    // Lit clears empty host children on render; re-attach imperative canvas.
    this._ensureCanvasMounted();
  }

  private _ensureCanvasMounted(): void {
    const host = this.renderRoot?.querySelector(".sf-canvas-host") as HTMLElement | null;
    if (!host) {
      return;
    }
    const canvas = this._live3d?.canvas ?? this._compositor?.canvas ?? null;
    if (canvas && !host.contains(canvas)) {
      canvas.className = "sf-gl";
      host.replaceChildren(canvas);
      if (this._live3d) {
        const rect = host.getBoundingClientRect();
        this._live3d.resize(
          Math.max(1, rect.width),
          Math.max(1, rect.height || rect.width * (405 / 720)),
        );
        this._syncEditInteraction();
      }
    }
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

      if (this._config.fml) {
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

      const mode = this._config.render?.mode ?? "live3d";
      this._live3dFallback = false;
      if (mode === "live3d") {
        try {
          await this._initLive3d();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/webgl/i.test(msg)) {
            this._live3dFallback = true;
            this._live3d?.dispose();
            this._live3d = null;
          } else {
            throw e;
          }
        }
      } else {
        await this._initBaked();
      }
      this._syncHassState(true);
      this._rebuildMarkers();
      this.requestUpdate();
    } catch (e) {
      this._error = e instanceof Error ? e.message : String(e);
    }
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

  private async _initLive3d(): Promise<void> {
    if (!this._ir) {
      throw new Error("live3d mode requires IR (manifest or inline ir)");
    }
    await this.updateComplete;
    const canvas = document.createElement("canvas");
    canvas.className = "sf-gl";
    const cam = this._currentCamera();
    const levelId = this._currentLevelId();
    const elev = this._ir.levels.find((l) => l.id === levelId)?.elevation ?? 0;
    this._live3d?.dispose();
    const { createLive3dRenderer } = await import("./renderer/live3d/scene");
    this._live3d = await createLive3dRenderer(this._ir, canvas, cam, {
      poses: this._posesFromConfig(),
      stripEnds: this._stripEndsFromConfig(),
      levelElevation: elev,
      editableFixtureIds: Object.keys(this._config.entities ?? {}),
      editableFixtureLabels: this._editFixtureLabels().labels,
      editableFixtureRooms: this._editFixtureLabels().rooms,
    });
    this._ensureCanvasMounted();
    this._syncEditInteraction();
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

  private _rebuildMarkers(): void {
    const ir = this._ir;
    const cam = this._currentCamera();
    const entities = this._config.entities ?? {};
    const overrides = this._config.overrides ?? {};
    const markers: MarkerState[] = [];
    const aspect = this._aspect();
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
          if ((left === undefined || top === undefined) && cam) {
            const pct = projectToPercent(cam, mid, { aspect });
            left = pct.left;
            top = pct.top;
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
      if ((left === undefined || top === undefined) && cam && start) {
        const pct = projectToPercent(cam, start, { aspect });
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
        group: ent.group,
        friendlyName: this.hass?.states?.[ent.entity]?.attributes?.friendly_name as
          | string
          | undefined,
      });
    }
    this._markers = markers;
    this._groupTapHotspots = buildGroupTapHotspots(this._config.groups);

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
      this.requestUpdate();
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

  private _onMarkerPointer(ev: Event, m: MarkerState): void {
    ev.stopPropagation();
    const now = Date.now();
    const key = `${m.fixtureId}:${m.segmentIndex ?? -1}`;
    if (now - this._lastTapAt < 350 && this._lastTapFixture === key) {
      this._lastTapAt = 0;
      this._onMarkerAction("double_tap", m.fixtureId, m.segmentIndex);
      return;
    }
    this._lastTapAt = now;
    this._lastTapFixture = key;
    this._onMarkerAction("tap", m.fixtureId, m.segmentIndex);
  }

  private _onMarkerHold(ev: Event, m: MarkerState): void {
    ev.preventDefault();
    ev.stopPropagation();
    this._onMarkerAction("hold", m.fixtureId, m.segmentIndex);
  }

  private _onStagePointerMove = (ev: PointerEvent): void => {
    if (!this._drawingTap || !this._drawingGroupId) {
      return;
    }
    const stage = ev.currentTarget as HTMLElement;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const left = Math.round(((ev.clientX - rect.left) / rect.width) * 1000) / 10;
    const top = Math.round(((ev.clientY - rect.top) / rect.height) * 1000) / 10;
    this._drawCursor = [
      Math.min(100, Math.max(0, left)),
      Math.min(100, Math.max(0, top)),
    ];
  };

  private _onStagePointerLeave = (): void => {
    this._drawCursor = null;
  };

  private _onStageClick(ev: MouseEvent): void {
    if (this._editing || this._dragMoved) {
      this._dragMoved = false;
      return;
    }
    const stage = ev.currentTarget as HTMLElement;
    const rect = stage.getBoundingClientRect();
    const u = (ev.clientX - rect.left) / rect.width;
    const v = (ev.clientY - rect.top) / rect.height;

    // Drawing mode: never toggle lights; only place vertices once a group is selected.
    if (this._drawingTap) {
      if (!this._drawingGroupId) {
        return;
      }
      const left = Math.round(u * 1000) / 10;
      const top = Math.round(v * 1000) / 10;
      this._draftTapPoints = [...this._draftTapPoints, [left, top]];
      this._drawCursor = [left, top];
      this.requestUpdate();
      return;
    }

    // Group tap areas take precedence over room hotspots.
    const groupHit = hitTestGroupTap(this._groupTapHotspots, u, v);
    if (groupHit && this.hass) {
      this._activateGroup(groupHit.groupId, "tap");
      return;
    }

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

  private _onGroupChipClick(gid: string, ev: Event): void {
    ev.stopPropagation();
    if (this._drawingTap) {
      this._selectTapGroup(gid);
      return;
    }
    this._activateGroup(gid, "tap");
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
    const ids = discoverGroupIds(this._config, this.hass);
    if (ids.length === 1) {
      this._selectTapGroup(ids[0]!);
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
    this._syncDrawInteraction();
    this.requestUpdate();
  }

  /** Freeze orbit + top-down framing while drawing tap polygons. */
  private _syncDrawInteraction(): void {
    if (!this._live3d) {
      return;
    }
    this._live3d.setEditTopDown(this._drawingTap || this._editing);
    this._live3d.setOrbitEnabled(!this._drawingTap && !this._dragFixture);
    this._live3d.canvas.style.cursor = this._drawingTap
      ? "crosshair"
      : this._editing
        ? "grab"
        : "";
    this._live3d.render();
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

  private _tapAreaSvg(): unknown {
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
    const cursor = this._drawCursor;
    const rubberPts =
      drafting && draftPts.length > 0 && cursor
        ? [...draftPts, cursor]
        : draftPts;
    const rubberLine = rubberPts.map(([l, t]) => `${l},${t}`).join(" ");
    const closeHint =
      drafting && draftPts.length >= 3 && cursor
        ? `${draftPts[draftPts.length - 1]![0]},${draftPts[draftPts.length - 1]![1]} ${cursor[0]},${cursor[1]} ${draftPts[0]![0]},${draftPts[0]![1]}`
        : "";
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

    return html`
      <svg
        class="sf-tap-areas ${this._drawingTap ? "sf-tap-drawing" : ""}"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        ${this._drawingTap
          ? html`<rect class="sf-tap-dim" x="0" y="0" width="100" height="100"></rect>`
          : nothing}
        ${saved.map(([gid, g]) => {
          if (this._drawingTap && gid === this._drawingGroupId) {
            return nothing;
          }
          const pts = (g.tap_area ?? []).map(([l, t]) => `${l},${t}`).join(" ");
          const gHue = groupHue(gid);
          const mid = labelAt((g.tap_area ?? []) as [number, number][]);
          return html`
            <polygon
              class="sf-tap-poly ${this._drawingTap ? "sf-tap-poly-muted" : ""}"
              points=${pts}
              style="--sf-group-hue:${gHue}"
            ></polygon>
            ${mid
              ? html`<text
                  class="sf-tap-label ${this._drawingTap ? "sf-tap-label-muted" : ""}"
                  x=${mid.x}
                  y=${mid.y}
                  style="--sf-group-hue:${gHue}"
                >${gid}</text>`
              : nothing}
          `;
        })}
        ${showDraft && draftPts.length >= 3
          ? html`<polygon
              class="sf-tap-poly sf-tap-draft"
              points=${draftPts.map(([l, t]) => `${l},${t}`).join(" ")}
              style="--sf-group-hue:${hue}"
            ></polygon>`
          : nothing}
        ${drafting && rubberPts.length >= 2
          ? html`<polyline
              class="sf-tap-rubber"
              points=${rubberLine}
              style="--sf-group-hue:${hue}"
            ></polyline>`
          : nothing}
        ${closeHint
          ? html`<polyline
              class="sf-tap-close-hint"
              points=${closeHint}
              style="--sf-group-hue:${hue}"
            ></polyline>`
          : nothing}
        ${drafting
          ? draftPts.map(
              ([l, t], i) => html`
                <circle
                  class="sf-tap-vertex ${i === draftPts.length - 1 ? "sf-tap-vertex-latest" : ""}"
                  cx=${l}
                  cy=${t}
                  r="1.8"
                  style="--sf-group-hue:${hue}"
                ></circle>
                <text
                  class="sf-tap-vertex-num"
                  x=${l}
                  y=${t}
                  style="--sf-group-hue:${hue}"
                >${i + 1}</text>
              `,
            )
          : nothing}
        ${drafting && cursor
          ? html`<circle
              class="sf-tap-cursor"
              cx=${cursor[0]}
              cy=${cursor[1]}
              r="1.4"
              style="--sf-group-hue:${hue}"
            ></circle>`
          : nothing}
        ${draftLabel && this._drawingGroupId
          ? html`<text
              class="sf-tap-label sf-tap-label-draft"
              x=${draftLabel.x}
              y=${draftLabel.y}
              style="--sf-group-hue:${hue}"
            >${this._drawingGroupId} (${draftPts.length})</text>`
          : nothing}
        ${this._drawingTap && !this._drawingGroupId
          ? html`<text class="sf-tap-hint" x="50" y="50">Select a room chip to start drawing</text>`
          : nothing}
        ${drafting && draftPts.length === 0
          ? html`<text class="sf-tap-hint" x="50" y="50">Click to place the first corner</text>`
          : nothing}
        ${drafting && needMore > 0 && draftPts.length > 0
          ? html`<text class="sf-tap-hint" x="50" y="8"
              >${needMore} more click${needMore === 1 ? "" : "s"} to close the room</text
            >`
          : nothing}
      </svg>
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
    const members = memberEntitiesForGroup(this._config, groupId, this.hass);
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

  private _syncEditInteraction(): void {
    if (!this._live3d) {
      return;
    }
    const canvas = this._live3d.canvas;
    canvas.removeEventListener("pointerdown", this._boundPointerDown, true);
    this._live3d.setHandlesVisible(this._editing);
    this._live3d.setEditTopDown(this._editing || this._drawingTap);
    this._live3d.setOrbitEnabled(!this._dragFixture && !this._drawingTap);
    if (this._editing) {
      // Capture phase so we can cancel OrbitControls before it starts a rotate.
      canvas.addEventListener("pointerdown", this._boundPointerDown, true);
      canvas.style.cursor = "grab";
    } else if (this._drawingTap) {
      canvas.style.cursor = "crosshair";
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
    // Stop OrbitControls (bubble listener) from starting a camera gesture.
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
    this._live3d?.setOrbitEnabled(true);
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
    const groupIds = discoverGroupIds(this._config, this.hass);
    const canEdit =
      !!this._config.edit_mode && mode === "live3d" && !this._live3dFallback;
    const canDrawTap = !!this._config.edit_mode && groupIds.length > 0;

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
                      : `Toggle group ${gid}`}
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
                    ${gid}
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
                    : "s"}`
              : html` — select a room chip first`}:
            click corners on the map (≥3), then Finish. Orbit is locked while drawing.
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
            live3d WebGL unavailable — marker preview only (drag edit disabled)
          </div>`
        : nothing}
      <div
        class="sf-stage ${this._editing || this._drawingTap ? "sf-editing" : ""} ${this
          ._drawingTap
          ? "sf-drawing-tap"
          : ""}"
        style="aspect-ratio: ${aspect}"
        @click=${this._onStageClick}
        @pointermove=${this._onStagePointerMove}
        @pointerleave=${this._onStagePointerLeave}
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
          : html`<div class="sf-canvas-host"></div>`}
        ${this._tapAreaSvg()}
        ${!this._editing && !this._drawingTap
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
                      @click=${(ev: Event) => this._onMarkerPointer(ev, m)}
                      @contextmenu=${(ev: Event) => this._onMarkerHold(ev, m)}
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
          : nothing}
      </div>
      <div class="sf-controls">
        <button @click=${this._allOff}>All off</button>
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
    }
    .sf-tap-areas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 2;
      overflow: visible;
    }
    .sf-tap-dim {
      fill: rgba(10, 12, 16, 0.28);
    }
    .sf-tap-poly {
      fill: hsl(var(--sf-group-hue, 200) 55% 50% / 0.22);
      stroke: hsl(var(--sf-group-hue, 200) 70% 55% / 0.95);
      stroke-width: 0.55;
      vector-effect: non-scaling-stroke;
    }
    .sf-tap-poly-muted {
      fill: hsl(var(--sf-group-hue, 200) 40% 45% / 0.08);
      stroke: hsl(var(--sf-group-hue, 200) 40% 50% / 0.35);
      stroke-width: 0.35;
    }
    .sf-tap-draft {
      fill: hsl(var(--sf-group-hue, 200) 60% 50% / 0.32);
      stroke-width: 0.7;
      stroke-dasharray: none;
      animation: sf-tap-pulse 1.2s ease-in-out infinite;
    }
    .sf-tap-rubber {
      fill: none;
      stroke: hsl(var(--sf-group-hue, 200) 80% 60%);
      stroke-width: 0.65;
      stroke-dasharray: 1.4 0.9;
      vector-effect: non-scaling-stroke;
    }
    .sf-tap-close-hint {
      fill: none;
      stroke: hsl(var(--sf-group-hue, 200) 70% 70% / 0.55);
      stroke-width: 0.45;
      stroke-dasharray: 0.8 0.8;
      vector-effect: non-scaling-stroke;
    }
    .sf-tap-vertex {
      fill: hsl(var(--sf-group-hue, 200) 75% 58%);
      stroke: #fff;
      stroke-width: 0.45;
      vector-effect: non-scaling-stroke;
    }
    .sf-tap-vertex-latest {
      fill: #fff;
      stroke: hsl(var(--sf-group-hue, 200) 80% 50%);
      stroke-width: 0.55;
    }
    .sf-tap-cursor {
      fill: hsl(var(--sf-group-hue, 200) 80% 60% / 0.35);
      stroke: hsl(var(--sf-group-hue, 200) 80% 65%);
      stroke-width: 0.4;
      vector-effect: non-scaling-stroke;
    }
    .sf-tap-vertex-num {
      fill: #111;
      font-size: 2.4px;
      font-weight: 700;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
      paint-order: stroke;
      stroke: #fff;
      stroke-width: 0.35px;
    }
    .sf-tap-label {
      fill: hsl(var(--sf-group-hue, 200) 70% 92%);
      font-size: 3.2px;
      font-weight: 700;
      text-anchor: middle;
      dominant-baseline: middle;
      pointer-events: none;
      paint-order: stroke fill;
      stroke: rgba(0, 0, 0, 0.75);
      stroke-width: 0.55px;
    }
    .sf-tap-label-muted {
      fill: hsl(var(--sf-group-hue, 200) 30% 75% / 0.7);
      font-size: 2.6px;
      font-weight: 600;
    }
    .sf-tap-label-draft {
      font-size: 3.6px;
    }
    .sf-tap-hint {
      fill: #fff;
      font-size: 3.4px;
      font-weight: 600;
      text-anchor: middle;
      dominant-baseline: middle;
      pointer-events: none;
      paint-order: stroke fill;
      stroke: rgba(0, 0, 0, 0.85);
      stroke-width: 0.6px;
    }
    @keyframes sf-tap-pulse {
      0%,
      100% {
        fill: hsl(var(--sf-group-hue, 200) 60% 50% / 0.28);
      }
      50% {
        fill: hsl(var(--sf-group-hue, 200) 65% 55% / 0.42);
      }
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
  description: "Dynamic floorplan lighting from SweetHome3D / live3d",
  preview: true,
  documentationURL: "https://github.com/matjahs/ha-floormap",
});

declare global {
  interface HTMLElementTagNameMap {
    "sunflow-floorplan-card": SunflowFloorplanCard;
  }
}
