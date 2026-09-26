import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { haversineM } from './geo'
import { fillTemplate, formatTime } from './format'
import { drawingLogName } from './drawingEdit'
import { lineLabel } from './lineDecor'
import { GPS_GUARD_METRES } from './lineAttachments'
import type { TacticalObject } from './tacticalObjects'
import type { Drawing, Entity, GpsFollowSnapshot, LineAttachment, LineEndpoint, LineRoutingMode, LngLat } from '../types'

/**
 * The live-GPS coupling's way BACK to the Einsatzort (D3, after the Übung on 23.09.2026).
 *
 * «Weiter folgen» was tapped for a TLF that was already back at its depot. The line traced the
 * whole drive (depot → site → depot, a 1.15 km spike on the printed Rapport), and the tap had
 * overwritten the one point that remembered where the hose really ended. And the line editor's
 * «Hier lösen» cut the coupling at the vehicle's CURRENT position — the same spike by a second
 * door. The rules, all pure and all here:
 *
 * 1. **Following starts with a snapshot** (`routingPatch`). The first tap that turns a GPS end into
 *    a trace stores the on-site line in `gps.before`; a later tap never replaces it. It rides with
 *    the attachment, so the sync, the three-way merge, the bake and ↶ carry it for free. A snapshot
 *    whose `confirmedAt` is not the coupling's own is STALE (an older build re-confirmed the end
 *    and carried the field along unread) and counts as none (`freshBefore`).
 * 2. **«Am Einsatzort lösen» really happens on site** (`onSiteCoords`): a followed trace is cut back
 *    to where it stood before following began. It is offered only where that point is KNOWN
 *    (`onSiteKnown`); everywhere else the word is «Hier lösen».
 * 3. **A traced hose may be kept** (product decision, 24.09.2026): «Hier lösen (Spur behalten)»
 *    lets go where the end stands now, with the drive as the laid hose. A hand dragging the end
 *    off lands at the drop point. Only the explicit «Am Einsatzort» buttons cut back.
 * 4. **«Zurück auf Stand am Einsatzort»** (`revertCoords`) puts the snapshotted line back exactly
 *    and detaches it there. Restoring a snapshot is not a placement: the caller writes it with
 *    `gesture: false`, so a plan-drawn hose keeps its sheet and storey.
 * 5. **One Meldung per vehicle** (`gpsNotices`): two hoses on one TLF are one row naming both lines,
 *    and a tap acts on all of that vehicle's ends at once.
 *
 * What is deliberately NOT here: asking again automatically when a following vehicle passes
 * ~1 km (D3-b, undecided).
 */

/** A vehicle back inside this ring of its on-site point is «back» — the same generous ring the
 *  presence log calls «vor Ort» (useVehiclePresenceLog · AT_SCENE_M). */
export const BACK_ON_SITE_M = 150
/** …and it has to have been this far out before «back» means anything — the presence log's
 *  hysteresis, for the same reason: a vehicle that starts following 40 m off is not «back». */
export const AWAY_AGAIN_M = 300
/**
 * The «fährt weg» Meldung is RAISED only this far from the on-site point (25.09.2026, staging
 * walk-through: a parked PIO sat under a permanent «PIO fährt weg · 16 m vom Einsatzort» with a
 * green «Am Einsatzort lassen» — 16 m is GPS scatter). The silent 20 m pause stays exactly as it
 * is (GPS_GUARD_METRES: the line end stays on site); only the QUESTION waits until the vehicle is
 * really going, and a vehicle that comes back under it clears the row without a word. The feed
 * carries no fix accuracy (Traccar positions as proxied by /api/traccar/positions), so there is
 * nothing to widen it by; a vehicle missing from the feed has shown no distance and raises nothing.
 */
export const AWAY_NOTICE_M = 100

const keyOf = (ep: LineEndpoint) => (ep === 'start' ? 'startAttachment' : 'endAttachment') as 'startAttachment' | 'endAttachment'
const endIdx = (coords: readonly unknown[], ep: LineEndpoint) => (ep === 'start' ? 0 : coords.length - 1)
const withEnd = (coords: readonly LngLat[], ep: LineEndpoint, p: LngLat): LngLat[] =>
  coords.map((q, i) => (i === endIdx(coords, ep) ? p : q))
