import { html } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import type { LightParams } from "../../types";

export interface CssLayer {
  fixtureId: string;
  url: string;
}

/**
 * CSS fallback: loses correct linear blending. Uses plus-lighter when available.
 */
export function renderCssFallback(
  baseUrl: string,
  layers: CssLayer[],
  params: Map<string, LightParams>,
  aspect: number,
) {
  return html`
    <div class="sf-css-stack" style=${styleMap({ aspectRatio: `${aspect}` })}>
      <img class="sf-css-base" src=${baseUrl} alt="" draggable="false" />
      ${layers.map((layer) => {
        const p = params.get(layer.fixtureId);
        const opacity = p?.intensity ?? 0;
        return html`
          <img
            class="sf-css-layer"
            src=${layer.url}
            alt=""
            draggable="false"
            style=${styleMap({
              opacity: String(opacity),
              mixBlendMode: "plus-lighter",
            })}
          />
        `;
      })}
    </div>
  `;
}

export const CSS_FALLBACK_STYLES = `
.sf-css-stack {
  position: relative;
  width: 100%;
  overflow: hidden;
}
.sf-css-base, .sf-css-layer {
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
