import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { HomeAssistant, LovelaceCardEditor } from "custom-card-helpers";
import { fireEvent } from "custom-card-helpers";
import type { SunflowFloorplanCardConfig } from "../types";
import { stubConfig } from "../config";
import type { FloorplanIR } from "../import/ir";
import { importSweetHome3D } from "../import/sweethome3d";
import { importDxf } from "../import/dxf";
import { importSvg } from "../import/svg";
import { importGltfJson, importObj } from "../import/gltf";
import { matchFixtures, type FixtureMatch } from "../matching";
import { projectToPercent, selectCamera } from "../projection";

type Tab = "import" | "mapping" | "tuning" | "yaml";

const EDITOR_TYPE = "sunflow-floorplan-card-editor";

export class SunflowFloorplanCardEditor extends LitElement implements LovelaceCardEditor {
  @property({ attribute: false }) public hass!: HomeAssistant;
  @state() private _config: SunflowFloorplanCardConfig = stubConfig();
  @state() private _tab: Tab = "import";
  @state() private _ir: FloorplanIR | null = null;
  @state() private _matches: FixtureMatch[] = [];
  @state() private _status = "";
  @state() private _warning = "";

  public setConfig(config: SunflowFloorplanCardConfig): void {
    this._config = { ...stubConfig(), ...config };
    if (config.ir) {
      this._ir = config.ir;
    }
  }

  private _emit(config: SunflowFloorplanCardConfig): void {
    this._config = config;
    fireEvent(this, "config-changed", { config });
  }

