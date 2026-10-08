// ERG Schutzabstand rings — the placard's isolation/protective distances drawn on the Karte
// (Feldtest Manuel, 07.09.: «kannst ja gleich einen Radius zeichnen, automatisch. Mit Warnung»).
//
// Derived, never stored: the rings are computed from the placard entity's UN number on every
// render, so they follow the marker, vanish with it, and can never drift out of sync the way a
// hand-drawn Absperrkreis does. They ride the placard's own layer, so hiding «taktisch» hides
// them too. ⚠️ Like the panel's ERG block they are a Planungshilfe (AGENTS.md 3am rule): the
// assumptions — first TIH row, day or night by the sun at the placard, the shape of the
// protective zone — are named here and surfaced next to the control in the ContextPanel, not
// hidden.
//
// The protective distance is a DOWNWIND distance (F4, 09.10.2026 — owner: «not a triangle but
// more of an oval shape»). With a usable live wind (the top bar's reading, backend weather ·
// MeteoSwiss / Open-Meteo) it is drawn as an oval that starts at the placard and reaches the
// ERG distance along the direction the wind blows TO; the isolation circle stays a circle
// around the placard, so the two together are the keyhole. The ERG's own protective action
// zone is a square of that side downwind; the oval is its core (width: appConfig.ergRings ·
// corridorWidthRatio), not its corners — the panel says so. No wind, a calm one or a stale one
// → the old full circle, and the panel says why (ergWind). Still derived, never stored: the
// oval turns with the next reading and follows the marker. Karte only, like the rings.

import type { Entity, LngLat, PreparedMapOverlay, WeatherData } from '../types'
import { appConfig } from '../config/appConfig'
import { lookupErg, type ErgTihRow } from './erg'
import { UN_CAPABLE } from './symbols'
import { doneOf } from './objectDone'
import { isDaytime, lastSunEdge, type Coord } from './daylight'
import { fillTemplate, formatTime } from './format'
import { M_PER_LAT } from './geo'

/** The per-placard mode (SymbolProps.ergRings). Absent = 'small': the whole point is that the
 *  rings appear WITHOUT anybody drawing them, and the small-spill pair is the conservative
 *  first answer the ERG itself opens with. 'large' switches to the large-spill column;
 *  'off' silences a placard whose rings are in the way. */
export type ErgRingMode = 'off' | 'small' | 'large'

export const DEFAULT_ERG_RING_MODE: ErgRingMode = 'small'

/** "30 m" / "0.2 km" / "11.0+ km (7.0+ mi)" → metres. The ERG tables carry nothing but these
 *  shapes; anything else (the 'T3' sentinel, a missing cell) is honestly not a distance. */
export function parseErgDistance(value: string | undefined): number | null {
  if (!value) return null
  const m = /^(\d+(?:\.\d+)?)\+?\s?(m|km)\b/.exec(value.trim())
  if (!m) return null
  const n = Number(m[1])
  return m[2] === 'km' ? Math.round(n * 1000) : Math.round(n)
}

/** ERG protective distances split at sunrise/sunset, so the day/night pick asks the sun at the
 *  placard (lib/daylight, NOAA model; no coordinate → the national fallback). A clock window
 *  (07–19 h until 08.10.2026) drew the day ring on a December evening at 17:30 and the night
 *  ring on a June evening at 20:30. The panel shows both values regardless. */
export function isErgDay(now: Date, coord?: Coord | null): boolean {
  return isDaytime(coord, now)
}

/** The panel's reason for the pick: «Nacht · Sonnenuntergang 16:42» — the horizon crossing that
 *  made it day or night, in the deployment's time format. Just «Tag»/«Nacht» when the sun has
 *  not crossed within 24 h. Reads the copy inside the call (AGENTS.md · i18n). */
