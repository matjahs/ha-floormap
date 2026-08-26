/**
 * Solar position (Meeus / SunCalc-style), matching Home Assistant `sun.sun`
 * azimuth (0 = north, clockwise) and elevation in degrees.
 *
 * Adapted from SunCalc (MIT) — inlined to avoid a runtime dependency.
 */

const { PI, sin, cos, tan, asin, atan2: atan } = Math;
const rad = PI / 180;
const dayMs = 1000 * 60 * 60 * 24;
const J1970 = 2440588;
const J2000 = 2451545;

function toDays(date: Date): number {
  return date.valueOf() / dayMs - 0.5 + J1970 - J2000;
}

function deltaT(d: number): number {
  const y = 2000 + d / 365.2425;
  let t: number;
  if (y < 1920) {
    t = y - 1900;
    return -2.79 + t * (1.494119 + t * (-0.0598939 + t * (0.0061966 - t * 0.000197)));
  }
  if (y < 1941) {
    t = y - 1920;
    return 21.2 + t * (0.84493 + t * (-0.0761 + t * 0.0020936));
  }
  if (y < 1961) {
    t = y - 1950;
    return 29.07 + t * (0.407 + t * (-1 / 233 + t / 2547));
  }
  if (y < 1986) {
    t = y - 1975;
    return 45.45 + t * (1.067 + t * (-1 / 260 - t / 718));
  }
  if (y < 2005) {
    t = y - 2000;
    return (
      63.86 +
      t *
        (0.3345 +
          t * (-0.060374 + t * (0.0017275 + t * (0.000651814 + t * 0.00002373599))))
    );
  }
  if (y < 2050) {
    t = y - 2000;
    return 62.92 + t * (0.32217 + t * 0.005589);
  }
  t = (y - 1820) / 100;
  return -20 + 32 * t * t - 0.5628 * (2150 - y);
}

function toDaysTT(d: number): number {
  return d + deltaT(d) / 86400;
}

function azimuth(H: number, phi: number, dec: number): number {
  return (atan(sin(H), cos(H) * sin(phi) - tan(dec) * cos(phi)) / rad + 540) % 360;
}

function altitude(H: number, phi: number, dec: number): number {
  return asin(sin(phi) * sin(dec) + cos(phi) * cos(dec) * cos(H));
}

function siderealTime(d: number, lw: number): number {
  return rad * (280.46061837 + 360.98564736629 * d) - lw;
}

function astroRefraction(h: number): number {
  const alt = h < 0 ? 0 : h;
  return 0.0002967 / tan(alt + 0.00312536 / (alt + 0.08901179));
}

function sunCoords(d: number): { ra: number; dec: number } {
  const t = d / 36525;
  const L0 = rad * (280.46646 + t * (36000.76983 + t * 0.0003032));
  const M = rad * (357.52911 + t * (35999.05029 - t * 0.0001537));
  const sinM = sin(M);
  const cosM = cos(M);
  const C =
    rad *
    ((1.914602 - t * (0.004817 + t * 0.000014)) * sinM +
      (0.019993 - 0.000101 * t) * 2 * sinM * cosM +
      0.000289 * sinM * (3 - 4 * sinM * sinM));
  const Om = rad * (125.04 - 1934.136 * t);
  const L = L0 + C - rad * (0.00569 + 0.00478 * sin(Om));
  const e =
    rad * (23.439291 - t * (0.0130042 + t * (0.00000016 - t * 0.000000504))) +
    rad * 0.00256 * cos(Om);
  return {
    ra: atan(cos(e) * sin(L), cos(L)),
    dec: asin(sin(e) * sin(L)),
  };
}

export interface SolarLocation {
  latitude: number;
  longitude: number;
}

/** Waalbandijk 469, Nijmegen area (Floorplanner reference location). */
export const WAALBANDIJK_SUN_LOCATION: SolarLocation = {
  // Nijmegen / Waalbandijk area (not Amsterdam).
  latitude: 51.845,
  longitude: 5.863,
};

export interface SolarPosition {
  azimuth: number;
  elevation: number;
}

/** Geographic sun pose for a timestamp and location (HA-compatible azimuth). */
export function solarPosition(
  date: Date,
  latitude: number,
  longitude: number,
): SolarPosition {
  const lw = rad * -longitude;
  const phi = rad * latitude;
  const d = toDays(date);
  const c = sunCoords(toDaysTT(d));
  const H = siderealTime(d, lw) - c.ra;
  const h = altitude(H, phi, c.dec);
  return {
    azimuth: azimuth(H, phi, c.dec),
    elevation: (h + astroRefraction(h)) / rad,
  };
}