const samePoint = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1]
const copy = (coords: readonly LngLat[]): LngLat[] => coords.map((p) => [...p] as LngLat)

type Gps = NonNullable<LineAttachment['gps']>

export const attachmentAt = (d: Pick<Drawing, 'startAttachment' | 'endAttachment'>, ep: LineEndpoint): LineAttachment | undefined => d[keyOf(ep)]

/**
 * The snapshot, if it still describes THIS coupling. The follower never changes `confirmedAt`;
 * only a confirmation does, and ours drops the snapshot when it confirms. An older build that
 * re-confirms keeps the field it does not know — with a `confirmedAt` that no longer matches.
 */
export function freshBefore(gps: Gps | undefined): GpsFollowSnapshot | undefined {
  const b = gps?.before
  return b && b.coords?.length >= 2 && samePoint(b.confirmedAt, gps!.confirmedAt) ? b : undefined
}

/** Is the on-site point of this end KNOWN — so «Am Einsatzort» is a true word for it? A fresh
 *  snapshot knows it; a guarded end is on site by the guard; a paused one is, when its `lastSafe`
 *  is still inside the guard (it paused, it never traced). A trace without a snapshot does not. */
export function onSiteKnown(gps: Gps): boolean {
  if (freshBefore(gps)) return true
  if (gps.state === 'guarded') return true
  return gps.state === 'paused' && haversineM(gps.lastSafe, gps.confirmedAt) < GPS_GUARD_METRES
}

/** Has this end traced a drive — following now, or stopped after following? */
export function hasTraced(gps: Gps): boolean {
  return gps.state === 'continuous' || (gps.state === 'paused' && !!freshBefore(gps)) || (gps.state === 'paused' && !onSiteKnown(gps))
}

/** The vehicle position the operator last knew as «on site»: the snapshot's, else the guard's own
 *  point — `lastSafe` while guarded or paused (a paused end STAYS there), the last confirmation
 *  for a trace without a snapshot. */
export function onSiteAnchor(gps: Gps): LngLat {
  return freshBefore(gps)?.lastSafe ?? (gps.state === 'continuous' ? gps.confirmedAt : gps.lastSafe)
}

/**
 * The attachment patch for a routing choice on one end — «Weiter folgen», «Spur», «Direkt»,
 * «Folgen stoppen» — or null when the end is not attached.
 *
 * `resolvedEnd` is the end as the screen shows it right now (lib/lineAttachments ·
 * resolveMapDrawings): that is the on-site point the snapshot keeps. `targetCoord` is the vehicle
 * now, which a fresh confirmation («Direkt» out of a pause) takes as its new on-site point.
 */
export function routingPatch(d: Drawing, ep: LineEndpoint, routing: LineRoutingMode, ctx: { resolvedEnd: LngLat; targetCoord?: LngLat; at: string }): Partial<Drawing> | null {
  const key = keyOf(ep)
  const a = d[key]
  if (!a) return null
  if (!a.gps) return { [key]: { ...a, routing } }
  const gps = a.gps
  if (routing === 'trace') {
    // ⚠️ Taken ONCE. A second «Weiter folgen» after «Folgen stoppen» must not photograph the drive
    // as the on-site state — overwriting it is exactly the loss this field exists to prevent. A
    // STALE one (another coupling's, carried by an older build) is replaced.
    const before: GpsFollowSnapshot = freshBefore(gps) ?? {
      coords: withEnd(d.coords, ep, ctx.resolvedEnd),
      routing: a.routing, state: gps.state, confirmedAt: gps.confirmedAt, lastSafe: gps.lastSafe, at: ctx.at,
    }
    return { [key]: { ...a, routing, gps: { ...gps, state: 'continuous' as const, before } } }
  }
  if (gps.state === 'continuous') return { [key]: { ...a, routing, gps: { ...gps, state: 'paused' as const } } }
  // a fresh confirmation: the vehicle is here now, and this IS the on-site state — nothing to go back to
  const rest = { ...gps }
  delete rest.before
  return { [key]: { ...a, routing, gps: { ...rest, state: 'guarded' as const, ...(ctx.targetCoord ? { confirmedAt: ctx.targetCoord, lastSafe: ctx.targetCoord } : {}) } } }
}

