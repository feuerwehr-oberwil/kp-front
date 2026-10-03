// The offline catalogue of Objektbesuche: objects, visit checklists, work lists, proposal fields.
// One small document (~150 objects of text), read through `kp-front-ov-catalogue` so the surface
// works in a cellar. ⚠️ A catalogue that could not be read is MISSING, never empty: «0 Objekte»
// would read as «this station has no objects», and the visit would silently start without the
// checklist the station expects (docs/object-visits.md · Device).

import { ApiError, isUnverifiable } from '../lib/api'
import { readThrough, type ReadThroughSource } from '../lib/idb'
import { getCatalogue, listVisits } from './api'
import type { Catalogue, CatalogueObject, ObjectRef, VisitSummary, VisitTemplate } from './types'

export const CATALOGUE_KEY = 'kp-front-ov-catalogue'

export function isCatalogue(v: unknown): v is Catalogue {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return Array.isArray(c.objects) && Array.isArray(c.templates) && typeof c.generatedAt === 'string'
}

/** Normalise the optional arrays so every reader can iterate without a guard. */
function normalise(c: Catalogue): Catalogue {
  return {
    ...c,
    canCapture: c.canCapture === true,
    lists: Array.isArray(c.lists) ? c.lists : [],
    proposalFields: Array.isArray(c.proposalFields) ? c.proposalFields : [],
    // visit surfaces only ever use `kind: 'visit'` (contract)
    templates: c.templates.filter((t) => t && t.kind === 'visit'),
  }
}

export type CatalogueState =
  | { state: 'ready' | 'stale'; catalogue: Catalogue; source: ReadThroughSource }
  /** never prepared on this device (or the cache could not be read) — and no server answer */
  | { state: 'missing'; error: unknown }
  /** the module is off on the server (404 `object_visits_disabled`) or the role is refused */
  | { state: 'refused'; error: ApiError }

/** Load the catalogue: network first, the device copy when the server could not be asked — or
 *  when the session lapsed (401), because the work on this device does not stop with a login. */
export async function loadCatalogue(fetcher: () => Promise<Catalogue> = getCatalogue): Promise<CatalogueState> {
  try {
    const { value, source } = await readThrough<Catalogue>(CATALOGUE_KEY, fetcher, {
      validate: isCatalogue,
      shouldFallback: (e) => isUnverifiable(e) || (e instanceof ApiError && e.status === 401),
    })
    return { state: source === 'network' ? 'ready' : 'stale', catalogue: normalise(value), source }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return { state: 'refused', error: e }
    return { state: 'missing', error: e }
  }
}

/** What the readiness line says: how many objects / checklists, as of when. */
export function readiness(c: Catalogue): { objects: number; templates: number; lists: number; generatedAt: string } {
  return { objects: c.objects.length, templates: c.templates.length, lists: c.lists.length, generatedAt: c.generatedAt }
}

/**
 * Resolve the `object=` of a launch link: `<source>:<id>` against the objects' refs, or a bare
 * Front uuid. Null when this catalogue does not know it.
 */
export function resolveObject(c: Catalogue, key: string): CatalogueObject | null {
  const k = key.trim()
  if (!k) return null
  const direct = c.objects.find((o) => o.id === k)
  if (direct) return direct
  const i = k.indexOf(':')
  if (i <= 0) return null
  const ref: ObjectRef = { source: k.slice(0, i), id: k.slice(i + 1) }
  return c.objects.find((o) => (o.refs ?? []).some((r) => r.source === ref.source && r.id === ref.id)) ?? null
}

/** The visit checklists to offer, newest version per id first. */
export function visitTemplates(c: Catalogue): VisitTemplate[] {
  const byId = new Map<string, VisitTemplate>()
  for (const t of c.templates) {
    const have = byId.get(t.id)
    if (!have || (t.version ?? 0) > (have.version ?? 0)) byId.set(t.id, t)
  }
  return [...byId.values()].sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.title.localeCompare(b.title))
}

/** Metres between two WGS84 points (haversine) — for «In der Nähe». */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** The objects nearest to a position, with their distance — only those that carry a position. */
export function nearestObjects(c: Catalogue, at: { lat: number; lng: number }, limit = 10): { object: CatalogueObject; m: number }[] {
  return c.objects
    .filter((o): o is CatalogueObject & { lat: number; lng: number } => typeof o.lat === 'number' && typeof o.lng === 'number')
    .map((o) => ({ object: o as CatalogueObject, m: distanceM(at, { lat: o.lat, lng: o.lng }) }))
    .sort((a, b) => a.m - b.m)
    .slice(0, limit)
}

/** The server's visit list (newest first), kept on the device beside the catalogue so a work
 *  list's «3/11 besucht» holds offline. Device-only key, not part of the contract's record set. */
export const SUMMARIES_KEY = 'kp-front-ov-visits'

/** Null when neither the server nor the device copy answered (never «no visits»). */
export async function loadSummaries(fetcher: () => Promise<VisitSummary[]> = () => listVisits({ limit: 500 })): Promise<{ list: VisitSummary[]; fresh: boolean } | null> {
  try {
    const { value, source } = await readThrough<VisitSummary[]>(SUMMARIES_KEY, fetcher, {
      validate: (v): v is VisitSummary[] => Array.isArray(v),
      shouldFallback: (e) => isUnverifiable(e) || (e instanceof ApiError && e.status === 401),
    })
    return { list: value, fresh: source === 'network' }
  } catch {
    return null
  }
}

/** A work list's progress: per object the visit made WITH this list's reference (completed
 *  before draft; a discarded one does not count), and how many are completed. Device copies and
 *  server rows alike. */
export function listProgress(
  list: { ref: string; objectIds: string[] },
  visits: { objectId: string; workRef?: string | null; lifecycle: string; visitedAt?: string; id: string }[],
): { done: number; total: number; byObject: Map<string, { id: string; lifecycle: string; visitedAt?: string }> } {
  const byObject = new Map<string, { id: string; lifecycle: string; visitedAt?: string }>()
  for (const v of visits) {
    if (v.workRef !== list.ref || v.lifecycle === 'discarded') continue
    const have = byObject.get(v.objectId)
    // a completed visit outranks a draft; among equals the newer one
    const rank = (x: { lifecycle: string }) => (x.lifecycle === 'completed' ? 1 : 0)
    if (!have || rank(v) > rank(have) || (rank(v) === rank(have) && (v.visitedAt ?? '') > (have.visitedAt ?? ''))) {
      byObject.set(v.objectId, { id: v.id, lifecycle: v.lifecycle, visitedAt: v.visitedAt })
    }
  }
  // «besucht» = completed; a draft shows as «Entwurf» on its row but is not progress yet
  const done = list.objectIds.filter((id) => byObject.get(id)?.lifecycle === 'completed').length
  return { done, total: list.objectIds.length, byObject }
}

/** Every visit this device knows of — device copies over server rows (for list progress). */
export function knownVisits(
  locals: { doc: { id: string; object: { id: string }; workRef?: string | null; lifecycle: string; visitedAt: string } }[],
  summaries: VisitSummary[] | null,
): { id: string; objectId: string; workRef?: string | null; lifecycle: string; visitedAt?: string }[] {
  const map = new Map<string, { id: string; objectId: string; workRef?: string | null; lifecycle: string; visitedAt?: string }>()
  for (const v of summaries ?? []) map.set(v.id, v)
  for (const l of locals) map.set(l.doc.id, { id: l.doc.id, objectId: l.doc.object.id, workRef: l.doc.workRef ?? null, lifecycle: l.doc.lifecycle, visitedAt: l.doc.visitedAt })
  return [...map.values()]
}
