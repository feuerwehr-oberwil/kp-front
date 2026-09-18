/**
 * ─── «Spur»: a Trupp's recorded track, owned by the INCIDENT rather than by its marker ───────
 * (18.09.2026)
 *
 * A trail is the answer to «welcher Bereich wurde abgesucht». Until today it lived on the marker
 * that recorded it — the plan chip's `BoardAnno.trail`, the map marker's `Entity.trail` — so
 * taking the marker off the picture threw the searched area away with it. The surfaces papered
 * over that by REFUSING to delete a marker that carried a trail («zuerst Spur löschen»), which
 * is the wrong trade: the operator wanted the marker gone, and the app answered with a lock that
 * could only be opened by destroying the record.
 *
 * So the trail outlives the marker. When a chip / map marker with recorded positions disappears
 * — deleted from the picture, or dropped with the Trupp itself («Entfernen») — its points move
 * into a GHOST TRAIL in this collection: read-only, grey, labelled with the Trupp's number, on
 * the storey it was walked on. The marker is gone; the searched area is not.
 *
 * ⚠️ Ghosting is a RECONCILIATION, not a write bolted onto every removal path, and that is what
 * makes the undo fold into ONE step. There are four doors that can take a Trupp marker off a
 * picture (the chip's trash, the map marker's trash, the group delete, `deleteTrupp` ·
 * `dropPlacements`), each with its own history, and a ghost written by each of them would be a
 * second timeline entry — «Rückgängig» would give back the marker and leave the ghost standing
 * beside it. Instead `reconcileGhostTrails` watches the markers: one vanished with points ⇒ a
 * ghost appears; one came BACK (which is exactly what the surface's own undo does, trail
 * included) ⇒ its ghost goes again. Nothing is pushed onto the timeline, so the removal's own
 * step is the whole act in both directions.
 *
 * ⚠️ The id is DERIVED from the marker id (`ght-<markerId>`), never minted: two devices watching
 * the same removal reconcile independently, and `mergeById` then sees one record rather than two
 * copies of the same walked line.
 *
 * «Marker und Spur löschen» (the trash menu on TwinTeamPill) is the one case where no ghost is
 * meant to survive the removal. It does NOT skip the reconciliation — it hands it the marker id
 * (`reconcileGhostTrails · dropped`), and the ghost is born `removedAt`-stamped, i.e. in exactly
 * the state «ghosted, then deleted» leaves behind. Skipping instead would be re-ghosted by the
 * next pass; stamping is read by everything as the deliberate deletion it was.
 *
 * Deleting a ghost («Spur löschen») STAMPS `removedAt` instead of dropping the row — the same
 * shape `Trupp.removedAt` uses, and for the same two reasons: the reconciliation must not read a
 * deliberately deleted trail as «never ghosted» and write it straight back, and the undo is then
 * un-stamping rather than a re-creation.
 */
import type { GeoTrailPoint, TrailPoint } from '../types'
import type { TacticalObject } from './tacticalObjects'

/** Ghost-trail ids are derived from the marker they were recorded on — see the header. */
export const GHOST_TRAIL_PREFIX = 'ght-'
export const ghostTrailId = (markerId: string) => `${GHOST_TRAIL_PREFIX}${markerId}`

/**
 * One Trupp's recorded track, kept by the incident after its marker went.
 *
 * The points are held in the frame they were RECORDED in, because that is the only frame they
 * are true in: a plan trail is sheet-normalised (`points`, with `TrailPoint.floor` naming the
 * storey tile on a Gebäude stack), a Karte trail is geo (`geo`). A ghost carries exactly one of
 * the two, and is drawn by exactly the surface that owns that frame — no projection, because a
 * trail is a sampled path rather than an assertion about a place (see buildingTransfer).
 */
export interface TruppTrail {
  id: string
  /** the marker (plan chip / map entity) whose trail this was — what the reconciliation keys on */
  sourceId: string
  /** the Atemschutz-Trupp behind the marker, when there was one */
  truppId?: string
  /** …and its number, which is what the ghost is LABELLED with («Trupp 3») */
  truppNo?: number
  /** the marker's own label, for a loose chip that never carried a registered Trupp */
  name: string
  color?: string
  /** the plan sheet the trail was walked on; ABSENT = the Karte (and then `geo` carries it) */
  planId?: string
  /** that sheet is a Gebäude floor-stack, so every point's `floor` is a storey tile */
  floorStack?: boolean
  points?: TrailPoint[]
  geo?: GeoTrailPoint[]
  createdAt: string
  /** «Spur löschen» on the ghost — stamped, never dropped (see the header) */
  removedAt?: string
}

/** What a live marker offers the reconciliation: everything a ghost needs but its own timestamps. */
export type TrailSource = Omit<TruppTrail, 'id' | 'createdAt' | 'removedAt'>

/** How many positions this trail holds, whichever frame it is in. */
export const trailPointCount = (t: Pick<TruppTrail, 'points' | 'geo'>): number =>
  t.points?.length ?? t.geo?.length ?? 0

/** The ghosts that are actually drawn: not deleted, and carrying something to draw. */
export const liveGhostTrails = (trails: TruppTrail[] | undefined): TruppTrail[] =>
  (trails ?? []).filter((t) => !t.removedAt && trailPointCount(t) > 0)

/** The ghosts one plan sheet draws (a floor-stack tile filters further, by `TrailPoint.floor`). */
export const planGhostTrails = (trails: TruppTrail[] | undefined, planId: string): TruppTrail[] =>
  liveGhostTrails(trails).filter((t) => t.planId === planId && !!t.points?.length)

