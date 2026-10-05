// Pure helpers on the visit document: build one, read what it says, take the server's fields off.

import { newId } from '../lib/ids'
import { jsonEqual } from '../lib/jsonEqual'
import type { Item } from '../lib/checklists'
import {
  VISIT_SCHEMA, type Answer, type CatalogueObject, type ItemInput, type ServerVisit, type VisitDoc,
  type VisitObject, type VisitTemplate,
} from './types'

/** The input type of an item (missing = `check`). */
export const inputOf = (item: Item): ItemInput => item.input ?? 'check'

/** Every item of a visit checklist, in order (phases are sections). */
export function checklistItems(t: VisitTemplate | null | undefined): Item[] {
  return (t?.phases ?? []).flatMap((p) => p.items ?? [])
}

/** The object snapshot a new visit carries — display data as it is today. */
export function objectSnapshot(o: CatalogueObject): VisitObject {
  return {
    id: o.id,
    name: o.name,
    ...(o.address ? { address: o.address } : {}),
    ...(o.folder ? { folder: o.folder } : {}),
    ...(o.refs?.length ? { refs: o.refs } : {}),
  }
}

/** A fresh draft — nothing is sent until the first save point. */
export function newVisitDoc({ object, workRef, checklist, people, now = new Date() }: {
  object: VisitObject
  workRef?: string | null
  checklist: VisitTemplate | null
  /** «Von» — the people who visit (prefilled from this device's last visit) */
  people?: string[]
  now?: Date
}): VisitDoc {
  return {
    schema: VISIT_SCHEMA,
    id: newId('ov'),
    object,
    ...(workRef ? { workRef } : {}),
    visitedAt: localIso(now),
    ...(people?.length ? { with: people } : {}),
    lifecycle: 'draft',
    checklist,
    answers: {},
    notes: '',
    photos: [],
    proposals: [],
  }
}

/** ISO 8601 with the device's own offset («2026-10-03T08:14:00+02:00») — the time of day the
 *  member saw, which is what a paper report prints. */
export function localIso(d: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
}

const SERVER_KEYS = ['revision', 'ready', 'missing', 'createdBy', 'createdAt', 'updatedAt', 'updatedBy', 'findings', 'url', 'deliveries'] as const

/** The document as the device PUTs it: a server read without the server's own fields. */
export function stripServer(v: ServerVisit | VisitDoc): VisitDoc {
  const out: Record<string, unknown> = { ...v }
  for (const k of SERVER_KEYS) delete out[k]
  const d = out as unknown as VisitDoc
  return {
    ...d,
    answers: d.answers ?? {},
    notes: d.notes ?? '',
    photos: Array.isArray(d.photos) ? d.photos : [],
    proposals: Array.isArray(d.proposals) ? d.proposals : [],
  }
}

/** Same document, whatever order the server put the keys in. */
export const sameDoc = (a: VisitDoc | null | undefined, b: VisitDoc | null | undefined): boolean => jsonEqual(a ?? null, b ?? null)

export interface AnswerStats {
  total: number
  answered: number
  ok: number
  defects: number
  na: number
  open: number
  /** required items still unanswered (they drive the «trotzdem abschliessen?» confirm) */
  requiredOpen: Item[]
  /** every unanswered item */
  openItems: Item[]
}

/** Is this item answered? A photo item counts once a photo links it, whatever `answers` says. */
export function isAnswered(doc: VisitDoc, item: Item): boolean {
  if (inputOf(item) === 'photo') return doc.photos.some((p) => p.item === item.id) || doc.answers[item.id] != null
  const a = doc.answers[item.id]
  return a != null && a.v !== '' && a.v != null
}

export function answerStats(doc: VisitDoc): AnswerStats {
  const items = checklistItems(doc.checklist)
  let ok = 0, defects = 0, na = 0, answered = 0
  const openItems: Item[] = []
  for (const it of items) {
    if (!isAnswered(doc, it)) { openItems.push(it); continue }
    answered++
    const v = doc.answers[it.id]?.v
    if (v === 'ok') ok++
    else if (v === 'defect') defects++
    else if (v === 'na') na++
  }
  return {
    total: items.length, answered, ok, defects, na, open: openItems.length,
    requiredOpen: openItems.filter((i) => i.required), openItems,
  }
}

/** Set (or clear, with `undefined`) one answer — the photo marker included. */
export function withAnswer(doc: VisitDoc, itemId: string, a: Answer | undefined): VisitDoc {
  const answers = { ...doc.answers }
  if (a === undefined) delete answers[itemId]
  else answers[itemId] = a
  return { ...doc, answers }
}

/**
 * A draft moves to another checklist (or to none) — owner, 05.10.2026: «allow changing the
 * checklist type». Answers whose item exists in the new one with the same input type stay; the
 * rest are dropped (`dropped` counts them, so the page can ask first). Photos always stay — one
 * linked to an item the new checklist does not have becomes a general photo. Pure.
 */
export function switchChecklist(doc: VisitDoc, next: VisitTemplate | null): { doc: VisitDoc; dropped: number } {
  const keep = new Map(checklistItems(next).map((i) => [i.id, inputOf(i)]))
  const old = new Map(checklistItems(doc.checklist).map((i) => [i.id, inputOf(i)]))
  const answers: VisitDoc['answers'] = {}
  let dropped = 0
  for (const [id, a] of Object.entries(doc.answers)) {
    if (keep.has(id) && keep.get(id) === (old.get(id) ?? keep.get(id))) answers[id] = a
    else if (old.get(id) !== 'photo') dropped++
  }
  const photos = doc.photos.map((p) => {
    if (!p.item || keep.get(p.item) === 'photo') return p
    const { item: _unlinked, ...rest } = p
    return rest
  })
  return { doc: syncPhotoAnswers({ ...doc, checklist: next ? structuredClone(next) : null, answers, photos }), dropped }
}

/** Keep each photo item's `"photo"` marker in step with the photos that link it (contract:
 *  set when ≥1 photo links the item). */
export function syncPhotoAnswers(doc: VisitDoc): VisitDoc {
  let next = doc
  for (const it of checklistItems(doc.checklist)) {
    if (inputOf(it) !== 'photo') continue
    const has = doc.photos.some((p) => p.item === it.id)
    const marked = doc.answers[it.id]?.v === 'photo'
    if (has && !marked) next = withAnswer(next, it.id, { v: 'photo' })
    else if (!has && marked) next = withAnswer(next, it.id, undefined)
  }
  return next
}

/** A short, filename-safe fragment («Hauptstrasse 24 - Gemeindeverwaltung» → same, minus `/:*…`). */
export function fileSafe(s: string, max = 60): string {
  return s.replace(/["*:<>?/\\|]/g, '').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '').slice(0, max)
}
