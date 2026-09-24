// The Lage-Grundgerüst — the handful of things every Lage needs in its first minutes, as a small
// card on the Karte (components/LageGrundgeruestCard). Post-mortem 23.09.2026: after 65 minutes
// the Karte had no Zufahrt, Absperrung, Wasserbezug or Bereitstellungsraum, the hydrant layer had
// been opened fifteen times without a Wasserbezug being set, and the Sammelplatz stood on the
// building plan instead of on the Karte.
//
// It is not a new system: a built-in checklist per Einsatzart whose rows PLACE something — a
// symbol or a line preset — and tick themselves when that thing exists, on the Karte or on any
// plan. Nothing is written until the operator places something, and a placement from here is an
// ordinary placement (undoable, its usual Verlauf row). Not a block: it can be hidden, and it
// goes away by itself once complete.
//
// Station doctrine, not a device preference: the lists come from the deployment config
// (`lageGrundgeruest`, edited in /admin › Lage-Grundgerüst or through `admin_config`), resolved
// against the presets the server ships (`lageGrundgeruestPresets` on GET /api/config — the files
// in backend/app/data/lage_grundgeruest/). Everything here is pure, so the rules are
// node-testable; the hook and the card only feed it.

import type { LngLat, WeatherData } from '../types'
import type { TacticalObject } from './tacticalObjects'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { fmtDistance, haversineM } from './geo'
import { linePresetLabel } from './lineStyle'

/** Where the card suggests putting a slot — backend schemas.LageVorschlag. */
export interface LageVorschlag {
  naechster?: 'hydrant' | null
  wind?: 'auf' | null
  m?: number | null
}

/** One row — backend schemas.LageSlot. `symbol` XOR `linie` (a line preset LABEL). */
export interface LageSlot {
  id: string
  label: string
  symbol?: string | null
  linie?: string | null
  vorschlag?: LageVorschlag | null
  /** shown, never counted: «Helilandeplatz (optional)» must not keep the card open forever */
  optional?: boolean | null
}

export interface LageGrundgeruestConfig {
  preset?: string | null
  /** Einsatzarten the station REPLACED — an empty list is an answer («none for this one») */
  kategorien?: Record<string, LageSlot[]> | null
}

export interface LageGrundgeruestPreset {
  beschreibung?: string | null
  kategorien: Record<string, LageSlot[]>
}

export type LageGrundgeruestPresets = Record<string, LageGrundgeruestPreset>

export const DEFAULT_PRESET = 'fks-standard'
/** The Einsatzart whose list an Einsatz without a known one gets — see `slotsFor`. */
export const FALLBACK_CATEGORY = 'brandbekaempfung'
/** What the server files an alarm under when NO keyword matched (alarm_keywords.json). */
export const UNMATCHED_CATEGORY = 'diverse_einsaetze'

/**
 * Category key → the German string an incident STORES as its `type` (backend divera ·
 * CATEGORY_LABELS). Structural data, not copy: it is what the server writes and what the intake
 * wizard submits (copy.intake.kategorien), so it is never translated. Pinned against the backend
 * by lageGrundgeruest.test.ts, which reads divera.py.
 */
export const CATEGORY_LABELS: Record<string, string> = {
  brandbekaempfung: 'Brandbekämpfung',
  elementarereignis: 'Elementarereignis',
  strassenrettung: 'Strassenrettung',
  technische_hilfeleistung: 'Technische Hilfeleistung',
  oelwehr: 'Ölwehr',
  chemiewehr: 'Chemiewehr',
  strahlenwehr: 'Strahlenwehr',
  einsatz_bahnanlagen: 'Einsatz Bahnanlagen',
  bma_unechte_alarme: 'BMA / unechte Alarme',
  dienstleistungen: 'Dienstleistungen',
  gerettete_tiere: 'Gerettete Tiere',
  diverse_einsaetze: 'Diverse Einsätze',
}

