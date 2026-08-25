import type { CompassBearings } from "../src/compass";
import type { SunflowFloorplanCard } from "../src/card";

export interface CompassOverlayOptions {
  getCard: () => SunflowFloorplanCard | null;
}

function formatDeg(v: number): string {
  return `${Math.round(v)}°`;
}

export function mountCompassOverlay(host: HTMLElement, opts: CompassOverlayOptions): () => void {
  host.style.position = "relative";

  const wrap = document.createElement("div");
  wrap.className = "pg-compass";
  wrap.innerHTML = `
    <svg viewBox="0 0 100 100" aria-label="Compass" role="img">
      <circle cx="50" cy="50" r="46" class="pg-compass-ring"/>
      <circle cx="50" cy="50" r="38" class="pg-compass-face"/>
      <g class="pg-compass-tick pg-compass-tick--plan" transform="translate(50 50)">
        <line x1="0" y1="-34" x2="0" y2="-24"/>
        <text x="0" y="-18" text-anchor="middle">+Y</text>
      </g>
      <g class="pg-compass-tick pg-compass-tick--geo" transform="translate(50 50)">
        <polygon points="0,-36 -5,-24 5,-24"/>
        <text x="0" y="-14" text-anchor="middle">N</text>
      </g>
      <g class="pg-compass-tick pg-compass-tick--sun" transform="translate(50 50)">
        <circle cx="0" cy="-30" r="4"/>
        <line x1="0" y1="-34" x2="0" y2="-26"/>
      </g>
    </svg>
    <div class="pg-compass-legend">
      <span><i class="pg-compass-swatch pg-compass-swatch--geo"></i>N</span>
      <span><i class="pg-compass-swatch pg-compass-swatch--plan"></i>+Y</span>
      <span><i class="pg-compass-swatch pg-compass-swatch--sun"></i>Sun</span>
    </div>
    <div class="pg-compass-readout"></div>
  `;
  host.append(wrap);

  const planTick = wrap.querySelector(".pg-compass-tick--plan") as SVGGElement;
  const geoTick = wrap.querySelector(".pg-compass-tick--geo") as SVGGElement;
  const sunTick = wrap.querySelector(".pg-compass-tick--sun") as SVGGElement;
  const readout = wrap.querySelector(".pg-compass-readout") as HTMLElement;

  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const card = opts.getCard();
    const b: CompassBearings | null = card?.getCompassBearings() ?? null;
    if (!b) {
      readout.textContent = "waiting for live3d…";
      sunTick.style.opacity = "0";
      return;
    }
    geoTick.setAttribute("transform", `translate(50 50) rotate(${b.geographicNorthScreenDeg})`);
    planTick.setAttribute("transform", `translate(50 50) rotate(${b.planNorthScreenDeg})`);
    if (b.sunScreenDeg != null) {
      sunTick.style.opacity = "1";
      sunTick.setAttribute("transform", `translate(50 50) rotate(${b.sunScreenDeg})`);
    } else {
      sunTick.style.opacity = "0";
    }
    const delta = Math.round(b.planNorthScreenDeg - b.geographicNorthScreenDeg);
    const sunLine =
      b.sunAzimuthDeg != null && b.sunElevationDeg != null
        ? ` · sun ${formatDeg(b.sunAzimuthDeg)}/${formatDeg(b.sunElevationDeg)}`
        : "";
    readout.textContent = `plan +Y=${formatDeg(b.planNorthConfigDeg)} · Δscreen ${formatDeg(delta)}${sunLine}`;
  };

  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    wrap.remove();
  };
}
