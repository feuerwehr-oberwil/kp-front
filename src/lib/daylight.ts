// Is it daytime at a coordinate right now? Drives the automatic day/night theme
// switch (theme = 'auto'), so the UI dims itself after dusk without the EL touching
// anything — the 3am tenet's "right default, place don't configure".
//
// Pure (no DOM, no clock of its own — the caller passes the Date), so it's unit-testable.
// Uses the NOAA solar-position approximation (good to ~1 min, far more than enough to
// decide day vs night). Returns elevation in degrees; daytime = sun above the standard
// −0.833° horizon (accounts for atmospheric refraction + the sun's radius).

export type Coord = [number, number] // [lng, lat], WGS84

// Neutral national fallback (Switzerland centroid) — used before an incident coordinate
// is known (e.g. at cold boot), so 'auto' still resolves sunrise/sunset sensibly.
export const FALLBACK_COORD: Coord = [8.2275, 46.8182]

const RAD = Math.PI / 180
// standard sunrise/sunset altitude: −50′ below the geometric horizon
const HORIZON_DEG = -0.833

/** Solar elevation angle (degrees) at a coordinate and instant (NOAA approximation). */
export function solarElevationDeg([lng, lat]: Coord, date: Date): number {
  // day of year (1..366) + fractional UTC hour
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0)
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / 86_400_000)
  const hourUTC = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600

  // fractional year (radians)
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hourUTC - 12) / 24)

  // equation of time (minutes) + solar declination (radians) — NOAA Fourier series
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g))
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g)

  // true solar time (minutes) → hour angle (radians); timezone is 0 because the Date is UTC
  const trueSolarMin = hourUTC * 60 + eqTime + 4 * lng
  const hourAngle = (trueSolarMin / 4 - 180) * RAD

  const latR = lat * RAD
  const cosZenith =
    Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(hourAngle)
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith)))
  return 90 - zenith / RAD
}

/** True when the sun is above the horizon at `coord` (defaults to the brigade region). */
export function isDaytime(coord: Coord | null | undefined, date: Date): boolean {
  return solarElevationDeg(coord ?? FALLBACK_COORD, date) > HORIZON_DEG
}