/**
 * The line's coords after «Am Einsatzort lösen» on one end, and whether that REMOVED vertices
 * (the caller writes a Verlauf row then — a drive taken out of the record is not arranging).
 *
 * `fallback` is where the end goes when there is no snapshot: the screen's resolved end, which the
 * guard keeps on site for a guarded or never-traced paused end.
 *
 * With a fresh snapshot the drive is cut off: the line keeps everything up to the vertex that
 * stood next to the on-site end before following began, and ends on the snapshot's on-site point.
 * That vertex is FOUND by value, not by index — the other end may be tracing too (prepending
 * vertices), or a hand may have inserted one. Not found (a hand deleted it) ⇒ the snapshot itself.
 */
export function onSiteCoords(d: Drawing, ep: LineEndpoint, fallback: LngLat): { coords: LngLat[]; removed: boolean } {
  const before = freshBefore(attachmentAt(d, ep)?.gps)
  if (!before) return { coords: withEnd(d.coords, ep, fallback), removed: false }
  const b = before.coords
  const onSite = b[endIdx(b, ep)]
  let coords: LngLat[] | null = null
  if (b.length === 2) {
    // the neighbour IS the other end — whatever it is now
    coords = ep === 'end' ? [d.coords[0], onSite] : [onSite, d.coords[d.coords.length - 1]]
  } else if (ep === 'end') {
    const anchor = b[b.length - 2]
    for (let i = d.coords.length - 2; i >= 0; i--) if (samePoint(d.coords[i], anchor)) { coords = [...d.coords.slice(0, i + 1), onSite]; break }
  } else {
    const anchor = b[1]
    for (let i = 1; i < d.coords.length; i++) if (samePoint(d.coords[i], anchor)) { coords = [onSite, ...d.coords.slice(i)]; break }
  }
  const out = copy(coords ?? b)
  return { coords: out, removed: out.length < d.coords.length }
}

/** «Zurück auf Stand am Einsatzort»: the snapshotted line, exactly — or null without a fresh one. */
export function revertCoords(d: Drawing, ep: LineEndpoint): LngLat[] | null {
  const before = freshBefore(attachmentAt(d, ep)?.gps)
  return before ? copy(before.coords) : null
}

/** «Leitung 1» where the hose has a number, else the name every drawing row uses. */
export const gpsLineName = (d: Drawing): string =>
  d.lineNo != null && !(d.label ?? '').trim() ? lineLabel(d) : drawingLogName(d)

/** «Leitung 1, Leitung 2» — the lines one Meldung / one Verlauf row speaks about. */
export const gpsLineNames = (ds: readonly Drawing[]): string => [...new Set(ds.map(gpsLineName))].join(', ')

/**
 * The words of «Zurück auf Stand am Einsatzort» for the ends one tap acted on: the ONE Verlauf row
 * and the ↶ caption. `vehicle` is the vehicle's label; absent (it dropped out of the feed), the
 * row names no vehicle rather than a placeholder.
 */
export function gpsRevertWords(ends: readonly GpsEnd[], vehicle?: string): { row: string; step: string } {
  const L = appConfig.copy.log, C = appConfig.copy.drawingEditor
  const name = gpsLineNames(ends.map((e) => e.drawing))
  const time = [...new Set(ends.flatMap((e) => (e.before ? [formatTime(new Date(e.before.at))] : [])))].join(' / ')
  return {
    row: vehicle ? fillTemplate(L.gpsReverted, { name, time, vehicle }) : fillTemplate(L.gpsRevertedBare, { name, time }),
    step: fillTemplate(C.gpsRevertStep, { name }),
  }
}

/** …and the row of an «Am Einsatzort» release that took a drive out of these lines. */
export function gpsReleaseRow(lines: readonly Drawing[], vehicle?: string): string {
  const L = appConfig.copy.log
  const name = gpsLineNames(lines)
  return vehicle ? fillTemplate(L.gpsReleasedOnSite, { name, vehicle }) : fillTemplate(L.gpsReleasedOnSiteBare, { name })
}

/** «340 m» · «1.1 km» — a distance read at a glance, stable under GPS scatter: metres to the
 *  metre under 100, to ten metres under a kilometre, kilometres to one decimal above. */
export function fmtAway(m: number): string {
  if (m < 100) return `${Math.round(m)} m`
  if (m < 1000) {
    const r = Math.round(m / 10) * 10
    return r < 1000 ? `${r} m` : fmtAway(1000)
  }
  return `${(m / 1000).toLocaleString(appConfig.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`
}

