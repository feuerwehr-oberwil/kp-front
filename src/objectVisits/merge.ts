// Three-way merge of a visit (docs/object-visits.md · «Conflict (409)»). Pure.
//
// The server refused this device's write because somebody else's revision landed first. We hold
// three documents: `base` (the last revision both sides agreed on), `local` (this device) and
// `server` (what is stored now). Per KEY — each answer, the notes, visitedAt, with, each photo by
// id (caption and link per photo), each proposal by id — the side that changed it wins; a key
// changed on BOTH sides to different values keeps the SERVER's value and remembers this device's
// in `conflicts[]`, which the visit shows as «Zwei Fassungen» until somebody taps an answer.
// Nothing is dropped without a tap. Lifecycle is not a conflict: it only moves forward
// (discarded > completed > draft). Deterministic: the same three documents give the same result.

import { jsonEqual } from '../lib/jsonEqual'
import type { Answer, Lifecycle, VisitConflict, VisitDoc, VisitPhoto, VisitProposal } from './types'
import { deviceId } from './store'

const RANK: Record<Lifecycle, number> = { draft: 0, completed: 1, discarded: 2 }

export interface MergeResult {
  doc: VisitDoc
  /** the conflicts THIS merge found (already included in `doc.conflicts`) */
  conflicts: VisitConflict[]
}

type Pick3<T> = { value: T; conflict: boolean }

/** One key, three ways. `undefined` = absent. Equal sides never conflict. */
export function pick3<T>(base: T | undefined, local: T | undefined, server: T | undefined): Pick3<T | undefined> {
  if (jsonEqual(local, server)) return { value: server, conflict: false }
  if (jsonEqual(local, base)) return { value: server, conflict: false }   // only the server changed it
  if (jsonEqual(server, base)) return { value: local, conflict: false }   // only this device changed it
  return { value: server, conflict: true }
}

/** The fields of a photo that can be edited (bytes, hash, size and type are fixed by its id). */
const PHOTO_FIELDS = ['caption', 'item'] as const