export function ergDayNote(now: Date, coord?: Coord | null): string {
  const C = appConfig.copy.contextPanel
  const day = isErgDay(now, coord)
  const edge = lastSunEdge(coord, now)
  const head = day ? C.ergDayShort : C.ergNightShort
  if (!edge) return head
  const t = formatTime(edge.at)
  return `${head} · ${fillTemplate(edge.kind === 'sunrise' ? C.ergSunrise : C.ergSunset, { t })}`
}

export interface ErgRing {
  kind: 'isolation' | 'protect'
  radiusM: number
}

/** The rings one placard earns: the initial-isolation circle plus the protective distance for
 *  the current day/night — from the FIRST TIH row (the general scenario; a substance with a
 *  «when spilled in water» split keeps its first answer, the panel lists every row). 'large'
 *  reads the large-spill column and yields nothing on the 'T3' sentinel (see ERG Table 3 —
 *  container and wind decide, which no circle can claim to know). */
export function ergRingsFor(row: ErgTihRow | undefined, mode: ErgRingMode, now: Date, coord?: Coord | null): ErgRing[] {
  if (!row || mode === 'off') return []
  const day = isErgDay(now, coord)
  let isolation: number | null
  let protect: number | null
  if (mode === 'large') {
    if (!row.l || row.l === 'T3') return []
    isolation = parseErgDistance(row.l.li)
    protect = parseErgDistance(day ? row.l.ld : row.l.ln)
  } else {
    isolation = parseErgDistance(row.si)
    protect = parseErgDistance(day ? row.pd : row.pn)
  }
  const rings: ErgRing[] = []
  if (isolation) rings.push({ kind: 'isolation', radiusM: isolation })
  // the protective ring only outside the isolation one — a smaller/equal circle underneath
  // would just double the line
  if (protect && (!isolation || protect > isolation)) rings.push({ kind: 'protect', radiusM: protect })
  return rings
}

// ── the wind behind the oval ─────────────────────────────────────────────────────────────

/** An ISO time from the weather feed. Open-Meteo answers in GMT WITHOUT a zone suffix
 *  («2026-10-09T14:15»), which `Date.parse` would read as device-local time — so a stamp
 *  without a zone is UTC here. null for anything unreadable. */
