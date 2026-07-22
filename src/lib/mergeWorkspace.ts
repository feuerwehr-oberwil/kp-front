// Three-way merge of two divergent workspace blobs against their common ancestor (the last
// revision both devices shared). This is what turns concurrent multi-device editing from
// "one whole snapshot wins, the other's work is lost" into a real merge, the way Miro/Figma
// resolve it:
//   - independent additions to different objects all survive (ordered by server appearance);
//   - edits to the SAME object are last-writer-wins (the device flushing later wins);
//   - a delete BEATS a concurrent edit — the object stays gone, no resurrection.
//
// The `base` ancestor is the crux: it lets us tell "I deleted X" (present in base, absent in
// mine) apart from "I never had X" (absent in both base and mine). Without it a naive union
// can't honor deletes and would resurrect everything the other device removed.

type Id = string
interface HasId {
  id: Id
}

/** Minimal structural view of the workspace blob — only the id-keyed collaborative
 *  collections matter for merging; everything else (view/config) defaults to the local side. */
interface WsShape {
  entities?: HasId[]
  drawings?: HasId[]
  timeline?: HasId[]
  trupps?: HasId[]
  mittel?: HasId[] // append-only material-use events — merge by event id like timeline
  cameraViews?: HasId[]
  board?: Record<string, HasId[]>
  vehicleOverrides?: Record<string, unknown>
  checklists?: Record<string, unknown>
  // singletons / records that ALSO need three-way merging so a concurrent edit in another domain
  // (the "task-scoped multi-editor" case) isn't clobbered by the resolver's whole-blob default:
  attendance?: Record<string, unknown> // per-Person presence — a prime parallel-editor surface
  planScale?: Record<string, unknown> // per-plan calibration (planId → scale)
  settings?: Record<string, unknown> // per-incident operational settings (Atemschutz doctrine …)
  reportMeta?: Record<string, unknown> // Einsatzrapport bookkeeping text
  building?: unknown // the Gebäude floor-stack doc (merged whole — same-object stays LWW)
  pickedObjectId?: unknown // the shared picked Einsatzobjekt (one picture across devices)
  [k: string]: unknown
}

/** Structural equality for plain JSON data (the only thing the blob holds). Used to tell "I
 *  changed this field" from "I left it as the ancestor" in the three-way field/record merges.
 *  Key order is stable here because every value is produced by the same buildPayload code. */
const eq = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

/** Three-way merge of ONE non-collection value: if the resolver (mine) left it at the common
 *  ancestor it yields to the server's value (so the other device's concurrent change survives);
 *  if the resolver changed it, mine wins (last-writer-wins). This is what stops a save in one
 *  domain from reverting a singleton (settings/building/…) edited concurrently in another. */
function pick3<T>(base: T, mine: T, theirs: T): T {
  return eq(mine, base) ? theirs : mine
}

/**
 * Merge one id-keyed collection three ways. `mine` is the local (later) writer, so on a
 * same-id divergence it wins. If only one side changed an object, that change survives. An
 * object present in `base` but dropped on a side is a delete, and a
 * delete beats the other side's edit. Output order is server (theirs) order first, then my
 * new additions — deterministic, so every device converges on the same array after merging.
 */
export function mergeById<T extends HasId>(base: T[], mine: T[], theirs: T[]): T[] {
  const baseIds = new Set(base.map((o) => o.id))
  const baseMap = new Map(base.map((o) => [o.id, o]))
  const mineMap = new Map(mine.map((o) => [o.id, o]))
  const theirsMap = new Map(theirs.map((o) => [o.id, o]))

  // What survives for a given id, or null if it should be dropped (a delete won).
  const survives = (id: Id): T | null => {
    const inMine = mineMap.has(id)
    const inTheirs = theirsMap.has(id)
    if (inMine && inTheirs) {
      const mine = mineMap.get(id)!, theirs = theirsMap.get(id)!, ancestor = baseMap.get(id)
      if (!ancestor) return mine // concurrent same-id add → last-writer-wins (mine)
      if (eq(mine, ancestor)) return theirs // only the server changed it
      if (eq(theirs, ancestor)) return mine // only I changed it
      return mine // both changed it → last-writer-wins (mine)
    }
    if (inMine) return baseIds.has(id) ? null : mineMap.get(id)! // theirs deleted → drop; else my add
    if (inTheirs) return baseIds.has(id) ? null : theirsMap.get(id)! // I deleted → drop; else their add
    return null
  }

  const out: T[] = []
  const taken = new Set<Id>()
  for (const o of theirs) {
    const r = survives(o.id)
    if (r && !taken.has(o.id)) { out.push(r); taken.add(o.id) }
  }
  for (const o of mine) {
    if (taken.has(o.id)) continue
    const r = survives(o.id)
    if (r) { out.push(r); taken.add(o.id) }
  }
  return out
}

/** A true same-key divergence in a merged record: BOTH sides changed the key relative to the
 *  ancestor, to different values — the merge stays last-writer-wins (mine), but callers can
 *  surface it (e.g. the attendance conflict note in the Verlauf) instead of staying silent. */
export interface RecordConflict {
  key: string
  mine: unknown
  theirs: unknown
}

/** Three-way merge of a plain key→value record (vehicleOverrides by entity id, checklists by
 *  template id, attendance by Person id, planScale by plan id, and the flat settings/reportMeta
 *  singletons). Per key: a delete (present in base, gone on one side) wins; otherwise the side
 *  that actually CHANGED the value relative to the ancestor wins, and if both changed it's
 *  last-writer-wins (mine). Crucially, a key the resolver left untouched takes the server's value
 *  — so a value another device changed in a different domain is not silently reverted.
 *  `onConflict` (optional) fires for every key BOTH sides changed to different values — the
 *  LWW result is unchanged, the divergence is merely reported. */