/** The category key of an incident's stored `type`, or null when it names none we know. */
export function categoryKey(type: string | null | undefined): string | null {
  const t = type?.trim()
  if (!t) return null
  if (t in CATEGORY_LABELS) return t
  const hit = Object.entries(CATEGORY_LABELS).find(([, label]) => label.toLowerCase() === t.toLowerCase())
  return hit ? hit[0] : null
}

/** A preset's list for one category — the default preset when the named one is not served. */
export function presetSlots(presets: LageGrundgeruestPresets | null | undefined, preset: string | null | undefined, category: string): LageSlot[] | undefined {
  const p = presets?.[preset || DEFAULT_PRESET] ?? presets?.[DEFAULT_PRESET]
  const list = p?.kategorien?.[category]
  return Array.isArray(list) ? list : undefined
}

/** The list one category runs: the station's own when it set one (an empty one included), else
 *  its preset's; undefined when neither has one. */
export function listFor(cfg: LageGrundgeruestConfig | null | undefined, presets: LageGrundgeruestPresets | null | undefined, category: string): LageSlot[] | undefined {
  const own = cfg?.kategorien
  if (own && Object.prototype.hasOwnProperty.call(own, category) && Array.isArray(own[category])) return own[category]
  return presetSlots(presets, cfg?.preset, category)
}

export interface GrundgeruestSelection {
  category: string
  slots: LageSlot[]
  /** true when the incident named no Einsatzart we know and the Brand list stands in for it */
  fallback: boolean
}

/**
 * Which list the card shows for an incident's `type` — follows a corrected Einsatzart, because it
 * is recomputed from the stored type on every render.
 *
 * ⚠️ No known Einsatzart ⇒ the BRAND list, on purpose. A missing category is the state of an
 * Einsatz whose alarm text matched nothing, or that was opened by hand before anybody filled it
 * in — «we do not know yet», the first minutes this card exists for. The Brand list is the one
 * whose absence cost most (the 23.09.2026 post-mortem was a Brand), and every row of it is
 * something any Lage can use. «Diverse Einsätze» is the server's own word for «no keyword
 * matched», so it falls back the same way — unless the station (or its preset) gave that
 * category a list of its own, which is then a deliberate answer. A KNOWN category with no list
 * (a Tierrettung under fks-standard) shows nothing: the station chose not to cover it.
 */
export function slotsFor(cfg: LageGrundgeruestConfig | null | undefined, presets: LageGrundgeruestPresets | null | undefined, type: string | null | undefined): GrundgeruestSelection {
  const key = categoryKey(type)
  if (key && key !== UNMATCHED_CATEGORY) return { category: key, slots: listFor(cfg, presets, key) ?? [], fallback: false }
  if (key === UNMATCHED_CATEGORY) {
    const own = listFor(cfg, presets, key)
    if (own) return { category: key, slots: own, fallback: false }
  }
  return { category: FALLBACK_CATEGORY, slots: listFor(cfg, presets, FALLBACK_CATEGORY) ?? [], fallback: true }
}

/** The line preset id a slot's `linie` label names (appConfig.drawing.linePresets), if any. */
export function linePresetIdFor(label: string | null | undefined): string | undefined {
  if (!label) return undefined
  return appConfig.drawing.linePresets.find((p) => p.label === label)?.id
}

export interface SlotMatch {
  done: boolean
  /** a matching object has a Karte body (placed there, or baked through a plan's fit) */
  onKarte: boolean
  /** matched ONLY on a plan with no Karte body — the card offers «auf die Karte übernehmen» */
  planOnly: TacticalObject | null
}

/**
 * Whether a slot's thing exists — on the Karte OR on any plan (post-mortem: the Sammelplatz was
 * set on the building plan, and it still counts). One store holds both (lib/tacticalObjects):
 * `entity`/`drawing` is the Karte body, `sheet.anno` the plan body. A plan object whose plan is
 * georeferenced carries a baked Karte body and is simply on the Karte; one on an unlinked sheet
 * has none, and that is the case the card offers to bring onto the Karte.
 *
 * Lines are matched by the NAME their style carries (lineStyle · linePresetLabel), the same way
 * the Verlauf names them — «Zufahrt gezeichnet».
 */
