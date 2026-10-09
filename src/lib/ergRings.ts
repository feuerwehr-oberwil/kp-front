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
// MeteoSwiss / Open-Meteo) it is drawn as an oval leaning downwind that CONTAINS the ERG's
// protective action zone — a square of side D downwind of the placard — whole, corners
// included (ergZoneEllipse; #305 review: a narrower oval left buildings ERG puts in the zone
// outside every line). The isolation circle stays a circle. No wind, a stale / future / far /
// calm one, or a forecast turn within 2 h → the old full circle, and the panel says why
// (ergWind). Still derived, never stored: the oval turns with the next reading and follows the
// marker. Karte only, like the rings.

import type { Entity, LngLat, PreparedMapOverlay, WeatherData } from '../types'
import { appConfig } from '../config/appConfig'
import { lookupErg, type ErgTihRow } from './erg'
import { UN_CAPABLE } from './symbols'
import { doneOf } from './objectDone'
import { isDaytime, lastSunEdge, type Coord } from './daylight'
import { fillTemplate, formatTime } from './format'
import { M_PER_LAT } from './geo'
import { parseWeatherTime } from './weatherTime'

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

/** The smaller angle between two bearings, 0–180 (backend observations · turn). */
export function bearingTurn(a: number, b: number): number {
  const d = Math.abs((((b - a) % 360) + 360) % 360)
  return d > 180 ? 360 - d : d
}

/** Whether the live wind can aim the protective distance, and if not, why. `fromDeg` is the
 *  meteorological FROM bearing; `toDeg` (+180) is where a plume goes. `model`: the reading is
 *  the Open-Meteo point model, not a station's measurement (the panel says «Windmodell»).
 *  `shift`: the forecast turn that made it a circle (reason 'turning'). */
export type ErgWind =
  | { ok: true; fromDeg: number; toDeg: number; speedKmh: number; at: Date; source: string; station: string | null; distanceKm: number | null; model: boolean }
  | { ok: false; reason: 'none' | 'stale' | 'future' | 'far' | 'calm' | 'turning'; speedKmh: number | null; at: Date | null; source: string | null; station: string | null; distanceKm: number | null; model: boolean; shift?: { fromDeg: number; inMin: number } }

/** The one judge of the wind behind the oval — the map and the panel both ask it, so they can
 *  never disagree. Anything short of a fresh, near, steady wind with some strength is a circle:
 *  - none     no reading, or no direction / no speed to judge it by
 *  - stale    older than `windStaleMin`, or no time to prove it is current
 *  - future   stamped more than `windFutureToleranceMin` AHEAD of this device — one of the two
 *             clocks is wrong, and nothing says which (#305 review)
 *  - far      the MeteoSwiss station is more than `windMaxStationKm` away (the backend picks the
 *             nearest within 60 km — a wind 40 km off says little about this street)
 *  - calm     under `windCalmBelowKmh` the direction of a 10-min mean is noise
 *  - turning  the forecast turns it by `forecastShiftDeg`+ within `forecastWithinMin`: one oval
 *             would point the wrong way half of that time (#305 review) */
export function ergWind(w: WeatherData | null | undefined, now: Date): ErgWind {
  const cfg = appConfig.ergRings
  const at = parseWeatherTime(w?.observed_at)
  const base = {
    at, source: w?.source ?? null, station: w?.station ?? null, speedKmh: w?.wind_speed_kmh ?? null,
    distanceKm: w?.station_distance_km ?? null, model: w?.source === 'open-meteo',
  }
  if (!w || w.wind_dir_deg == null || !Number.isFinite(w.wind_dir_deg) || w.wind_speed_kmh == null) return { ok: false, reason: 'none', ...base }
  if (!at || now.getTime() - at.getTime() > cfg.windStaleMin * 60_000) return { ok: false, reason: 'stale', ...base }
  if (at.getTime() - now.getTime() > cfg.windFutureToleranceMin * 60_000) return { ok: false, reason: 'future', ...base }
  if (base.distanceKm != null && base.distanceKm > cfg.windMaxStationKm) return { ok: false, reason: 'far', ...base }
  if (w.wind_speed_kmh < cfg.windCalmBelowKmh) return { ok: false, reason: 'calm', ...base }
  const shift = ergWindShiftAhead(w, now)
  if (shift) return { ok: false, reason: 'turning', shift, ...base }
  const fromDeg = ((w.wind_dir_deg % 360) + 360) % 360
  return { ok: true, fromDeg, toDeg: (fromDeg + 180) % 360, speedKmh: w.wind_speed_kmh, at, source: w.source, station: w.station, distanceKm: base.distanceKm, model: base.model }
}

/** The forecast turn that matters: the first Open-Meteo hour within `forecastWithinMin` whose
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

/** The ERG protective action zone for distance D: a SQUARE of side D downwind, the spill at the
 *  middle of its upwind edge (ERG «Introduction to Table 1»). In wind-aligned metres
 *  (along, across) its corners are (0, ±D/2) and (D, ±D/2). */
export function ergSquareCorners(distanceM: number): [along: number, across: number][] {
  const h = distanceM / 2
  return [[0, -h], [0, h], [distanceM, h], [distanceM, -h]]
}

/** The drawn shape: an ellipse centred `corridorCenter`·D downwind with semi-axes
 *  `corridorAlong`·D (along the wind) and `corridorAcross`·D, which CONTAINS the whole ERG square
 *  (#305 review: an oval inside the square left buildings that ERG puts in the zone outside
 *  every line). Containment, centre 0.5·D: (0.5/a)² + (0.5/b)² ≤ 1 at each corner; 0.8 / 0.7
 *  gives 0.90 — the corners sit at ~95 % of the ellipse's radius, a small margin, while the
 *  shape still leans downwind (it reaches 1.3·D downwind and 0.3·D upwind of the placard).
 *  ergRings.test pins the containment numerically. Returns the (along, across) metres. */