/** One GPS end a Meldung acts on. */
export interface GpsEnd {
  drawing: Drawing
  endpoint: LineEndpoint
  /** its fresh snapshot, if it kept one */
  before?: GpsFollowSnapshot
}
/** Per END and per snapshot — a new following is a new question. */
export const endKey = (drawingId: string, ep: LineEndpoint, before?: GpsFollowSnapshot) => `${drawingId}:${ep}:${before?.at ?? '-'}`

/** What the Meldeleiste says about ONE VEHICLE. `away`: paused, its lines still end on site.
 *  `stopped`: paused after following — the lines show the drive. `back`: following, and the
 *  vehicle is on site again after having been away. */
export type GpsNoticeKind = 'away' | 'stopped' | 'back'
export interface GpsNotice {
  /** vehicle + kind: one row per vehicle and question */
  key: string
  kind: GpsNoticeKind
  vehicleId: string
  /** the vehicle, as the feed has it now — absent when it dropped out of the feed */
  vehicle?: Entity
  /** metres from the nearest on-site point, when the vehicle is in the feed */
  distanceM?: number
  ends: GpsEnd[]
  /** the earliest kept snapshot among the ends — its time is the one the row names */
  before?: GpsFollowSnapshot
  /** every end kept its on-site line — «Zurück» can be offered for the whole row */
  canRevert: boolean
}

/** Device-local answers to the Meldungen (see `useGpsNotices`), keyed by `endKey`. */
export interface GpsNoticeMemory {
  /** «back» offers this device has seen ARMED (the vehicle was ≥ 300 m out) */
  armed: ReadonlySet<string>
  /** «back» offers answered «Weiter folgen» — not asked again until re-armed */
  answered: ReadonlySet<string>
  /** «stopped» rows waved away with ✕ */
  dismissed: ReadonlySet<string>
}
const EMPTY: GpsNoticeMemory = { armed: new Set(), answered: new Set(), dismissed: new Set() }

/** The trace itself says the vehicle was away: a vertex of the line ≥ 300 m from the on-site
 *  point. Deterministic on every device — one that was asleep while the TLF drove still arms. */
export function traceWasAway(d: Drawing, before: GpsFollowSnapshot): boolean {
  return d.coords.some((p) => haversineM(before.lastSafe, p) >= AWAY_AGAIN_M)
}

/** Every vehicle the Meldeleiste has something to say about, one row per vehicle and kind. */
export function gpsNotices(drawings: readonly Drawing[], vehicles: readonly Entity[], memory: GpsNoticeMemory = EMPTY): GpsNotice[] {
  const rows = new Map<string, GpsNotice>()
  for (const drawing of drawings) {
    if (drawing.kind !== 'line') continue
    for (const endpoint of ['start', 'end'] as const) {
      const a = attachmentAt(drawing, endpoint)
      if (a?.target.kind !== 'object' || !a.gps) continue
      const gps = a.gps
      const vehicleId = a.target.id
      const vehicle = vehicles.find((e) => e.id === vehicleId)
      const distanceM = vehicle ? haversineM(onSiteAnchor(gps), vehicle.coord) : undefined
      const before = freshBefore(gps)
      const k = endKey(drawing.id, endpoint, before)
      let kind: GpsNoticeKind | null = null
      if (gps.state === 'paused') {
        if (!hasTraced(gps)) { if (distanceM != null && distanceM >= AWAY_NOTICE_M) kind = 'away' }
        else if (!memory.dismissed.has(k)) kind = 'stopped'
      } else if (gps.state === 'continuous' && before && distanceM != null && distanceM <= BACK_ON_SITE_M
        && !memory.answered.has(k) && (memory.armed.has(k) || traceWasAway(drawing, before))) {
        kind = 'back'
      }
      if (!kind) continue
      const key = `${vehicleId}:${kind}`
      const row = rows.get(key) ?? { key, kind, vehicleId, vehicle, distanceM, ends: [], canRevert: true }
      row.ends.push({ drawing, endpoint, before })
      if (distanceM != null && (row.distanceM == null || distanceM < row.distanceM)) row.distanceM = distanceM
      if (before && (!row.before || before.at < row.before.at)) row.before = before
      row.canRevert = row.canRevert && !!before
      rows.set(key, row)
    }
  }
  return [...rows.values()]
}