export function slotMatch(slot: LageSlot, objects: readonly TacticalObject[]): SlotMatch {
  let onKarte = false
  let planOnly: TacticalObject | null = null
  for (const o of objects) {
    let karte = false
    let plan = false
    if (slot.symbol) {
      karte = !!o.entity && !o.entity.live && o.entity.kind === 'symbol' && o.entity.symbol === slot.symbol
      plan = !!o.sheet && o.sheet.anno.kind === 'symbol' && o.sheet.anno.symbol === slot.symbol
    } else if (slot.linie) {
      karte = !!o.drawing && o.drawing.kind === 'line' && linePresetLabel(o.drawing) === slot.linie
      plan = !!o.sheet && o.sheet.anno.kind === 'draw' && linePresetLabel(o.sheet.anno) === slot.linie
    }
    if (karte) { onKarte = true; break }
    if (plan && !planOnly) planOnly = o
  }
  return { done: onKarte || planOnly !== null, onKarte, planOnly: onKarte ? null : planOnly }
}

const EARTH_R = 6_371_000

/** The point `m` metres from `from` on the initial bearing `bearingDeg` (great circle). */
export function destinationPoint(from: LngLat, bearingDeg: number, m: number): LngLat {
  const d = m / EARTH_R
  const b = (bearingDeg * Math.PI) / 180
  const la1 = (from[1] * Math.PI) / 180
  const lo1 = (from[0] * Math.PI) / 180
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b))
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2))
  return [((lo2 * 180) / Math.PI + 540) % 360 - 180, (la2 * 180) / Math.PI]
}

/** Below this the wind has no direction worth standing upwind of (a «calm» reading). */
export const CALM_KMH = 2

/**
 * «Wind aufwärts x m» — x metres UPWIND of the Einsatzort. `wind_dir_deg` is the meteorological
 * FROM bearing (types · WeatherData), so upwind is simply that bearing from the incident point.
 * Null when there is no usable direction (no reading, or calm).
 */
export function upwindPoint(center: LngLat, weather: WeatherData | null | undefined, m: number): LngLat | null {
  const dir = weather?.wind_dir_deg
  if (dir == null || !Number.isFinite(dir)) return null
  if (weather?.wind_speed_kmh != null && weather.wind_speed_kmh < CALM_KMH) return null
  return destinationPoint(center, dir, m)
}

// --- the station's hydrant layer -----------------------------------------------------------------

/** The hydrant reference layer among the configured ones: a point GeoJSON layer whose symbol,
 *  id or label says hydrant (the demo's is `SI Ueberflurhydrant`, id `demo-hydrant`). Station
 *  data — there is no fixed id in code. */
export function isHydrantLayer(l: { id: string; label?: string | null; symbol?: string | null; geojson?: string | null; vectorKind?: string | null }): boolean {
  if (!l.geojson || (l.vectorKind && l.vectorKind !== 'point')) return false
  return /hydrant/i.test(l.symbol ?? '') || /hydrant/i.test(l.id) || /hydrant/i.test(l.label ?? '')
}

/** Property keys that carry a hydrant's number, most specific first (case-insensitive). */
const NR_KEYS = ['nr', 'nummer', 'hydrant_nr', 'hydrantnr', 'hydrantennummer', 'number', 'no', 'bezeichnung', 'name', 'id']

/** A hydrant feature's number, if the layer carries one. */
export function hydrantNr(props: Record<string, unknown> | null | undefined): string | null {
  if (!props) return null
  const lower = new Map(Object.entries(props).map(([k, v]) => [k.toLowerCase(), v]))
  for (const k of NR_KEYS) {
    const v = lower.get(k)
    if ((typeof v === 'string' && v.trim()) || typeof v === 'number') return String(v).trim()
  }
  return null
}

export interface HydrantPoint { coord: LngLat; nr: string | null }

/** The Point features of a hydrant FeatureCollection (anything else in it is skipped). */
export function hydrantPoints(fc: unknown): HydrantPoint[] {
  const feats = (fc as { features?: unknown[] } | null)?.features
  if (!Array.isArray(feats)) return []
  const out: HydrantPoint[] = []
  for (const f of feats as { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> }[]) {
    const g = f?.geometry
    if (g?.type !== 'Point' || !Array.isArray(g.coordinates)) continue
    const [lng, lat] = g.coordinates as number[]
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
    out.push({ coord: [lng, lat], nr: hydrantNr(f.properties) })
  }
  return out
}

