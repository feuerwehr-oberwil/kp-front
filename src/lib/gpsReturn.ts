import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { haversineM } from './geo'
import { drawingLogName } from './drawingEdit'
import { lineLabel } from './lineDecor'
import type { Drawing, Entity, GpsFollowSnapshot, LineAttachment, LineEndpoint, LineRoutingMode, LngLat } from '../types'

/**
 * The live-GPS coupling's way BACK to the Einsatzort (D3, after the Übung on 23.09.2026).
 *
 * At 22:31 «Weiter folgen» was tapped for a TLF that had been back at the Magazin since 22:14. The
 * line traced the whole drive (depot → site → depot, a 1.15 km spike on the printed Rapport), and
 * the tap had overwritten the one point that remembered where the hose really ended. And the line
 * editor's «Hier lösen» cut the coupling at the vehicle's CURRENT position — the same spike by a
 * second door. Three rules close it, all pure and all here:
 *
 * 1. **Following starts with a snapshot** (`routingPatch`). The first tap that turns a GPS end into
 *    a trace stores the on-site line in `gps.before`; a later tap never replaces it. It rides with
 *    the attachment, so the sync, the three-way merge, the bake and ↶ carry it for free.
 * 2. **Letting go happens on site** (`onSiteCoords`). Every detach of a GPS end — the Meldung, the
 *    editor, the map's × chip — ends the line where it stood on site, never where the vehicle is
 *    now. With a snapshot the drive is cut off; without one the end is where the screen shows it,
 *    which the 20 m guard keeps on site.
 * 3. **«Zurück auf Stand am Einsatzort»** (`revertCoords`) puts the snapshotted line back exactly
 *    and detaches it there — the caller makes that one undo step and one Verlauf row.
 *
 * What is deliberately NOT here: asking again automatically when a following vehicle passes
 * ~1 km (D3-b, undecided).
 */

/** A vehicle back inside this ring of its on-site point is «back» — the same generous ring the
 *  presence log calls «vor Ort» (useVehiclePresenceLog · AT_SCENE_M). */
export const BACK_ON_SITE_M = 150
/** …and it has to get this far out again before a dismissed «back» offer may come back — the
 *  presence log's hysteresis, for the same reason: GPS scatter at the ring must not re-ask. */
export const AWAY_AGAIN_M = 300

const keyOf = (ep: LineEndpoint) => (ep === 'start' ? 'startAttachment' : 'endAttachment') as 'startAttachment' | 'endAttachment'
const endIdx = (coords: readonly unknown[], ep: LineEndpoint) => (ep === 'start' ? 0 : coords.length - 1)
const withEnd = (coords: readonly LngLat[], ep: LineEndpoint, p: LngLat): LngLat[] =>
  coords.map((q, i) => (i === endIdx(coords, ep) ? p : q))

export const attachmentAt = (d: Pick<Drawing, 'startAttachment' | 'endAttachment'>, ep: LineEndpoint): LineAttachment | undefined => d[keyOf(ep)]

/** The vehicle position the operator last knew as «on site»: the snapshot's, else the guard's own
 *  point — `lastSafe` while guarded or paused (a paused end STAYS there), the last confirmation
 *  for a trace that was started before snapshots existed. */