export function mergeRecord<V>(
  base: Record<string, V>,
  mine: Record<string, V>,
  theirs: Record<string, V>,
  onConflict?: (c: RecordConflict) => void,
): Record<string, V> {
  const out: Record<string, V> = {}
  base = base ?? {}
  mine = mine ?? {}
  theirs = theirs ?? {}
  for (const k of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    const inBase = k in base, inMine = k in mine, inTheirs = k in theirs
    if (inBase && (!inMine || !inTheirs)) continue // a shared key removed on either side → delete wins
    if (!inMine && !inTheirs) continue // never existed / removed on both
    if (inMine && (!inBase || !eq(mine[k], base[k]))) {
      // I added/changed it → mine wins. If THEIRS also moved off the ancestor to something
      // different, that's a genuine both-sides divergence — report it (LWW stays).
      if (onConflict && inTheirs && !eq(mine[k], theirs[k]) && (!inBase || !eq(theirs[k], base[k]))) {
        onConflict({ key: k, mine: mine[k], theirs: theirs[k] })
      }
      out[k] = mine[k]
    }
    else if (inTheirs) out[k] = theirs[k] // I left it at the ancestor → take theirs (their change or unchanged)
    else out[k] = mine[k]
  }
  return out
}

/** Merge the per-plan board (planId → annotations[]), merging each plan's annotations by id. */
function mergeBoard(
  base: Record<string, HasId[]>,
  mine: Record<string, HasId[]>,
  theirs: Record<string, HasId[]>,
): Record<string, HasId[]> {
  const out: Record<string, HasId[]> = {}
  for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
    out[k] = mergeById(base[k] ?? [], mine[k] ?? [], theirs[k] ?? [])
  }
  return out
}

/**
 * Three-way merge of whole workspace blobs, built for TASK-SCOPED multi-editor use: two operators
 * working DIFFERENT domains of one incident (e.g. Atemschutz on one device, Lage/Plan/report on
 * another) must both keep their work. Every operational domain is merged so a save in one domain
 * never clobbers a concurrent edit in another:
 *   - object collections (entities, drawings, timeline, trupps, cameraViews, board) → per-object
 *     three-way by id (independent adds survive, same object is LWW-mine, delete beats edit);
 *   - records (vehicleOverrides, checklists, attendance, planScale) and singletons (settings,
 *     reportMeta, building, pickedObjectId) → three-way by value, so a field the resolver didn't
 *     touch yields to the server's concurrent change instead of being reverted.
 * Only genuinely LOCAL view/device state stays defaulted to mine (activePlanId, layerState, recent,
 * activeModule) — a merge must never yank the resolving device's active plan or layer toggles.
 * (Same-object field-level edits remain LWW-mine — see the documented limitation in the tests.)
 *
 * `onAttendanceConflict` (optional) reports every attendance key BOTH sides changed to different
 * values (same person, divergent entries — e.g. QR capture vs. KP tablet). The merge result is
 * unchanged (LWW); the caller appends a Verlauf note so the divergence is reviewable.
 */
export function mergeWorkspace(
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
  onAttendanceConflict?: (c: RecordConflict) => void,
): Record<string, unknown> {
  const b = base as WsShape
  const m = mine as WsShape
  const t = theirs as WsShape
  return {
    ...m, // local view/device state (activePlanId, layerState, recent, activeModule) defaults to mine
    entities: mergeById(b.entities ?? [], m.entities ?? [], t.entities ?? []),
    drawings: mergeById(b.drawings ?? [], m.drawings ?? [], t.drawings ?? []),
    timeline: mergeById(b.timeline ?? [], m.timeline ?? [], t.timeline ?? []),
    trupps: mergeById(b.trupps ?? [], m.trupps ?? [], t.trupps ?? []),
    mittel: mergeById(b.mittel ?? [], m.mittel ?? [], t.mittel ?? []),
    cameraViews: mergeById(b.cameraViews ?? [], m.cameraViews ?? [], t.cameraViews ?? []),
    board: mergeBoard(b.board ?? {}, m.board ?? {}, t.board ?? {}),
    vehicleOverrides: mergeRecord(b.vehicleOverrides ?? {}, m.vehicleOverrides ?? {}, t.vehicleOverrides ?? {}),
    checklists: mergeRecord(
      (b.checklists ?? {}) as Record<string, unknown>,
      (m.checklists ?? {}) as Record<string, unknown>,
      (t.checklists ?? {}) as Record<string, unknown>,
    ),
    // domains that previously fell through to `...m` (the resolver's whole blob) and so could be
    // clobbered by a concurrent cross-domain edit — now merged three-way:
    attendance: mergeRecord(
      (b.attendance ?? {}) as Record<string, unknown>,
      (m.attendance ?? {}) as Record<string, unknown>,
      (t.attendance ?? {}) as Record<string, unknown>,
      onAttendanceConflict,
    ),
    planScale: mergeRecord(
      (b.planScale ?? {}) as Record<string, unknown>,
      (m.planScale ?? {}) as Record<string, unknown>,
      (t.planScale ?? {}) as Record<string, unknown>,
    ),
    settings: mergeRecord(
      (b.settings ?? {}) as Record<string, unknown>,
      (m.settings ?? {}) as Record<string, unknown>,
      (t.settings ?? {}) as Record<string, unknown>,
    ),
    reportMeta: mergeRecord(
      (b.reportMeta ?? {}) as Record<string, unknown>,
      (m.reportMeta ?? {}) as Record<string, unknown>,
      (t.reportMeta ?? {}) as Record<string, unknown>,
    ),
    building: pick3(b.building, m.building, t.building),
    pickedObjectId: pick3(b.pickedObjectId, m.pickedObjectId, t.pickedObjectId),
  }
}