export function parseWeatherTime(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`
  const t = Date.parse(zoned)
  return Number.isFinite(t) ? new Date(t) : null
}

/** The smaller angle between two bearings, 0–180 (backend observations · turn). */
export function bearingTurn(a: number, b: number): number {
  const d = Math.abs((((b - a) % 360) + 360) % 360)
  return d > 180 ? 360 - d : d
}

/** Whether the live wind can aim the protective distance, and if not, why.
 *  `fromDeg` is the meteorological FROM bearing; `toDeg` (+180) is where a plume goes. */
export type ErgWind =
  | { ok: true; fromDeg: number; toDeg: number; speedKmh: number; at: Date; source: string; station: string | null }
  | { ok: false; reason: 'none' | 'calm' | 'stale'; speedKmh: number | null; at: Date | null; source: string | null; station: string | null }

export function ergWind(w: WeatherData | null | undefined, now: Date): ErgWind {
  const cfg = appConfig.ergRings
  const at = parseWeatherTime(w?.observed_at)
  const base = { at, source: w?.source ?? null, station: w?.station ?? null, speedKmh: w?.wind_speed_kmh ?? null }
  // no reading, no direction, or no speed to judge it by — nothing aims anything
  if (!w || w.wind_dir_deg == null || !Number.isFinite(w.wind_dir_deg) || w.wind_speed_kmh == null) return { ok: false, reason: 'none', ...base }
  // a reading without a time cannot prove it is current; one from the past hour-ish can.
  // (a time AHEAD of the device is a skewed clock, not a stale reading)
  if (!at || now.getTime() - at.getTime() > cfg.windStaleMin * 60_000) return { ok: false, reason: 'stale', ...base }
  if (w.wind_speed_kmh < cfg.windCalmBelowKmh) return { ok: false, reason: 'calm', ...base }
  const fromDeg = ((w.wind_dir_deg % 360) + 360) % 360
  return { ok: true, fromDeg, toDeg: (fromDeg + 180) % 360, speedKmh: w.wind_speed_kmh, at, source: w.source, station: w.station }
}

/** The forecast turn worth a line: the first Open-Meteo hour within `forecastWithinMin` whose
 *  direction is at least `forecastShiftDeg` off BOTH the model's own current hour (model vs
 *  model — the station and the model are two instruments, backend observations) AND the wind
 *  measured now (never announce a turn to where the wind already blows). An hour too calm to
 *  have a direction is skipped. null when nothing turns, or no forecast came with the reading. */
export function ergWindShiftAhead(w: WeatherData | null | undefined, now: Date): { fromDeg: number; inMin: number } | null {
  const cfg = appConfig.ergRings
  const rows = (w?.wind_forecast ?? [])
    .map((f) => ({ at: parseWeatherTime(f.at), dir: f.dir_deg, kmh: f.speed_kmh }))
    .filter((f): f is { at: Date; dir: number; kmh: number | null } => !!f.at && f.dir != null && Number.isFinite(f.dir))
    .sort((a, b) => a.at.getTime() - b.at.getTime())
  const t = now.getTime()
  const baseline = rows.filter((f) => f.at.getTime() <= t).pop()
  if (!baseline || w?.wind_dir_deg == null) return null
  for (const f of rows) {
    const dt = f.at.getTime() - t
    if (dt <= 0 || dt > cfg.forecastWithinMin * 60_000) continue
    if (f.kmh == null || f.kmh < cfg.windCalmBelowKmh) continue
    if (bearingTurn(baseline.dir, f.dir) >= cfg.forecastShiftDeg && bearingTurn(w.wind_dir_deg, f.dir) >= cfg.forecastShiftDeg) {
      return { fromDeg: ((f.dir % 360) + 360) % 360, inMin: Math.max(10, Math.round(dt / 600_000) * 10) }
    }
  }
  return null
}

/** The downwind oval: an ellipse whose upwind tip sits ON the placard and whose far tip is
 *  `lengthM` away along `toDeg` (compass bearing, 0 = N, clockwise), `widthM` across at its
 *  middle. A closed [lng, lat] ring (first point repeated), in the same local flat-earth
 *  metres as lib/geo · circlePolygon — kilometres, not continents. */
export function ergCorridorRing(origin: LngLat, toDeg: number, lengthM: number, widthM: number, n = 72): LngLat[] {
  const mPerLon = 111320 * Math.cos((origin[1] * Math.PI) / 180)
  const th = (toDeg * Math.PI) / 180
  const a = lengthM / 2
  const b = widthM / 2
  const ring: LngLat[] = []
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n
    const along = a * (1 - Math.cos(t)) // 0 at the placard, lengthM at the far tip
    const across = b * Math.sin(t)
    // along the bearing (sin θ east, cos θ north), across to its right (cos θ east, −sin θ north)
    const east = along * Math.sin(th) + across * Math.cos(th)
    const north = along * Math.cos(th) - across * Math.sin(th)
    ring.push([origin[0] + east / mPerLon, origin[1] + north / M_PER_LAT])
  }
  return ring
}

const cardinal = (deg: number) => appConfig.copy.weather.cardinals[Math.round((((deg % 360) + 360) % 360) / 45) % 8]

/** The panel's account of the protective distance's SHAPE — one line for what is drawn and
 *  why, one for the oval's assumption, one for a forecast turn — so the oval is never an
 *  unexplained claim (AGENTS.md 3am: source, time, assumption, «Planungshilfe / Schätzung»).
 *  Reads the copy inside the call (AGENTS.md · i18n). */
export function ergWindNotes(w: WeatherData | null | undefined, now: Date): { shape: 'oval' | 'circle'; lines: string[] } {
  const C = appConfig.copy.contextPanel
  const wind = ergWind(w, now)
  // «MeteoSchweiz Basel / Binningen 14:20» — where the wind came from and when it was measured
  const src = [wind.source && (C.ergWindSources[wind.source] ?? wind.source), wind.station, wind.at && formatTime(wind.at)].filter(Boolean).join(' ')
  if (!wind.ok) {
    const why = wind.reason === 'calm'
      ? fillTemplate(C.ergWindCalm, { kmh: Math.round(wind.speedKmh ?? 0), src })
      : wind.reason === 'stale'
        ? (wind.at ? fillTemplate(C.ergWindStale, { src }) : C.ergWindUntimed)
        : C.ergWindNone
    return { shape: 'circle', lines: [why] }
  }
  const lines = [
    fillTemplate(C.ergWindOval, { to: cardinal(wind.toDeg), from: cardinal(wind.fromDeg), deg: Math.round(wind.fromDeg), kmh: Math.round(wind.speedKmh), src }),
    fillTemplate(C.ergWindAssume, { pct: Math.round(appConfig.ergRings.corridorWidthRatio * 100) }),
  ]
  const shift = ergWindShiftAhead(w, now)
  if (shift) lines.push(fillTemplate(C.ergWindShift, { deg: Math.round(shift.fromDeg), from: cardinal(shift.fromDeg), min: shift.inMin }))
  return { shape: 'oval', lines }
}

/** Every ring the current entity set earns, as ready-made map overlays. Pure and cheap: one
 *  Map lookup per placard, so the workspace can recompute it per render. `weather` is the live
 *  reading (or the replay's): with a usable wind the protective ring becomes the downwind oval
 *  (ergWind). Without one — or from a caller that has none — every ring stays a circle. */
export function ergRingOverlays(entities: readonly Entity[], now: Date, weather?: WeatherData | null): PreparedMapOverlay[] {
  const cfg = appConfig.ergRings
  const wind = ergWind(weather, now)
  const overlays: PreparedMapOverlay[] = []
  for (const e of entities) {
    // every UN-speaking symbol earns rings — the Tafel, and since 07.09. the Gas/Chemie
    // hazard symbols too (lib/symbols · UN_CAPABLE, derived from the presets)
    if (e.kind !== 'symbol' || !e.symbol || !UN_CAPABLE.has(e.symbol) || !e.coord) continue
    const un = Object.entries(e.fields ?? {}).find(([k]) => k.replace(/\.$/, '') === 'UN-Nr')?.[1]
    if (!un?.trim()) continue
    const row = lookupErg(un)?.tih?.[0]
    const done = !!doneOf(e)
    for (const ring of ergRingsFor(row, e.ergRings ?? DEFAULT_ERG_RING_MODE, now, e.coord)) {
      const isolation = ring.kind === 'isolation'
      // the protective distance runs downwind when the wind can say where that is; the same
      // overlay id either way, so the shape changes without the layer being remounted
      const shape = !isolation && wind.ok
        ? { kind: 'polygon' as const, coords: ergCorridorRing(e.coord, wind.toDeg, ring.radiusM, ring.radiusM * cfg.corridorWidthRatio) }
        : { kind: 'circle' as const, center: e.coord, radiusM: ring.radiusM }
      overlays.push({
        id: `erg-${e.id}-${ring.kind}`,
        ...shape,
        layer: e.layer,
        color: done ? cfg.doneColor : isolation ? cfg.isolationColor : cfg.protectColor,
        // isolation is the «get everyone out» circle and gets the visible wash; the protective
        // ring is planning distance — dashed line, no fill, so it never reads as a cordon.
        // …and a placard that is «erledigt» greys its rings with its glyph, unfilled (objectDone)
        fillOpacity: isolation && !done ? cfg.isolationFillOpacity : 0,
        lineWidth: appConfig.drawing.circleLineWidth,
        lineDasharray: isolation ? undefined : [2, 2],
      })
    }
  }
  return overlays
}
