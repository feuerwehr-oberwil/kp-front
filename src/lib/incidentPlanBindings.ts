import type { PlanFloor } from './api/reference'
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
  /** the floor pack's page → Geschoss list as published for THIS revision, frozen with it: a
   *  later station re-assignment never renames or moves a running Einsatz's floors. Absent on
   *  ordinary sheets and on bindings from before floor packs existed. */
  floors?: PlanFloor[]
}

export const incidentGeorefKey = (incidentId: string, sheetKey: string) => `incident:${encodeURIComponent(incidentId)}:${sheetKey}`
export const isIncidentGeorefKey = (key: string) => key.startsWith('incident:')
export const effectiveBindingGeoref = (binding: IncidentPlanBinding) => binding.override ?? binding.georef

const cloneGeoref = (georef: Georef): Georef => ({ pairs: georef.pairs.map((pair) => ({ ...pair, plan: { ...pair.plan }, lngLat: { ...pair.lngLat } })) })

/** Preserve a legacy fit beneath existing annotations; unused sheets inherit approval directly. */
export function inheritPlanBinding(
  sheet: Pick<IncidentPlanBinding, 'id' | 'objectId' | 'planId' | 'datasetId' | 'planVersion' | 'title'>,
  approved: { id: number; page?: number; approval_id?: number | null; pairs: GeorefPair[]; aspect: number; approved_at: string } | undefined,
  legacy: Georef | null,
  hasAnnotations: boolean,
  floors?: PlanFloor[],
): IncidentPlanBinding {
  const keepLegacy = !!legacy?.pairs.length && hasAnnotations
  const inherited = !keepLegacy && approved ? { pairs: approved.pairs } : legacy ?? { pairs: [] }
  return {
    ...sheet, page: !keepLegacy && approved ? approved.page ?? 0 : 0, georef: cloneGeoref(inherited),
    ...(floors?.length ? { floors: floors.map((f) => ({ ...f })) } : {}),
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

const sameRevision = (a: IncidentPlanBinding, b: IncidentPlanBinding) => a.datasetId === b.datasetId && a.planVersion === b.planVersion

/**
 * A binding may GAIN its floors, once, and never change them. «First binding wins» protects the
 * backdrop – which revision, which fit – and absent floors are not a backdrop, they are an answer
 * that had not been given yet: the sheet was bound before the station published the pack, or by a
 * device that only had an older answer cached. Found 20.09.2026 on a stack whose `pack.bindingId`
 * named a binding with no floors – every storey read «Kein Geschossplan». Only the SAME dataset
 * revision may fill them in; a binding that has floors keeps exactly those.
 */
export function fillBindingFloors(existing: IncidentPlanBinding[], proposed: IncidentPlanBinding[]): IncidentPlanBinding[] {
  const donors = new Map(proposed.filter((b) => b.floors?.length).map((b) => [b.id, b]))
  if (!donors.size) return existing
  let changed = false
  const out = existing.map((binding) => {
    const donor = donors.get(binding.id)
    if (!donor || binding.floors?.length || !sameRevision(binding, donor)) return binding
    changed = true
    return { ...binding, floors: donor.floors!.map((f) => ({ ...f })) }
  })
  return changed ? out : existing
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
  // what «the same snapshot» is compared on: floors may be filled in later (fillBindingFloors),
  // so a side that merely HAS them is still the same frozen backdrop
  const frozen = ({ override: _override, floors: _floors, ...binding }: IncidentPlanBinding) => binding
  const out: IncidentPlanBinding[] = []
  for (const id of new Set([...server.keys(), ...local.keys()])) {
    const ancestor = bases.get(id), mi = local.get(id), th = server.get(id)
    if (ancestor && (!mi || !th)) continue // retain workspace delete-beats-edit semantics
    if (!mi || !th) { out.push((mi ?? th)!); continue }
    const fixed = ancestor ?? th
    const localMatches = equal(frozen(mi), frozen(fixed))
    const serverMatches = equal(frozen(th), frozen(fixed))
    let override = serverMatches ? th.override : fixed.override
    if (localMatches && (ancestor ? !equal(mi.override, ancestor.override) : mi.override !== undefined)) override = mi.override
    // the fixed side's floors stand; only their ABSENCE is filled, server side first
    const floors = fixed.floors?.length ? fixed.floors
      : [th, mi].find((side) => side.floors?.length && sameRevision(side, fixed))?.floors
    out.push({ ...snapshot(fixed), ...(floors?.length ? { floors } : {}), override })
  }
  return out
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isPair = (value: unknown): value is GeorefPair => object(value) && object(value.plan) && object(value.lngLat)
  && finite(value.plan.x) && finite(value.plan.y) && finite(value.lngLat.lng) && finite(value.lngLat.lat)
const isGeoref = (value: unknown): value is Georef => object(value) && Array.isArray(value.pairs) && value.pairs.every(isPair)
const nums = (v: unknown, n: number) => v == null || (Array.isArray(v) && v.length === n && v.every(finite))
const isJoin = (v: unknown) => v == null || (object(v) && Number.isInteger(v.to) && nums(v.at, 2) && v.at != null && nums(v.there, 2) && v.there != null)
const isFloor = (value: unknown): value is PlanFloor => object(value) && Number.isInteger(value.page) && Number(value.page) >= 0
  && Number.isInteger(value.index) && (value.name === null || typeof value.name === 'string') && nums(value.clip, 4) && isJoin(value.join)
export function isIncidentPlanBinding(value: unknown): value is IncidentPlanBinding {
  return object(value) && ['id', 'objectId', 'planId', 'datasetId', 'title'].every((key) => typeof value[key] === 'string')
    && Number.isInteger(value.planVersion) && Number(value.planVersion) > 0 && Number.isInteger(value.page) && Number(value.page) >= 0
    && ['approved', 'legacy', 'none'].includes(String(value.source)) && isGeoref(value.georef)
    && (value.override === undefined || isGeoref(value.override))
    && (value.aspect === undefined || (finite(value.aspect) && value.aspect > 0))
    && (value.floors === undefined || (Array.isArray(value.floors) && value.floors.every(isFloor)))
}

interface BindingSession {
  bindings: IncidentPlanBinding[]
  save: (id: string, georef: Georef, coalesce?: boolean) => void
}
const sessions = new Map<string, BindingSession>()

/** Namespaced sessions stop an old debounced georef write reaching the next incident. */
export function registerIncidentPlanBindings(incidentId: string, session: BindingSession): () => void {
  const prefix = incidentGeorefKey(incidentId, '')
  sessions.set(prefix, session)
  return () => {
    if (sessions.get(prefix) !== session) return
    sessions.delete(prefix)
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
/** The sheet lies on the map because the station reviewed and approved its alignment — and
 *  nobody on this incident has overridden it since. The Passung then names that provenance. */
export function incidentBindingApproved(key: string): boolean {
  const found = findBinding(key)
  return !!found && found.binding.source === 'approved' && !found.binding.override
}
export function saveIncidentGeoref(key: string, georef: Georef, coalesce?: boolean): void {
  const found = findBinding(key)
  if (!found) throw new Error('Incident plan binding is no longer available')
  found.session.save(found.binding.id, cloneGeoref(georef), coalesce)
}