export function ergZoneEllipse(distanceM: number): { center: number; a: number; b: number } {
  const cfg = appConfig.ergRings
  return { center: cfg.corridorCenter * distanceM, a: cfg.corridorAlong * distanceM, b: cfg.corridorAcross * distanceM }
}

/** (along, across) metres in the wind's frame → [lng, lat], in the same local flat-earth metres
 *  as lib/geo · circlePolygon — kilometres, not continents. Along the bearing is (sin θ east,
 *  cos θ north), across to its right (cos θ east, −sin θ north). */
export function windFrameToLngLat(origin: LngLat, toDeg: number, along: number, across: number): LngLat {
  const mPerLon = 111320 * Math.cos((origin[1] * Math.PI) / 180)
  const th = (toDeg * Math.PI) / 180
  const east = along * Math.sin(th) + across * Math.cos(th)
  const north = along * Math.cos(th) - across * Math.sin(th)
  return [origin[0] + east / mPerLon, origin[1] + north / M_PER_LAT]
}

/** The downwind oval for protective distance D around the placard at `origin`, the wind blowing
 *  TO `toDeg` (compass bearing, 0 = N, clockwise). A closed [lng, lat] ring (first point repeated)
 *  starting at its far downwind tip. */
export function ergCorridorRing(origin: LngLat, toDeg: number, distanceM: number, n = 72): LngLat[] {
  const { center, a, b } = ergZoneEllipse(distanceM)
  const ring: LngLat[] = []
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n
    ring.push(windFrameToLngLat(origin, toDeg, center + a * Math.cos(t), b * Math.sin(t)))
  }
  return ring
}

/** The oval's far downwind tip. */
export function ergCorridorTip(origin: LngLat, toDeg: number, distanceM: number): LngLat {
  const { center, a } = ergZoneEllipse(distanceM)
  return windFrameToLngLat(origin, toDeg, center + a, 0)
}

const cardinal = (deg: number) => appConfig.copy.weather.cardinals[Math.round((((deg % 360) + 360) % 360) / 45) % 8]

/** «MeteoSchweiz Basel / Binningen (6 km) 12:12» / «Open-Meteo (Modell) 12:15» — where the wind
 *  came from, how far off it was taken, and when. */
function windSource(wind: ErgWind): string {
  const C = appConfig.copy.contextPanel
  const name = wind.source ? (C.ergWindSources[wind.source] ?? wind.source) : ''
  const where = wind.station ? `${wind.station}${wind.distanceKm != null ? ` (${Math.round(wind.distanceKm)} km)` : ''}` : ''
  return [name, where, wind.at && formatTime(wind.at)].filter(Boolean).join(' ')
}

/** The panel's account of the protective distance's SHAPE — what is drawn and with which wind,
 *  the oval's assumption, or the circle and why — so the oval is never an unexplained claim
 *  (AGENTS.md 3am: source, time, assumption, «Planungshilfe / Schätzung»). Reads the copy inside
 *  the call (AGENTS.md · i18n). */
export function ergWindNotes(w: WeatherData | null | undefined, now: Date): { shape: 'oval' | 'circle'; lines: string[] } {
  const C = appConfig.copy.contextPanel
  const wind = ergWind(w, now)
  const src = windSource(wind)
  const kind = wind.model ? C.ergWindModel : C.ergWindMeasured
  if (!wind.ok) {
    const why = wind.reason === 'none' ? C.ergWindNone
      : wind.reason === 'stale' ? (wind.at ? fillTemplate(C.ergWindStale, { kind, src }) : fillTemplate(C.ergWindUntimed, { kind }))
        : wind.reason === 'future' ? fillTemplate(C.ergWindFuture, { kind, src })
          : wind.reason === 'far' ? fillTemplate(C.ergWindFar, { km: Math.round(wind.distanceKm ?? 0), src })
            : wind.reason === 'calm' ? fillTemplate(C.ergWindCalm, { kmh: Math.round(wind.speedKmh ?? 0), src })
              : fillTemplate(C.ergWindTurning, { from: cardinal(wind.shift?.fromDeg ?? 0), deg: Math.round(wind.shift?.fromDeg ?? 0), min: wind.shift?.inMin ?? 0, src })
    return { shape: 'circle', lines: [why] }
  }
  return {
    shape: 'oval',
    lines: [
      fillTemplate(C.ergWindOval, { to: cardinal(wind.toDeg), from: cardinal(wind.fromDeg), deg: Math.round(wind.fromDeg), kmh: Math.round(wind.speedKmh), src }),
      C.ergWindAssume,
    ],
  }
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
      // …and an oval carries its wind on the map too (source + time + «Schätzung»), at its centre
      // on the wind axis — inside the shape and near the placard, so it is on screen whenever the
      // oval is (the far tip fell off the edge at night) — never read off the map without its basis
      const shape = !isolation && wind.ok
        ? {
            kind: 'polygon' as const,
            coords: ergCorridorRing(e.coord, wind.toDeg, ring.radiusM),
            label: done ? undefined : {
              at: windFrameToLngLat(e.coord, wind.toDeg, ergZoneEllipse(ring.radiusM).center, 0),
              lines: [
                fillTemplate(appConfig.copy.contextPanel.ergWindMapHead, { from: cardinal(wind.fromDeg), kmh: Math.round(wind.speedKmh) }),
                fillTemplate(appConfig.copy.contextPanel.ergWindMapFoot, { src: windSource(wind) }),
              ],
            },
          }
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
