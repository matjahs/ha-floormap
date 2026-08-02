import { html, nothing } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import type { ActionHandlerEvent, HomeAssistant } from "custom-card-helpers";
import { handleAction, hasAction } from "custom-card-helpers";
import type { ActionConfig } from "custom-card-helpers";
import type { MarkerState } from "../../types";

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
        @click=${(ev: Event) => {
          ev.stopPropagation();
          onAction(
            { detail: { action: "tap" } } as ActionHandlerEvent,
            m.entity,
            m.fixtureId,
          );
        }}
        @contextmenu=${(ev: Event) => {
          ev.preventDefault();
          if (hasAction(act.hold)) {
            onAction(
              { detail: { action: "hold" } } as ActionHandlerEvent,
              m.entity,
              m.fixtureId,
            );
          }
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