/**
 * The device's own answers to the GPS Meldungen. Deliberately device-local: a Meldung being
 * answered or waved away is the strip, which records nothing (docs/verlauf-coverage ·
 * Meldeleiste), and a synced flag would be a tactical write for a tap that changed nothing.
 *
 * A «back» offer starts UN-ARMED: it arms once the vehicle has been `AWAY_AGAIN_M` from the
 * on-site point (seen live here, or written into the trace itself), and only then does coming
 * within 150 m ask. «Weiter folgen» on it answers it until the vehicle is 300 m out again — the
 * refill run that comes back a second time is a second question. Adjusted DURING render (React's
 * «storing information from previous renders»), guarded so an unchanged memory is never written.
 */
export function useGpsNotices(drawings: readonly Drawing[], vehicles: readonly Entity[]) {
  const [memory, setMemory] = useState<GpsNoticeMemory>(EMPTY)
  let current = memory
  const next = { armed: new Set(memory.armed), answered: new Set(memory.answered), dismissed: new Set(memory.dismissed) }
  let changed = false
  const live = new Set<string>()
  for (const d of drawings) for (const ep of ['start', 'end'] as const) {
    const a = attachmentAt(d, ep)
    if (a?.target.kind !== 'object' || !a.gps) continue
    const before = freshBefore(a.gps)
    const k = endKey(d.id, ep, before)
    live.add(k)
    if (a.gps.state !== 'continuous' || !before) continue
    const v = vehicles.find((e) => e.id === a.target.id)
    if (v && haversineM(before.lastSafe, v.coord) >= AWAY_AGAIN_M) {
      if (!next.armed.has(k)) { next.armed.add(k); changed = true }
      if (next.answered.delete(k)) changed = true
    }
  }
  // forget ends that no longer exist (detached, reverted, a new snapshot)
  for (const set of [next.armed, next.answered, next.dismissed]) for (const k of [...set]) if (!live.has(k)) { set.delete(k); changed = true }
  if (changed) { setMemory(next); current = next }
  const mark = (field: 'answered' | 'dismissed', n: GpsNotice) => setMemory((m) => {
    const s = new Set(m[field])
    for (const e of n.ends) s.add(endKey(e.drawing.id, e.endpoint, e.before))
    return { ...m, [field]: s, ...(field === 'answered' ? { armed: new Set([...m.armed].filter((k) => !s.has(k))) } : {}) }
  })
  return {
    notices: gpsNotices(drawings, vehicles, current),
    /** «Weiter folgen» on a «back» row */
    answerBack: (n: GpsNotice) => mark('answered', n),
    /** ✕ on a «stopped» row */
    dismissStopped: (n: GpsNotice) => mark('dismissed', n),
  }
}

/**
 * Did ONLY the live-GPS follower change this object between `ancestor` and `next` — the traced
 * coords, `lastSafe`, a pause — and nothing a hand did? The sync merge reads it
 * (mergeWorkspace · the objects' resolver): objects merge whole-object, last writer wins, so
 * another device's follower write landing after a «Zurück» would put the drive back. A hand's
 * change beats a machine-only change of the same object.
 */
export function followerOnlyChange(ancestor: TacticalObject, next: TacticalObject): boolean {
  const a = ancestor.drawing, n = next.drawing
  if (!a || !n || a.id !== n.id) return false
  const followed = (x?: LineAttachment) => !!x?.gps && x.target.kind === 'object'
  if (!followed(a.startAttachment) && !followed(a.endAttachment)) return false
  const strip = (o: TacticalObject) => {
    const d = o.drawing!
    const att = (x?: LineAttachment) => (x?.gps ? { ...x, gps: { ...x.gps, lastSafe: null, state: x.gps.state === 'continuous' ? 'continuous' : 'held' } } : x)
    const sheet = o.sheet ? { ...o.sheet, anno: { ...o.sheet.anno, pts: null } } : undefined
    return JSON.stringify({ ...o, sheet, drawing: { ...d, coords: null, startAttachment: att(d.startAttachment), endAttachment: att(d.endAttachment) } })
  }
  return strip(ancestor) === strip(next)
}
