import { html, nothing } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import type { ActionHandlerEvent, HomeAssistant } from "custom-card-helpers";
import { handleAction, hasAction } from "custom-card-helpers";
import type { ActionConfig } from "custom-card-helpers";
import type { MarkerState } from "../../types";

export function isDefaultToggleAction(
  config: { tap_action?: ActionConfig } | undefined,
): boolean {
  const a = config?.tap_action;
  if (!a) {
    return true;
  }
  return a.action === "toggle";
}

const HOLD_MS = 500;
const MOVE_PX = 12;

export function renderMarkers(
  hass: HomeAssistant | undefined,
  markers: MarkerState[],
  actions: Record<
    string,
    { tap?: ActionConfig; hold?: ActionConfig; double_tap?: ActionConfig }
  >,
  onAction: (ev: ActionHandlerEvent, entity: string, fixtureId: string) => void,
) {
  return markers.map((m) => {
    const warn = m.params.unavailable || m.params.unknown;
    const brightness = Math.round(m.params.intensity * 100);
    const bg = m.params.on
      ? `rgba(${Math.round(m.params.color[0] * 255)},${Math.round(m.params.color[1] * 255)},${Math.round(m.params.color[2] * 255)},0.85)`
      : "rgba(40,40,40,0.7)";
    const act = actions[m.fixtureId] ?? {};
    let press: {
      x: number;
      y: number;
      timer: number;
      held: boolean;
    } | null = null;

    const clearPress = () => {
      if (press?.timer) {
        window.clearTimeout(press.timer);
      }
      press = null;
    };

    return html`
      <button
        class="sf-marker ${warn ? "sf-marker-warn" : ""}"
        style=${styleMap({
          left: `${m.left}%`,
          top: `${m.top}%`,
          background: bg,
          opacity: warn ? "0.55" : "1",
        })}
        title=${m.friendlyName ?? m.entity}
        aria-label=${m.friendlyName ?? m.entity}
        @pointerdown=${(ev: PointerEvent) => {
          if (ev.button !== undefined && ev.button !== 0) {
            return;
          }
          ev.stopPropagation();
          clearPress();
          const timer = window.setTimeout(() => {
            if (!press) {
              return;
            }
            press.held = true;
            if (hasAction(act.hold)) {
              onAction(
                { detail: { action: "hold" } } as ActionHandlerEvent,
                m.entity,
                m.fixtureId,
              );
            }
          }, HOLD_MS);
          press = { x: ev.clientX, y: ev.clientY, timer, held: false };
          try {
            (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
          } catch {
            // ignore
          }
        }}
        @pointerup=${(ev: PointerEvent) => {
          ev.stopPropagation();
          if (!press) {
            return;
          }
          const moved = Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > MOVE_PX;
          const held = press.held;
          clearPress();
          if (held || moved) {
            return;
          }
          onAction(
            { detail: { action: "tap" } } as ActionHandlerEvent,
            m.entity,
            m.fixtureId,
          );
        }}
        @pointercancel=${() => clearPress()}
        @dblclick=${(ev: Event) => {
          ev.stopPropagation();
          ev.preventDefault();
          if (hasAction(act.double_tap)) {
            onAction(
              { detail: { action: "double_tap" } } as ActionHandlerEvent,
              m.entity,
              m.fixtureId,
            );
          }
        }}
        @contextmenu=${(ev: Event) => {
          ev.preventDefault();
          ev.stopPropagation();
        }}
      >
        ${hass
          ? html`<ha-state-icon .hass=${hass} .stateObj=${hass.states[m.entity]}></ha-state-icon>`
          : html`<span class="sf-dot"></span>`}
        ${m.params.on ? html`<span class="sf-pct">${brightness}%</span>` : nothing}
      </button>
    `;
  });
}

export function dispatchMarkerAction(
  node: HTMLElement,
  hass: HomeAssistant,
  config: { entity: string; tap_action?: ActionConfig; hold_action?: ActionConfig; double_tap_action?: ActionConfig },
  action: string,
): void {
  handleAction(
    node,
    hass,
    {
      entity: config.entity,
      tap_action: config.tap_action ?? { action: "toggle" },
      hold_action: config.hold_action ?? { action: "more-info" },
      double_tap_action: config.double_tap_action ?? { action: "more-info" },
    },
    action,
  );
}