  private async _onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    this._status = `Parsing ${file.name}…`;
    this._warning = "";
    try {
      const buf = await file.arrayBuffer();
      const name = file.name.toLowerCase();
      let ir: FloorplanIR;
      if (name.endsWith(".sh3d") || name.endsWith(".xml")) {
        ir = await importSweetHome3D(buf, file.name);
      } else if (name.endsWith(".dxf")) {
        ir = importDxf(new TextDecoder().decode(buf), file.name);
        this._warning =
          "Floorplanner DXF imported walls/rooms only. Dynamic per-light rendering requires a SweetHome3D model or a manual baked pass set.";
      } else if (name.endsWith(".svg")) {
        ir = importSvg(new TextDecoder().decode(buf), file.name);
        this._warning =
          "SVG plan imported as room hotspots. Pair with a base plate and manual fixture placement for lighting.";
      } else if (name.endsWith(".gltf") || name.endsWith(".glb")) {
        if (name.endsWith(".glb")) {
          throw new Error("GLB binary parse not yet supported in editor; use .gltf JSON");
        }
        ir = importGltfJson(JSON.parse(new TextDecoder().decode(buf)), file.name);
        this._warning = "glTF imported for bounds only. Place fixtures manually.";
      } else if (name.endsWith(".obj")) {
        ir = importObj(new TextDecoder().decode(buf), file.name);
        this._warning = "OBJ imported for bounds only. Place fixtures manually.";
      } else {
        throw new Error("Unsupported file type");
      }
      this._ir = ir;
      this._refreshMatches();
      this._emit({ ...this._config, ir });
      this._status = `Imported ${ir.fixtures.length} fixtures, ${ir.rooms.length} rooms, ${ir.cameras.length} cameras`;
      this._tab = "mapping";
    } catch (e) {
      this._status = e instanceof Error ? e.message : String(e);
    }
  }

  private _refreshMatches(): void {
    if (!this._ir || !this.hass) {
      return;
    }
    const entities = Object.keys(this.hass.states)
      .filter((id) => id.startsWith("light."))
      .map((entity_id) => {
        const st = this.hass.states[entity_id]!;
        return {
          entity_id,
          friendly_name: st.attributes.friendly_name as string | undefined,
          area_id: (st.attributes as { area_id?: string }).area_id,
        };
      });
    this._matches = matchFixtures(this._ir, entities);
  }

  private _applyBestMatches(): void {
    const entities = { ...(this._config.entities ?? {}) };
    for (const m of this._matches) {
      if (m.best) {
        entities[m.fixtureId] = { entity: m.best.entity_id };
      }
    }
    this._emit({ ...this._config, entities });
  }

  private _setEntity(fixtureId: string, entity: string): void {
    const prev = this._config.entities?.[fixtureId] ?? { entity: "" };
    const entities = {
      ...(this._config.entities ?? {}),
      [fixtureId]: { ...prev, entity },
    };
    this._emit({ ...this._config, entities });
  }

  private _setGroup(fixtureId: string, group: string): void {
    const prev = this._config.entities?.[fixtureId] ?? { entity: "" };
    const entities = {
      ...(this._config.entities ?? {}),
      [fixtureId]: { ...prev, group: group || undefined },
    };
    this._emit({ ...this._config, entities });
  }

  private _setTapAction(fixtureId: string, action: string): void {
    const prev = this._config.entities?.[fixtureId] ?? { entity: "" };
    const tap_action =
      action === "toggle" || !action
        ? undefined
        : action === "more-info"
          ? { action: "more-info" as const }
          : { action: "none" as const };
    const entities = {
      ...(this._config.entities ?? {}),
      [fixtureId]: { ...prev, tap_action },
    };
    this._emit({ ...this._config, entities });
  }

  private _setGain(fixtureId: string, gain: number): void {
    const overrides = {
      ...(this._config.overrides ?? {}),
      [fixtureId]: { ...(this._config.overrides?.[fixtureId] ?? {}), gain },
    };
    this._emit({ ...this._config, overrides });
  }

  private _onPreviewClick(ev: MouseEvent): void {
    if (!this._ir) {
      return;
    }
    const el = ev.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const left = ((ev.clientX - rect.left) / rect.width) * 100;
    const top = ((ev.clientY - rect.top) / rect.height) * 100;
    const name = window.prompt("Fixture name for this marker?");
    if (!name) {
      return;
    }
    const id = `manual_${Date.now().toString(36)}`;
    const cam = selectCamera(this._ir.cameras);
    // Store as override marker; fixture added to IR for mapping
    const ir = {
      ...this._ir,
      fixtures: [
        ...this._ir.fixtures,
        {
          id,
          name,
          position: { x: 0, y: 0, z: 100 },
          color: "#ffffff",
          power: 0.5,
        },
      ],
    };
    this._ir = ir;
    const overrides = {
      ...(this._config.overrides ?? {}),
      [id]: { marker: [left, top] as [number, number] },
    };
    this._emit({ ...this._config, ir, overrides });
    this._refreshMatches();
    void cam;
  }

  protected override render() {
    return html`
      <div class="tabs">
        ${(["import", "mapping", "tuning", "yaml"] as Tab[]).map(
          (t) => html`
            <button class=${this._tab === t ? "active" : ""} @click=${() => (this._tab = t)}>
              ${t}
            </button>
          `,
        )}
      </div>
      ${this._tab === "import" ? this._renderImport() : nothing}
      ${this._tab === "mapping" ? this._renderMapping() : nothing}
      ${this._tab === "tuning" ? this._renderTuning() : nothing}
      ${this._tab === "yaml" ? this._renderYaml() : nothing}
    `;
  }

  private _renderImport() {
    return html`
      <div class="panel">
        <p>Drop a .sh3d / .dxf / .svg / .gltf / .obj file, or pick one:</p>
        <input type="file" accept=".sh3d,.xml,.dxf,.svg,.gltf,.obj" @change=${this._onFile} />
        ${this._status ? html`<p class="status">${this._status}</p>` : nothing}
        ${this._warning ? html`<ha-alert alert-type="warning">${this._warning}</ha-alert>` : nothing}
        ${this._ir
          ? html`<ul>
              <li>Levels: ${this._ir.levels.length}</li>
              <li>Rooms: ${this._ir.rooms.length}</li>
              <li>Fixtures: ${this._ir.fixtures.length}</li>
              <li>Cameras: ${this._ir.cameras.length}</li>
            </ul>`
          : nothing}
        <p class="hint">
          Click the preview box to manually place fixtures (Floorplanner / glTF workflow).
        </p>
        <div class="preview" @click=${this._onPreviewClick}></div>
      </div>
    `;
  }

  private _renderMapping() {
    if (!this._ir) {
      return html`<p>Import a model first.</p>`;
    }
    if (this._matches.length === 0) {
      this._refreshMatches();
    }
    return html`
      <div class="panel">
        <button @click=${this._applyBestMatches}>Apply best matches (≥0.45)</button>
        <table>
          <thead>
            <tr>
              <th>Fixture</th>
              <th>Room</th>
              <th>Suggestion</th>
              <th>Entity</th>
              <th>Group</th>
              <th>Tap</th>
            </tr>
          </thead>
          <tbody>
            ${this._matches.map(
              (m) => html`
                <tr>
                  <td>${m.fixtureName}</td>
                  <td>${m.roomName ?? "—"}</td>
                  <td>
                    ${m.best
                      ? html`${m.best.entity_id}
                        <small>(${(m.best.score * 100).toFixed(0)}%)</small>`
                      : "—"}
                  </td>
                  <td>
                    <input
                      .value=${this._config.entities?.[m.fixtureId]?.entity ?? ""}
                      @change=${(ev: Event) =>
                        this._setEntity(m.fixtureId, (ev.target as HTMLInputElement).value)}
                      placeholder="light.…"
                    />
                  </td>
                  <td>
                    <input
                      .value=${this._config.entities?.[m.fixtureId]?.group ?? ""}
                      @change=${(ev: Event) =>
                        this._setGroup(m.fixtureId, (ev.target as HTMLInputElement).value)}
                      placeholder="kitchen"
                      style="width:6rem"
                    />
                  </td>
                  <td>
                    <select
                      @change=${(ev: Event) =>
                        this._setTapAction(m.fixtureId, (ev.target as HTMLSelectElement).value)}
                    >
                      <option
                        value="toggle"
                        ?selected=${!this._config.entities?.[m.fixtureId]?.tap_action ||
                        this._config.entities?.[m.fixtureId]?.tap_action?.action === "toggle"}
                      >
                        toggle
                      </option>
                      <option
                        value="more-info"
                        ?selected=${this._config.entities?.[m.fixtureId]?.tap_action?.action ===
                        "more-info"}
                      >
                        more-info
                      </option>
                      <option
                        value="none"
                        ?selected=${this._config.entities?.[m.fixtureId]?.tap_action?.action ===
                        "none"}
                      >
                        none
                      </option>
                    </select>
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
        <p class="hint">
          Groups: tag lights in HA with a room label (Settings → Labels), or assign an
          Area. The card uses labels first, then area. YAML <code>group:</code> still
          overrides. With <code>edit_mode: true</code>, use
          <strong>Draw tap area</strong> on the card (select a group chip, click the map) or
          set <code>groups.NAME.tap_area</code> in YAML. Optional
          <code>groups.NAME.entity</code> for a master. Room taps ask Turn on / Turn off.
          Hold on a marker = more-info
          (default). Strips: set <code>segments</code> on the entity entry.
        </p>
      </div>
    `;
  }

  private _renderTuning() {
    const entities = this._config.entities ?? {};
    const cam = this._ir ? selectCamera(this._ir.cameras) : undefined;
    return html`
      <div class="panel">
        <label>
          Mode
          <select
            @change=${(ev: Event) =>
              this._emit({
                ...this._config,
                render: {
                  ...this._config.render,
                  mode: (ev.target as HTMLSelectElement).value as "baked" | "live3d",
                },
              })}
          >
            <option value="baked" ?selected=${this._config.render?.mode === "baked"}>
              baked (SunFlow overlays)
            </option>
            <option
              value="live3d"
              ?selected=${(this._config.render?.mode ?? "live3d") === "live3d"}
            >
              live3d (plan mesh)
            </option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            .checked=${!!this._config.edit_mode}
            @change=${(ev: Event) =>
              this._emit({
                ...this._config,
                edit_mode: (ev.target as HTMLInputElement).checked,
              })}
          />
          Allow Edit lights (drag in live3d)
        </label>
        <label>
          Placements URL
          <input
            type="text"
            .value=${this._config.placements ?? ""}
            placeholder="/local/floorplan/placements.json"
            @change=${(ev: Event) =>
              this._emit({
                ...this._config,
                placements: (ev.target as HTMLInputElement).value || undefined,
              })}
          />
        </label>
        <label>
          Exposure
          <input
            type="number"
            step="0.1"
            .value=${String(this._config.render?.exposure ?? 1)}
            @change=${(ev: Event) =>
              this._emit({
                ...this._config,
                render: {
                  ...this._config.render,
                  exposure: Number.parseFloat((ev.target as HTMLInputElement).value),
                },
              })}
          />
        </label>
        ${Object.keys(entities).map((id) => {
          const fx = this._ir?.fixtures.find((f) => f.id === id);
          const o = this._config.overrides?.[id];
          let markerNote = "";
          if (fx && cam) {
            const pose = o?.position
              ? { x: o.position[0], y: o.position[1], z: o.position[2] }
              : fx.position;
            const pct = projectToPercent(cam, pose, { aspect: 720 / 405 });
            markerNote = `proj ${pct.left.toFixed(1)}%, ${pct.top.toFixed(1)}%`;
            if (o?.position) {
              markerNote += ` · pos [${o.position.map((n) => n.toFixed(0)).join(", ")}]`;
            }
          }
          return html`
            <div class="tune-row">
              <strong>${fx?.name ?? id}</strong>
              <span>${markerNote}</span>
              <label>
                gain
                <input
                  type="number"
                  step="0.1"
                  .value=${String(this._config.overrides?.[id]?.gain ?? 1)}
                  @change=${(ev: Event) =>
                    this._setGain(id, Number.parseFloat((ev.target as HTMLInputElement).value))}
                />
              </label>
            </div>
          `;
        })}
      </div>
    `;
  }

  private _renderYaml() {
    return html`
      <div class="panel">
        <p>Copy this into your dashboard YAML (after saving assets via the CLI):</p>
        <textarea readonly rows="16">${JSON.stringify(this._config, null, 2)}</textarea>
      </div>
    `;
  }

  static override styles = css`
    .tabs {
      display: flex;
      gap: 0.25rem;
      margin-bottom: 0.75rem;
    }
    .tabs button {
      padding: 0.4rem 0.75rem;
      border-radius: 6px;
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      cursor: pointer;
    }
    .tabs button.active {
      background: var(--primary-color);
      color: var(--text-primary-color, #fff);
    }
    .panel {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
    }
    th,
    td {
      border-bottom: 1px solid var(--divider-color);
      padding: 0.35rem;
      text-align: left;
    }
    .preview {
      height: 160px;
      background: repeating-conic-gradient(#333 0% 25%, #222 0% 50%) 50% / 20px 20px;
      border-radius: 8px;
      cursor: crosshair;
    }
    textarea {
      width: 100%;
      font-family: var(--code-font-family, monospace);
      font-size: 0.75rem;
    }
    .hint,
    .status {
      font-size: 0.85rem;
      opacity: 0.85;
    }
    .tune-row {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      flex-wrap: wrap;
    }
  `;
}

if (!customElements.get(EDITOR_TYPE)) {
  try {
    customElements.define(EDITOR_TYPE, SunflowFloorplanCardEditor);
  } catch {
    // ignore duplicate registration
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "sunflow-floorplan-card-editor": SunflowFloorplanCardEditor;
  }
}
