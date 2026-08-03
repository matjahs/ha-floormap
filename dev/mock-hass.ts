/** Minimal Home Assistant stub for local playground debugging. */

export interface MockState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

export type HassListener = () => void;

export class MockHass {
  states: Record<string, MockState> = {};
  private listeners = new Set<HassListener>();

  constructor(entityIds: string[]) {
    for (const entity_id of entityIds) {
      this.states[entity_id] = {
        entity_id,
        state: "off",
        attributes: {
          friendly_name: entity_id.replace(/^light\./, "").replace(/_/g, " "),
          supported_color_modes: ["brightness"],
          color_mode: "brightness",
          brightness: 0,
        },
      };
    }
  }

  subscribe(fn: HassListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      fn();
    }
  }

  setState(entity_id: string, on: boolean, brightness = 255): void {
    const st = this.states[entity_id];
    if (!st) {
      this.states[entity_id] = {
        entity_id,
        state: on ? "on" : "off",
        attributes: {
          friendly_name: entity_id,
          brightness: on ? brightness : 0,
        },
      };
    } else {
      st.state = on ? "on" : "off";
      st.attributes = {
        ...st.attributes,
        brightness: on ? brightness : 0,
        color_mode: "brightness",
      };
    }
    this.notify();
  }

  async callService(
    domain: string,
    service: string,
    data?: { entity_id?: string | string[] },
  ): Promise<void> {
    if (domain !== "light") {
      return;
    }
    const ids = Array.isArray(data?.entity_id)
      ? data.entity_id
      : data?.entity_id
        ? [data.entity_id]
        : [];
    for (const id of ids) {
      const cur = this.states[id];
      const isOn = cur?.state === "on";
      if (service === "toggle") {
        this.setState(id, !isOn);
      } else if (service === "turn_on") {
        this.setState(id, true);
      } else if (service === "turn_off") {
        this.setState(id, false);
      }
    }
  }
}

/** Stub HA elements the card may render so the playground stays self-contained. */
export function registerHaStubs(): void {
  if (!customElements.get("ha-state-icon")) {
    class HaStateIcon extends HTMLElement {
      hass?: unknown;
      stateObj?: MockState;
      connectedCallback(): void {
        const on = this.stateObj?.state === "on";
        this.textContent = on ? "💡" : "○";
        this.style.fontSize = "14px";
        this.style.lineHeight = "1";
      }
      attributeChangedCallback(): void {
        this.connectedCallback();
      }
    }
    customElements.define("ha-state-icon", HaStateIcon);
  }
  if (!customElements.get("ha-alert")) {
    class HaAlert extends HTMLElement {
      connectedCallback(): void {
        this.style.display = "block";
        this.style.padding = "8px 12px";
        this.style.background = "#5c1a1a";
        this.style.color = "#fecaca";
        this.style.borderRadius = "6px";
        this.style.fontFamily = "system-ui, sans-serif";
      }
    }
    customElements.define("ha-alert", HaAlert);
  }
}