/** The nearest hydrant to `center`, straight line. */
export function nearestHydrant(center: LngLat, points: readonly HydrantPoint[]): (HydrantPoint & { distanceM: number }) | null {
  let best: (HydrantPoint & { distanceM: number }) | null = null
  for (const p of points) {
    const d = haversineM(center, p.coord)
    if (!best || d < best.distanceM) best = { ...p, distanceM: d }
  }
  return best
}

// --- suggestions ----------------------------------------------------------------------------------

export type Suggestion =
  | { kind: 'hydrant'; coord: LngLat; nr: string | null; distanceM: number }
  | { kind: 'wind'; coord: LngLat; fromDeg: number; m: number }

export interface SuggestionContext {
  center: LngLat
  weather: WeatherData | null | undefined
  /** null = not loaded (or no hydrant layer): no hydrant suggestion, the row still arms the tool */
  hydrants: readonly HydrantPoint[] | null
}

/** Where the card proposes putting a slot's symbol — always only a starting point to drag. */
export function suggestionFor(slot: LageSlot, ctx: SuggestionContext): Suggestion | null {
  const v = slot.vorschlag
  if (!v || !slot.symbol) return null
  if (v.naechster === 'hydrant') {
    const h = ctx.hydrants ? nearestHydrant(ctx.center, ctx.hydrants) : null
    return h ? { kind: 'hydrant', coord: h.coord, nr: h.nr, distanceM: h.distanceM } : null
  }
  if (v.wind === 'auf' && v.m) {
    const coord = upwindPoint(ctx.center, ctx.weather, v.m)
    return coord ? { kind: 'wind', coord, fromDeg: ctx.weather!.wind_dir_deg!, m: v.m } : null
  }
  return null
}

/** The eight-sector index of a bearing — the same sectors the wind badge names
 *  (TopBar · fromLabel), so «aus W» and «westlich» can never disagree. */
const sectorOf = (deg: number) => Math.round((((deg % 360) + 360) % 360) / 45) % 8

/** «Hydrant Nr. 412 · 38 m» / «Wind aus W · Vorschlag westlich, 80 m» — what a suggestion is, in
 *  the words its row says it in. The action («hier setzen») is the card's, beside it. */
export function suggestionText(s: Suggestion): string {
  const C = appConfig.copy.lageGrundgeruest
  if (s.kind === 'hydrant') {
    const dist = fmtDistance(s.distanceM)
    return s.nr ? fillTemplate(C.hydrant, { nr: s.nr, dist }) : fillTemplate(C.hydrantNoNr, { dist })
  }
  const w = appConfig.copy.weather
  const i = sectorOf(s.fromDeg)
  return fillTemplate(C.wind, { from: `${w.from} ${w.cardinals[i]}`, dir: C.directions[i], m: s.m })
}

// --- the card's rows ------------------------------------------------------------------------------

export interface GrundgeruestRow {
  slot: LageSlot
  match: SlotMatch
  suggestion: Suggestion | null
}

export function grundgeruestRows(slots: readonly LageSlot[], objects: readonly TacticalObject[], ctx: SuggestionContext): GrundgeruestRow[] {
  return slots.map((slot) => {
    const match = slotMatch(slot, objects)
    return { slot, match, suggestion: match.done ? null : suggestionFor(slot, ctx) }
  })
}

/** «2 / 6» — optional rows count in neither half. Complete = every required row is done (a list
 *  of only optional rows, or none at all, is never «complete»: there is nothing to finish). */
export function grundgeruestProgress(rows: readonly GrundgeruestRow[]): { done: number; total: number; complete: boolean } {
  const required = rows.filter((r) => !r.slot.optional)
  const done = required.filter((r) => r.match.done).length
  return { done, total: required.length, complete: required.length > 0 && done === required.length }
}