export function onSiteAnchor(gps: NonNullable<LineAttachment['gps']>): LngLat {
  return gps.before?.lastSafe ?? (gps.state === 'continuous' ? gps.confirmedAt : gps.lastSafe)
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
    // as the on-site state — overwriting it is exactly the loss this field exists to prevent.
    const before: GpsFollowSnapshot = gps.before ?? {
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
 * The line's coords after letting go of one end AT THE EINSATZORT («Am Einsatzort lassen»,
 * «Am Einsatzort lösen», the map's × chip).
 *
 * `fallback` is where the caller would have put the end — the screen's resolved end. That is the
 * answer for every end that is not a GPS trace: a plain target, a guarded end (the 20 m guard
 * keeps the vehicle on site), a paused one (it resolves to `lastSafe`, on site).
 *
 * A GPS end that has FOLLOWED carries a snapshot, and its current tail is the drive: the line
 * keeps every vertex that was there before following began (the trace only ever rewrites the
 * two vertices at the moving end — lineAttachments · applyRouting) and ends on the snapshot's
 * on-site point. If the line has fewer vertices than that by now (someone deleted some), the
 * snapshot itself is the answer. A trace started before snapshots existed has nothing to go
 * back to and keeps its traced end.
 */
export function onSiteCoords(d: Drawing, ep: LineEndpoint, fallback: LngLat): LngLat[] {
  const before = attachmentAt(d, ep)?.gps?.before
  if (!before || before.coords.length < 2) return withEnd(d.coords, ep, fallback)
  const keep = before.coords.length - 1
  const onSite = before.coords[endIdx(before.coords, ep)]
  if (d.coords.length < before.coords.length) return before.coords.map((p) => [...p] as LngLat)
  return ep === 'end'
    ? [...d.coords.slice(0, keep), onSite]
    : [onSite, ...d.coords.slice(d.coords.length - keep)]
}

/** «Zurück auf Stand am Einsatzort»: the snapshotted line, exactly — or null without a snapshot. */
export function revertCoords(d: Drawing, ep: LineEndpoint): LngLat[] | null {
  const before = attachmentAt(d, ep)?.gps?.before
  return before && before.coords.length >= 2 ? before.coords.map((p) => [...p] as LngLat) : null
}

/** «Leitung 1» where the hose has a number, else the name every drawing row uses. */
export const gpsLineName = (d: Drawing): string =>
  d.lineNo != null && !(d.label ?? '').trim() ? lineLabel(d) : drawingLogName(d)

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

/** What the Meldeleiste says about one GPS end. `away`: paused, the line still ends on site.
 *  `stopped`: paused after following — the line shows the drive. `back`: following, and the
 *  vehicle is on site again. */
export type GpsNoticeKind = 'away' | 'stopped' | 'back'
export interface GpsNotice {
  key: string
  drawing: Drawing
  endpoint: LineEndpoint
  kind: GpsNoticeKind
  /** the vehicle, as the feed has it now — absent when it dropped out of the feed */
  vehicle?: Entity
  /** metres from the on-site point, when the vehicle is in the feed */
  distanceM?: number
  before?: GpsFollowSnapshot
}

/** The «back» offer's identity: per end AND per snapshot, so a new following is a new question. */
export const backKey = (drawingId: string, ep: LineEndpoint, before: GpsFollowSnapshot) => `${drawingId}:${ep}:${before.at}`

/** Every GPS end the Meldeleiste has something to say about. `dismissed` holds the «back» offers
 *  this device was already answered «Weiter folgen» on (see `useBackOffers`). */
export function gpsNotices(drawings: readonly Drawing[], vehicles: readonly Entity[], dismissed: ReadonlySet<string> = new Set()): GpsNotice[] {
  const out: GpsNotice[] = []
  for (const drawing of drawings) {
    if (drawing.kind !== 'line') continue
    for (const endpoint of ['start', 'end'] as const) {
      const a = attachmentAt(drawing, endpoint)
      if (a?.target.kind !== 'object' || !a.gps) continue
      const targetId = a.target.id
      const vehicle = vehicles.find((e) => e.id === targetId)
      const distanceM = vehicle ? haversineM(onSiteAnchor(a.gps), vehicle.coord) : undefined
      const before = a.gps.before
      const key = `${drawing.id}:${endpoint}`
      if (a.gps.state === 'paused') out.push({ key, drawing, endpoint, kind: before ? 'stopped' : 'away', vehicle, distanceM, before })
      else if (a.gps.state === 'continuous' && before && distanceM != null && distanceM <= BACK_ON_SITE_M && !dismissed.has(backKey(drawing.id, endpoint, before))) {
        out.push({ key, drawing, endpoint, kind: 'back', vehicle, distanceM, before })
      }
    }
  }
  return out
}

/**
 * The device's own memory of «Weiter folgen» answered to a «back» offer — so it is asked ONCE per
 * return, not on every poll while the vehicle stands on site. Deliberately device-local: it is a
 * Meldung being waved away, which the strip never records (docs/verlauf-coverage · Meldeleiste),
 * and a synced flag would be a tactical write for a tap that changed nothing on the Karte.
 *
 * An offer re-arms once the vehicle is `AWAY_AGAIN_M` out again — the refill run that comes back
 * a second time is a second question.
 */
export function useBackOffers(drawings: readonly Drawing[], vehicles: readonly Entity[]) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  // Re-arming is adjusted DURING render (React's «storing information from previous renders»),
  // not in an effect: an effect would paint the stale answer first and render twice. Guarded — an
  // unchanged set is never written, so this cannot loop.
  let current = dismissed
  if (dismissed.size) {
    const keep = new Set<string>()
    for (const k of dismissed) if (!rearmed(k, drawings, vehicles)) keep.add(k)
    if (keep.size !== dismissed.size) { setDismissed(keep); current = keep }
  }
  return { dismissed: current, dismiss: (key: string) => setDismissed((s) => new Set(s).add(key)) }
}

/** A dismissed «back» offer whose vehicle is far out again, or whose following has ended. */
export function rearmed(key: string, drawings: readonly Drawing[], vehicles: readonly Entity[]): boolean {
  for (const d of drawings) for (const ep of ['start', 'end'] as const) {
    const a = attachmentAt(d, ep)
    const before = a?.gps?.before
    if (!a || !before || backKey(d.id, ep, before) !== key) continue
    if (a.gps?.state !== 'continuous') return true
    const v = vehicles.find((e) => e.id === a.target.id)
    return !!v && haversineM(before.lastSafe, v.coord) >= AWAY_AGAIN_M
  }
  return true
}