export function mergeVisit(
  base: VisitDoc | null,
  local: VisitDoc,
  server: VisitDoc,
  { now = new Date().toISOString(), by = null, device = null }: { now?: string; by?: string | null; device?: string | null } = {},
): MergeResult {
  // Without a common ancestor (our create was accepted, but its answer was lost), the server's
  // copy is our own earlier write: this device's edits since then win key by key.
  const b: VisitDoc = base ?? server
  const found: VisitConflict[] = []
  const conflict = (key: string, mine: unknown, theirs: unknown) =>
    // keyed by what collided: a later collision on the same key REPLACES the earlier card
    found.push({ id: `ovc-${key}`, key, mine: mine ?? null, theirs: theirs ?? null, at: now, ...(by ? { by } : {}), ...(device ? { device } : {}) })

  const scalar = <K extends 'notes' | 'visitedAt' | 'with' | 'workRef' | 'object' | 'checklist'>(k: K): VisitDoc[K] | undefined => {
    const r = pick3(b[k], local[k], server[k])
    if (r.conflict) conflict(k, local[k], server[k])
    return r.value as VisitDoc[K] | undefined
  }

  // ── answers, per item ──
  const answers: Record<string, Answer> = {}
  const answerIds = new Set([...Object.keys(b.answers ?? {}), ...Object.keys(local.answers ?? {}), ...Object.keys(server.answers ?? {})])
  for (const id of answerIds) {
    const r = pick3(b.answers?.[id], local.answers?.[id], server.answers?.[id])
    if (r.conflict) conflict(`answers.${id}`, local.answers?.[id], server.answers?.[id])
    if (r.value !== undefined) answers[id] = r.value
  }

  // ── photos, by id; caption and link per photo ──
  const photos = mergeById<VisitPhoto>(b.photos ?? [], local.photos ?? [], server.photos ?? [], (bp, lp, sp) => {
    const out: VisitPhoto = { ...sp }
    for (const f of PHOTO_FIELDS) {
      const r = pick3(bp?.[f], lp[f], sp[f])
      if (r.conflict) conflict(`photos.${sp.id}.${f}`, lp[f], sp[f])
      if (r.value === undefined) delete out[f]
      else (out as unknown as Record<string, unknown>)[f] = r.value
    }
    return out
  }, (key, mine, theirs) => conflict(`photos.${key}`, mine, theirs))

  // ── proposals, by id, each whole ──
  const proposals = mergeById<VisitProposal>(b.proposals ?? [], local.proposals ?? [], server.proposals ?? [], (bp, lp, sp) => {
    const r = pick3(bp, lp, sp)
    if (r.conflict) conflict(`proposals.${sp.id}`, lp, sp)
    return (r.value ?? sp) as VisitProposal
  }, (key, mine, theirs) => conflict(`proposals.${key}`, mine, theirs))

  // ── the cards themselves merge three-way too: one resolved on either side (gone there,
  //    untouched on the other) stays resolved — a union brought it back on the next 409 ──
  const kept = mergeById<VisitConflict>(b.conflicts ?? [], local.conflicts ?? [], server.conflicts ?? [],
    (bc, lc, sc) => (pick3(bc, lc, sc).value ?? sc) as VisitConflict, () => {})
  const prior = new Map<string, VisitConflict>(kept.map((c) => [c.id, c]))

  const lifecycle = RANK[local.lifecycle] >= RANK[server.lifecycle] ? local.lifecycle : server.lifecycle

  const notes = scalar('notes') ?? ''
  const visitedAt = scalar('visitedAt') ?? server.visitedAt
  const withPeople = scalar('with')
  const workRef = scalar('workRef')
  const object = scalar('object') ?? server.object
  const checklist = scalar('checklist') ?? null

  const doc: VisitDoc = {
    schema: local.schema,
    id: local.id,
    object,
    ...(workRef ? { workRef } : {}),
    visitedAt,
    ...(withPeople !== undefined ? { with: withPeople } : {}),
    lifecycle,
    checklist,
    answers,
    notes,
    photos,
    proposals,
  }
  for (const c of found) prior.set(c.id, c)
  const all = [...prior.values()]
  if (all.length) doc.conflicts = all
  return { doc, conflicts: found }
}

/**
 * Merge a list of records by `id`. Server order first, then what only this device added, in its
 * order. A record removed on one side and untouched on the other goes; removed on one side and
 * EDITED on the other stays (the edit is the newer fact) and is recorded as a conflict, so the
 * removal can be repeated with one tap — never silently lost, never silently undone.
 */
function mergeById<T extends { id: string }>(
  base: T[],
  local: T[],
  server: T[],
  both: (b: T | undefined, l: T, s: T) => T,
  conflict: (key: string, mine: unknown, theirs: unknown) => void,
): T[] {
  const B = new Map(base.map((x) => [x.id, x]))
  const L = new Map(local.map((x) => [x.id, x]))
  const S = new Map(server.map((x) => [x.id, x]))
  const out: T[] = []
  const take = (id: string) => {
    const b = B.get(id), l = L.get(id), s = S.get(id)
    if (l && s) { out.push(both(b, l, s)); return }
    if (!l && !s) return // removed on both sides
    if (l && !s) {
      if (!b) { out.push(l); return }                       // added here
      if (jsonEqual(l, b)) return                           // removed there, untouched here
      conflict(l.id, l, null)                               // removed there, edited here: keep it
      out.push(l)
      return
    }
    // s && !l
    if (!b) { out.push(s!); return }                        // added there
    if (jsonEqual(s, b)) return                             // removed here, untouched there
    conflict(s!.id, null, s)                                // removed here, edited there: keep it
    out.push(s!)
  }
  for (const s of server) take(s.id)
  for (const l of local) if (!S.has(l.id)) take(l.id)
  return out
}

// ─── resolving a conflict (the «Zwei Fassungen» card) ──────────────────────────────────────

export type Resolution = 'mine' | 'theirs' | 'both'

