import type { Georef, GeorefPair } from './georef'
import type { Saved } from './workspace'

/** Old workspaces lack a binding marker; existing operator content requires conservative migration. */
export function hasLegacyAlignmentContext(workspace: Saved | null | undefined): boolean {
  if (!workspace) return false
  return !!(workspace.entities.length || workspace.drawings.length || workspace.trupps?.length
    || workspace.mittel?.length || workspace.shifts?.length || workspace.pickedObjectId
    || Object.keys(workspace.attendance ?? {}).length || Object.keys(workspace.checklists ?? {}).length
    || Object.values(workspace.board ?? {}).some((annotations) => annotations.length))
}

/** The exact sheet an incident opened, independent of later station publication. */
export interface IncidentPlanBinding {
  id: string
  objectId: string
  planId: string
  datasetId: string
  planVersion: number
  page: number
  title: string
  georef: Georef
  source: 'approved' | 'legacy' | 'none'
  approvalId?: number
  approvedAt?: string
  aspect?: number
  /** Explicitly empty pairs mean disconnected, rather than falling back to the station fit. */
  override?: Georef
}

export const incidentGeorefKey = (incidentId: string, sheetKey: string) => `incident:${encodeURIComponent(incidentId)}:${sheetKey}`
export const isIncidentGeorefKey = (key: string) => key.startsWith('incident:')
export const effectiveBindingGeoref = (binding: IncidentPlanBinding) => binding.override ?? binding.georef

const cloneGeoref = (georef: Georef): Georef => ({ pairs: georef.pairs.map((pair) => ({ ...pair, plan: { ...pair.plan }, lngLat: { ...pair.lngLat } })) })

/** Preserve a legacy fit beneath existing annotations; unused sheets inherit approval directly. */
export function inheritPlanBinding(
  sheet: Pick<IncidentPlanBinding, 'id' | 'objectId' | 'planId' | 'datasetId' | 'planVersion' | 'title'>,
  approved: { id: number; approval_id?: number | null; pairs: GeorefPair[]; aspect: number; approved_at: string } | undefined,
  legacy: Georef | null,
  hasAnnotations: boolean,
): IncidentPlanBinding {
  const keepLegacy = !!legacy?.pairs.length && hasAnnotations
  const inherited = !keepLegacy && approved ? { pairs: approved.pairs } : legacy ?? { pairs: [] }
  return {
    ...sheet, page: 0, georef: cloneGeoref(inherited),
    source: !keepLegacy && approved ? 'approved' : legacy?.pairs.length ? 'legacy' : 'none',
    ...(!keepLegacy && approved ? { approvalId: approved.approval_id ?? approved.id, approvedAt: approved.approved_at, aspect: approved.aspect } : {}),
  }
}

/** First binding wins; merging newly discovered sheets cannot update an operational backdrop. */
export function addPlanBindings(existing: IncidentPlanBinding[], proposed: IncidentPlanBinding[]): IncidentPlanBinding[] {
  const known = new Set(existing.map((binding) => binding.id))
  const added = proposed.filter((binding) => {
    if (known.has(binding.id)) return false
    known.add(binding.id)
    return true
  })
  return added.length ? [...existing, ...added] : existing
}

export function overridePlanBinding(bindings: IncidentPlanBinding[], id: string, georef: Georef): IncidentPlanBinding[] {
  return bindings.map((binding) => binding.id === id ? { ...binding, override: cloneGeoref(georef) } : binding)
}

/** The first server binding fixes the backdrop. Only an override of that same snapshot merges. */
export function mergeIncidentPlanBindings(base: IncidentPlanBinding[], mine: IncidentPlanBinding[], theirs: IncidentPlanBinding[]): IncidentPlanBinding[] {
  const bases = new Map(base.map((binding) => [binding.id, binding]))
  const local = new Map(mine.map((binding) => [binding.id, binding]))
  const server = new Map(theirs.map((binding) => [binding.id, binding]))
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const snapshot = ({ override: _override, ...binding }: IncidentPlanBinding) => binding
  const out: IncidentPlanBinding[] = []
  for (const id of new Set([...server.keys(), ...local.keys()])) {
    const ancestor = bases.get(id), mi = local.get(id), th = server.get(id)
    if (ancestor && (!mi || !th)) continue // retain workspace delete-beats-edit semantics
    if (!mi || !th) { out.push((mi ?? th)!); continue }
    const fixed = ancestor ?? th
    const localMatches = equal(snapshot(mi), snapshot(fixed))
    const serverMatches = equal(snapshot(th), snapshot(fixed))
    let override = serverMatches ? th.override : fixed.override
    if (localMatches && (ancestor ? !equal(mi.override, ancestor.override) : mi.override !== undefined)) override = mi.override
    out.push({ ...snapshot(fixed), override })
  }
  return out
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isPair = (value: unknown): value is GeorefPair => object(value) && object(value.plan) && object(value.lngLat)
  && finite(value.plan.x) && finite(value.plan.y) && finite(value.lngLat.lng) && finite(value.lngLat.lat)
const isGeoref = (value: unknown): value is Georef => object(value) && Array.isArray(value.pairs) && value.pairs.every(isPair)
export function isIncidentPlanBinding(value: unknown): value is IncidentPlanBinding {
  return object(value) && ['id', 'objectId', 'planId', 'datasetId', 'title'].every((key) => typeof value[key] === 'string')
    && Number.isInteger(value.planVersion) && Number(value.planVersion) > 0 && Number.isInteger(value.page) && Number(value.page) >= 0
    && ['approved', 'legacy', 'none'].includes(String(value.source)) && isGeoref(value.georef)
    && (value.override === undefined || isGeoref(value.override))
    && (value.aspect === undefined || (finite(value.aspect) && value.aspect > 0))
}

interface BindingSession {
  bindings: IncidentPlanBinding[]
  save: (id: string, georef: Georef, coalesce?: boolean) => void
}
const sessions = new Map<string, BindingSession>()
const listeners = new Set<() => void>()
export function subscribeIncidentPlanBindings(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function notify() { listeners.forEach((listener) => listener()) }

/** Namespaced sessions stop an old debounced georef write reaching the next incident. */
export function registerIncidentPlanBindings(incidentId: string, session: BindingSession): () => void {
  const prefix = incidentGeorefKey(incidentId, '')
  sessions.set(prefix, session)
  notify()
  return () => {
    if (sessions.get(prefix) !== session) return
    sessions.delete(prefix)
    notify()
  }
}
function findBinding(key: string) {
  for (const [prefix, session] of sessions) {
    if (!key.startsWith(prefix)) continue
    const binding = session.bindings.find((candidate) => candidate.id === key.slice(prefix.length))
    return binding ? { binding, session } : undefined
  }
}
export function incidentGeorefForPlan(key: string): Georef | null {
  const found = findBinding(key)
  return found ? effectiveBindingGeoref(found.binding) : null
}
export function saveIncidentGeoref(key: string, georef: Georef, coalesce?: boolean): void {
  const found = findBinding(key)
  if (!found) throw new Error('Incident plan binding is no longer available')
  found.session.save(found.binding.id, cloneGeoref(georef), coalesce)
}