/** …and the ones the Karte draws: everything recorded in geo. */
export const mapGhostTrails = (trails: TruppTrail[] | undefined): TruppTrail[] =>
  liveGhostTrails(trails).filter((t) => !t.planId && !!t.geo?.length)

/**
 * What the ghost is CALLED. «Trupp N» on paper (docs/trupp-naming.md): the number is what stays
 * true after the crew went home, so it wins over the leader's name the marker wore. A loose chip
 * that was never joined to a Trupp keeps its own label.
 */
export const ghostTrailLabel = (t: Pick<TruppTrail, 'truppNo' | 'name'>, teamWord: string): string =>
  t.truppNo != null ? `${teamWord} ${t.truppNo}` : t.name

/** A live marker's trail, turned into the ghost it leaves behind. `dropped` is «Marker und Spur
 *  löschen» (18.09.2026): the ghost is born already stamped, so the searched area goes with the
 *  marker instead of outliving it — see `reconcileGhostTrails`. */
export function ghostFromSource(src: TrailSource, at: string, dropped = false): TruppTrail {
  return { ...src, id: ghostTrailId(src.sourceId), createdAt: at, ...(dropped ? { removedAt: at } : null) }
}

/**
 * Every Trupp marker in the store, with whatever trail it carries right now — an EMPTY trail
 * included. A marker whose «Spur löschen» just emptied it is still standing, and the reconcile
 * below reads absence from this list as «vanished»: leave the empty ones out and it would ghost
 * the very points the operator just deleted, beside the marker they came off.
 *
 * ⚠️ Read off the tactical store's own anchor rule (lib/tacticalObjects): an object with a
 * `sheet` body is standing on that sheet and its trail is sheet-normalised; one without is on
 * the Karte and its trail is geo. Reading the collection an id happens to live in instead would
 * ghost a plan chip as a map trail the first time the Karte drew it.
 */
export function trailSources(
  objects: TacticalObject[],
  planStack: (planId: string) => boolean,
  truppNo: (truppId: string | undefined) => number | undefined,
): TrailSource[] {
  const out: TrailSource[] = []
  for (const o of objects) {
    if (o.sheet) {
      const a = o.sheet.anno
      if (a.kind !== 'resource') continue
      out.push({
        sourceId: a.id, truppId: a.truppId, truppNo: truppNo(a.truppId),
        name: (a.text ?? '').trim(), color: a.color,
        planId: o.sheet.planId, floorStack: planStack(o.sheet.planId),
        // a legacy point with no storey of its own was walked on the chip's own tile
        points: (a.trail ?? []).map((p) => ({ ...p, floor: p.floor ?? a.floor ?? 0 })),
      })
      continue
    }
    const e = o.entity
    if (e?.kind !== 'team' || e.live) continue
    out.push({
      sourceId: e.id, truppId: e.truppId, truppNo: truppNo(e.truppId),
      name: (e.label ?? '').trim(), color: e.color, geo: e.trail ?? [],
    })
  }
  return out
}

/**
 * Fold the markers that vanished into ghosts, and take back the ghost of any marker that
 * returned — the whole of the ghosting rule, as one pure pass (see the header for why it is a
 * reconciliation and not a write on each removal path).
 *
 * `prev` is the marker set as it stood a moment ago, `live` as it stands now. Returns the SAME
 * array when nothing changed, so the caller's effect can write unconditionally without looping.
 *
 * `dropped` holds the source ids the operator chose «Marker und Spur löschen» on (18.09.2026,
 * the trash menu on TwinTeamPill). Their ghost is still WRITTEN — id, points and all — but born
 * `removedAt`-stamped, exactly as if it had been ghosted and then deleted: a skipped row would be
 * ghosted again by the next pass (and by the next device), while the stamp is the one shape this
 * collection already has for «this trail was deliberately destroyed». The intent is passed in
 * rather than written by the removal path for the same reason the ghosting itself is a
 * reconciliation: nothing extra lands on the timeline, so the marker's own ↶ undoes the whole act.
 */
export function reconcileGhostTrails(
  trails: TruppTrail[],
  prev: TrailSource[],
  live: TrailSource[],
  at: string,
  dropped?: ReadonlySet<string>,
): TruppTrail[] {
  const liveIds = new Set(live.map((s) => s.sourceId))
  // a marker that is back on the picture carries its own trail again (the surface's undo
  // restored it wholesale) — its ghost would be the same line drawn twice
  let out = trails.filter((t) => !liveIds.has(t.sourceId))
  let changed = out.length !== trails.length
  const have = new Set(out.map((t) => t.id))
  for (const src of prev) {
    if (liveIds.has(src.sourceId)) continue
    if (!trailPointCount(src)) continue
    const id = ghostTrailId(src.sourceId)
    if (have.has(id)) continue
    out = [...out, ghostFromSource(src, at, dropped?.has(src.sourceId))]
    have.add(id)
    changed = true
  }
  return changed ? out : trails
}

/** «Spur löschen» on a ghost — stamped, not dropped. Returns the same array when nothing matched. */
export function removeGhostTrail(trails: TruppTrail[], id: string, at: string): TruppTrail[] {
  const t = trails.find((x) => x.id === id)
  if (!t || t.removedAt) return trails
  return trails.map((x) => (x.id === id ? { ...x, removedAt: at } : x))
}

/** …and its undo: un-stamping, exactly like a Trupp's «Rückgängig». */
export function restoreGhostTrail(trails: TruppTrail[], id: string): TruppTrail[] {
  const t = trails.find((x) => x.id === id)
  if (!t || !t.removedAt) return trails
  return trails.map((x) => (x.id === id ? { ...x, removedAt: undefined } : x))
}