/** Is this conflict about free text, so «Beide behalten» can join the two? */
export function isTextConflict(c: VisitConflict): boolean {
  if (c.key === 'notes') return typeof c.mine === 'string' && typeof c.theirs === 'string'
  if (c.key.startsWith('answers.')) {
    const m = (c.mine as Answer | null)?.v, t = (c.theirs as Answer | null)?.v
    return typeof m === 'string' && typeof t === 'string' && !['ok', 'defect', 'na', 'yes', 'no', 'photo'].includes(m)
  }
  return /^photos\.[^.]+\.caption$/.test(c.key) && typeof c.mine === 'string' && typeof c.theirs === 'string'
}

const joinText = (theirs: string, mine: string) => (theirs.trim() && mine.trim() ? `${theirs.trim()}\n\n${mine.trim()}` : (theirs || mine))

/** Apply the tapped answer and drop the conflict from the document. */
export function resolveConflict(doc: VisitDoc, conflictId: string, how: Resolution): VisitDoc {
  const c = (doc.conflicts ?? []).find((x) => x.id === conflictId)
  if (!c) return doc
  const rest = (doc.conflicts ?? []).filter((x) => x.id !== conflictId)
  let next: VisitDoc = { ...doc }
  if (rest.length) next.conflicts = rest
  else delete next.conflicts
  if (how === 'theirs') return next // the document already holds theirs
  const value = how === 'both' && isTextConflict(c) ? 'both' : 'mine'

  if (c.key === 'notes') {
    next.notes = value === 'both' ? joinText(String(c.theirs ?? ''), String(c.mine ?? '')) : String(c.mine ?? '')
    return next
  }
  if (['visitedAt', 'with', 'workRef', 'object', 'checklist'].includes(c.key)) {
    const k = c.key as 'visitedAt' | 'with' | 'workRef' | 'object' | 'checklist'
    if (c.mine == null && k !== 'checklist') { const n = { ...next } as Record<string, unknown>; delete n[k]; return n as unknown as VisitDoc }
    next = { ...next, [k]: c.mine } as VisitDoc
    return next
  }
  if (c.key.startsWith('answers.')) {
    const id = c.key.slice('answers.'.length)
    const answers = { ...next.answers }
    if (value === 'both') {
      const t = c.theirs as Answer, m = c.mine as Answer
      answers[id] = { ...t, v: joinText(String(t.v), String(m.v)) }
    } else if (c.mine == null) delete answers[id]
    else answers[id] = c.mine as Answer
    return { ...next, answers }
  }
  const photoField = /^photos\.([^.]+)\.(caption|item)$/.exec(c.key)
  if (photoField) {
    const [, id, f] = photoField
    return {
      ...next,
      photos: next.photos.map((p) => {
        if (p.id !== id) return p
        if (f === 'caption') return { ...p, caption: value === 'both' ? joinText(String(c.theirs ?? ''), String(c.mine ?? '')) : String(c.mine ?? '') }
        const q = { ...p }
        if (c.mine == null) delete q.item
        else q.item = String(c.mine)
        return q
      }),
    }
  }
  const whole = /^(photos|proposals)\.([^.]+)$/.exec(c.key)
  if (whole) {
    const [, list, id] = whole
    const arr = (next[list as 'photos' | 'proposals'] as { id: string }[])
    const mine = c.mine as { id: string } | null
    const replaced = mine ? (arr.some((x) => x.id === id) ? arr.map((x) => (x.id === id ? mine : x)) : [...arr, mine]) : arr.filter((x) => x.id !== id)
    return { ...next, [list]: replaced } as VisitDoc
  }
  return next
}

/** Is this card the viewer's own — met on THIS device (and by this account, where recorded)?
 *  Only then is `mine` «Meine». A card without a device (older) counts as the viewer's. */
export function conflictIsMine(c: VisitConflict, viewer: string | null, device: string = deviceId()): boolean {
  if (c.device && c.device !== device) return false
  if (c.by && viewer && c.by !== viewer) return false
  return true
}
