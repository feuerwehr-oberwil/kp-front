import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { planDocuments } from '../data/demoIncident'
import { objectsNearIncidentResilient, getObjectResilient, referenceUrl, type ObjectWithPlans, type ReferenceDataset } from './incidents'
import { getApprovedPlanAlignments } from './api/reference'
import { addPlanBindings, fillBindingFloors, incidentGeorefKey, inheritPlanBinding, type IncidentPlanBinding } from './incidentPlanBindings'
import { georefForPlan } from './stationPlanScale'
import { toast } from './ui'
import { fillTemplate } from './format'
import { appConfig } from '../config/appConfig'
import { modulesFromConfig, moduleViewer, moduleHiddenWithGebaeude } from './deploymentConfig'
import { comparePlanModules, moduleCatalogue, sortPlanModuleIds } from './planOrder'
import { moduleTileLabel } from './navRail'
import type { LngLat, PlanDocument } from '../types'

/**
 * Is this plan surface a SELECTION surface rather than a drawing surface?
 *
 * «Umrisse» (the live OSM outline sheet) exists for exactly one act: pick the building that
 * becomes the Gebäude floor-stack. Everything drawn there would be an annotation on a backdrop
 * nobody works on, so the surface carries no drawing apparatus at all — no tool rail, no armable
 * tool, no dock (Whiteboard · selectOnly).
 *
 * Keyed on `osm`, the catalog property that says what the surface IS. A check on the tile's
 * name or id would rot the first time a station renames it.
 */
export const isSelectOnlySurface = (p: Pick<PlanDocument, 'osm'> | undefined) => !!p?.osm

/** the plan id of the live OSM outline picker — one of the two faces of the Gebäude rail tile */
export const BUILDING_PICK_ID = 'osm'

/** Station-data identity for one concrete object's module sheet. Module ids are catalog slots
 *  reused by every object, so `modul2` alone is never a georeference key. Exported because the
 *  isolation rule is important enough to pin without mounting the async object hook. */
export const objectPlanGeorefKey = (objectId: string, planId: string) => `object:${objectId}:plan:${planId}`

/**
 * The RAIL's version of the plan list: the OSM outline picker and the Gebäude floor-stack are ONE
 * tile that morphs, so the rail lists one entry where the catalog holds two documents.
 *
 * ⚠️ Only the rail collapses — never the catalog. `planId` is a foreign key: Verlauf rows,
 * `Trupp.planId`, `planScale`, the `board` keys and the audit trail all name it, so a row that
 * says `osm` has to keep resolving to a document (and to a name on paper) long after a Gebäude
 * exists. Hand the FULL list to everything that looks a plan up by id, and this one to the rail.
 *
 * The tile always reads «Gebäude» — the word names the goal; the GLYPH states which face it wears:
 *   • no floor-stack yet → the footprint glyph — tapping opens the picker;
 *   • a floor-stack exists → the storey glyph.
 * (It used to read «Kein Gebäude» on the picker face; dropped 25.08. — the negation read odd on a
 * rail of nouns, and the glyph already carries the state for whoever is handed the tablet.)
 *
 * Which DOCUMENT the tile addresses follows the active plan, so the rail highlights it either way:
 * the stack, unless there is none yet or the operator deliberately stepped back onto the picker
 * (the «Anderes Gebäude wählen» chip, or an older Verlauf row jumping to `osm`).
 */
export function railPlanTiles(docs: PlanDocument[], activePlanId: string): PlanDocument[] {
  const pick = docs.find((p) => p.id === BUILDING_PICK_ID)
  const stack = docs.find((p) => p.floorStack)
  const base = stack && !(pick && activePlanId === BUILDING_PICK_ID) ? stack : pick
  if (!base) return docs
  const wb = appConfig.copy.whiteboard
  const tile: PlanDocument = {
    ...base,
    code: wb.railBuilding,
    icon: (stack ? stack.icon : pick?.icon) ?? base.icon,
  }
  // the merged tile keeps the picker's slot — the floor-stack was always inserted right after it
  const out: PlanDocument[] = []
  let placed = false
  for (const d of docs) {
    if (d.id !== BUILDING_PICK_ID && !d.floorStack) { out.push(d); continue }
    if (!placed) { out.push(tile); placed = true }
  }
  return out
}

// The station's plan catalog, split so ordering stays MAP → modules → Umrisse/Tafel:
//  - `modules` = configured module tiles (types/labels/order from deployment config) when present,
//    else the bundled module entries;
//  - `surfaces` = the non-module surfaces (OSM «Umrisse», blank «Tafel») from the bundled catalog,
//    which aren't "modules" and always come AFTER the modules.
function planCatalog(): { modules: PlanDocument[]; surfaces: PlanDocument[] } {
  const isModule = (p: PlanDocument) => /^modul/.test(p.id)
  const cfg = modulesFromConfig()
  return {
    modules: cfg.length ? cfg : planDocuments.filter(isModule),
    surfaces: planDocuments.filter((p) => !isModule(p)),
  }
}

/**
 * Backend object → plan surfacing, lifted out of App's god-component.
 *
 * Per-object module plans from the backend (modul1/2/3/6, plus Modul 4 / Modul-5 sub-slots like
 * modul5-wasser/modul5-pv) fill the module tiles when an Einsatzobjekt is near this incident;
 * without one, only the non-module surfaces (Umrisse, Tafel) show — no PDFs ship in the repo.
 *  - `autoInfo` (internal) = the nearest/address-matched object, surfaced automatically.
 *  - `manualObject` = a deliberate pick via the PlanPicker that overrides the auto-surface until reset.
 * `backendPlans` (manual ?? auto) is the effective module→URL map (and `backendTitles` the parallel
 * module→label map); `resolvedPlanDocs` is the plan-doc list with module PDFs swapped in, the OSM
 * "Umgebung" outline re-centred, and data-labelled tiles for any Modul 4/5 sub-sheets.
 *
 * `onActivePlan` lets `pickObject` jump to the chosen object's first module without coupling the
 * hook to App's navigation state.
 */
// Normalise whatever module key the backend tags a plan PDF with into the canonical id the
// frontend catalog uses: "Modul 2" / "2" / "modul2" → "modul2"; a combined sheet
// "Modul 2-3.pdf" tagged "modul2-3" / "2-3" / "Modul 2/3" / "modul2_3" → "modul2-3"; a named
// Modul-5 sub-slot "Modul 5 - Wasser" tagged "modul5-wasser" → "modul5-wasser" (kept distinct
// so Wasser/PV/RWA don't collapse onto a single modul5 tile).
// The trailing number of a sub-slot is part of the key, never noise: an object with «Wasser 1»
// AND «Wasser 2» has TWO waterplans (modul5-wasser1 / modul5-wasser2), and folding them onto one
// key made the second one disappear from the rail.
// ⚠️ Parsed from the «modul» word onward when there is one. The SharePoint pull titles a sheet
// «<object name> – modul2-3», and an object name like «Im Wasen 1-8» carries a range of its own
// that used to win – the sheet keyed as `modul1-8` and the rail grew a «1/8» tile labelled «8».
function normModule(m: string): string {
  const s0 = m.toLowerCase().replace(/\s+/g, '')
  const s = s0.slice(Math.max(0, s0.indexOf('modul')))
  const range = /(?:modul)?(\d+)[-_/](\d+)/.exec(s)
  if (range) return `modul${range[1]}-${range[2]}`
  const named = /(?:modul)?(\d+)-([a-z]{2,}\d*)/.exec(s) // modul5-wasser2 → keep the numbered sub-slot
  if (named) return `modul${named[1]}-${named[2]}`
  const single = /(?:modul)?(\d+)/.exec(s)
  if (single) return `modul${single[1]}`
  return s.startsWith('modul') ? s : `modul${s}`
}

// Modul 4 and the Modul-5 sub-sheets (Wasser/PV/RWA/…, including the numbered siblings Wasser 1
// and Wasser 2) have no fixed tile in `planDocuments` and vary per station — so we DON'T hardcode
// their names. We synthesize a tile from the backend module key (the only structural part is the
// module number for the `code`) and label it with whatever the source filename carried, threaded
// through as the dataset `title` — which is what keeps two waterplans apart in the rail.
export function extraModuleDoc(id: string, url: string, title?: string): PlanDocument {
  const num = /^modul(\d+)/.exec(id)?.[1] ?? '?'
  const label = (title || '').trim()
  // a sub-slot (modul5-wasser) reads "Wasser" in the rail, not "Modul 5"; a bare module keeps
  // "Modul N". moduleTileLabel owns the rule — it also keeps the label short enough for the
  // rail when the source filename is anything but (see there).
  const code = moduleTileLabel(id, label)
  return { id, code, title: label || `Modul ${num}`, subtitle: '', imageUrl: url, orientation: 'landscape' }
}

// The canonical plan-doc id for a backend PDF dataset, or null if it isn't a module plan.
// Prefers the explicit `module` tag; falls back to a module-shaped `title` (e.g. "Modul 2-3")
// so a combined sheet still maps even if the backend didn't tag its module field.
function planKey(pl: ReferenceDataset): string | null {
  if (pl.kind !== 'pdf') return null
  // A RANGE in the title ("Modul 2-3" / "Modul 2/3") wins over a single module tag.
  if (pl.title && /modul\s*\d+\s*[-_/]\s*\d+/i.test(pl.title)) return normModule(pl.title)
  const raw = pl.module || (pl.title && /modul/i.test(pl.title) ? pl.title : null)
  return raw ? normModule(raw) : null
}

/** The dataset identity behind one module key — what an incident's plan binding pins. */
export interface PlanDatasetRef {
  id: string
  version: number
}

// Build the module→reference-URL map for an object's plans, collapsing a combined "Modul 2-3.pdf".
// The corps' Einsatzpläne ingest a combined sheet as TWO datasets (modul2 + modul3) with DIFFERENT
// storage keys but IDENTICAL content — so they share `size_bytes` (verified in the live DB: 112
// objects match, the 6 genuinely-separate ones differ). Equal size ⇒ synthesize a `modul2-3` key so
// the rail shows ONE 2/3 tile; unequal size ⇒ leave Modul 2 and Modul 3 as separate tiles.
// `datasets` carries the (dataset id, current version) behind each key — the identity a plan
// binding freezes, which the URL string alone cannot provide.
export function buildPlanInfo(plans: ReferenceDataset[]): {
  plans: Record<string, string>
  titles: Record<string, string>
  datasets: Record<string, PlanDatasetRef>
} {
  const map: Record<string, string> = {}
  const titles: Record<string, string> = {} // module → label from the source filename (data-driven tiles)
  const datasets: Record<string, PlanDatasetRef> = {}
  for (const pl of plans) {
    const k = planKey(pl)
    if (!k) continue
    // One key, one plan: a second dataset that normalises onto a taken key (an older deployment
    // that tagged BOTH «Wasser 1» and «Wasser 2» as plain `modul5-wasser`) gets the next free
    // numbered variant instead of overwriting its sibling. Losing a waterplan is the one outcome
    // this map must never produce.
    let key = k
    for (let n = 2; map[key]; n += 1) key = `${k}${n}`
    map[key] = referenceUrl(pl.id, pl.current_version)
    datasets[key] = { id: pl.id, version: pl.current_version }
    if (pl.title) titles[key] = pl.title
  }
  if (!map['modul2-3']) {
    const m2 = plans.find((p) => planKey(p) === 'modul2')
    const m3 = plans.find((p) => planKey(p) === 'modul3')
    if (m2 && m3 && m2.size_bytes != null && m2.size_bytes === m3.size_bytes) {
      map['modul2-3'] = referenceUrl(m2.id, m2.current_version) // identical content → the combined sheet
      datasets['modul2-3'] = { id: m2.id, version: m2.current_version }
    }
  }
  return { plans: map, titles, datasets }
}

/** How the hook takes part in the incident's frozen sheet bindings (lib/incidentPlanBindings). */
/** What the Plan surface must warn about: the auto-surfaced object is NOT the incident's own
 *  address, only the nearest one with plans (`address_match === false`). Null when the address
 *  matched, when the distance is unknown, or on a payload cached before the field existed –
 *  an old listing must not turn every object amber. */
export function objectNearbyOnly(o: Pick<ObjectWithPlans, 'address_match' | 'distance_m'>): { distanceM: number } | null {
  if (o.address_match !== false || o.distance_m == null) return null
  return { distanceM: o.distance_m }
}

export interface PlanBindingOptions {
  /** the synced bindings slice of the workspace blob */
  bindings: IncidentPlanBinding[]
  /** persist newly proposed bindings (parent merges via addPlanBindings — first binding wins) */
  onBind: (proposed: IncidentPlanBinding[]) => void
  /** plan ids whose sheets already carry operator ink — a legacy station fit under annotations
   *  is preserved rather than replaced by a server approval */
  legacyPlanIds: Set<string>
  /** the workspace predates bindings and has content: treat EVERY sheet as annotated */
  preserveLegacy?: boolean
}

export function useObjectPlans(
  incidentId: string,
  center: LngLat,
  onActivePlan: (planId: string) => void,
  /** the synced picked-object id from the workspace blob (undefined → auto-surface). */
  pickedObjectId: string | undefined,
  /** persist a new pick (or undefined to reset) into the synced workspace blob. */
  onPick: (objectId: string | undefined) => void,
  /** when given, module sheets bind to their exact dataset revision + approved fit */
  bindingOpts?: PlanBindingOptions,
) {
  const [autoInfo, setAutoInfo] = useState<{ id?: string; plans: Record<string, string>; titles: Record<string, string>; datasets: Record<string, PlanDatasetRef>; name?: string; address?: string | null; pos?: LngLat | null; nearby?: { distanceM: number } | null }>({ plans: {}, titles: {}, datasets: {} })
  const [manualObject, setManualObject] = useState<{ id: string; name: string; address?: string | null; pos?: LngLat | null; plans: Record<string, string>; titles: Record<string, string>; datasets: Record<string, PlanDatasetRef> } | null>(null)
  const backendPlans = manualObject?.plans ?? autoInfo.plans
  const backendTitles = manualObject?.titles ?? autoInfo.titles
  const backendDatasets = manualObject?.datasets ?? autoInfo.datasets
  const activeObjectId = manualObject?.id ?? autoInfo.id

  // Bindings proposed by THIS hook instance, effective immediately: the parent's synced slice
  // follows through onBind, but a slow round-trip must not leave the sheet unpinned meanwhile.
  const [proposed, setProposed] = useState<IncidentPlanBinding[]>([])
  const effectiveBindings = useMemo(
    () => fillBindingFloors(addPlanBindings(bindingOpts?.bindings ?? [], proposed), proposed),
    [bindingOpts?.bindings, proposed],
  )
  // Stable refs for the callback/set options, so the binding effect keys on data, not identity.
  const bindingRef = useRef(bindingOpts)
  bindingRef.current = bindingOpts

  // Plan docs for THIS incident:
  //  - module PDFs (modul1/2/3/6) only appear when a near Einsatzobjekt actually provides them — so a
  //    far incident no longer shows the Wehrlin plans everywhere;
  //  - the OSM "Umgebung" outline centers on the incident location, not a fixed point.
  const resolvedPlanDocs = useMemo(
    () => {
      // a combined "Modul 2/3" sheet (id "modul2-3") collapses the two: when present, the
      // separate Modul 2 + Modul 3 tiles are hidden so the rail shows one "2/3" tile.
      const { modules: catalogModules, surfaces } = planCatalog()
      // a combined "Modul 2/3" sheet (id "modul2-3") collapses the separate 2 + 3 tiles
      const combined = new Set(
        catalogModules
          .filter((p) => /^modul(\d+)[-_/]\d+/.test(p.id) && !!backendPlans[p.id])
          .flatMap((p) => Array.from(p.id.matchAll(/\d+/g), (n) => `modul${n[0]}`)),
      )
      // A bound sheet is pinned: the incident keeps ITS revision's bytes, fit and shape, whatever
      // the station has published since. `georefKey` then routes to the binding rather than the
      // station document (stationPlanScale · georefForPlan branches on the `incident:` prefix).
      const bound = new Map(effectiveBindings.map((b) => [b.id, b]))
      const pin = (p: PlanDocument): PlanDocument => {
        if (!activeObjectId) return { ...p, georefKey: p.id }
        const sheetKey = objectPlanGeorefKey(activeObjectId, p.id)
        const binding = bound.get(sheetKey)
        if (!binding) return { ...p, georefKey: sheetKey }
        return {
          ...p,
          imageUrl: referenceUrl(binding.datasetId, binding.planVersion),
          georefKey: incidentGeorefKey(incidentId, binding.id),
          ...(binding.aspect ? { georefAspect: binding.aspect } : {}),
        }
      }
      // …and, once the object HAS a floor pack (its binding carries floors), not the modules the
      // catalogue hides behind the Gebäude stack (`modules[].hideWhenGebaeude`) – for FWO the
      // Modul-6 sheet, whose pages the stack shows
      const hasPack = !!activeObjectId && effectiveBindings.some((b) => b.objectId === activeObjectId && b.floors?.length)
      const hidden = (id: string) => hasPack && moduleHiddenWithGebaeude(id)
      // module tiles: only those the near Einsatzobjekt actually provides
      const moduleDocs = catalogModules
        .filter((p) => !!backendPlans[p.id] && !combined.has(p.id) && !hidden(p.id))
        .map((p) => pin({ ...p, imageUrl: backendPlans[p.id], viewer: moduleViewer(p.id) }))
      // Modul 4 / Modul-5 sub-slots the backend provides but the catalog has no tile for
      const known = new Set(catalogModules.map((p) => p.id))
      const extras = Object.keys(backendPlans)
        .filter((id) => !known.has(id) && /^modul\d/.test(id) && !combined.has(id) && !hidden(id))
        .map((id) => pin({ ...extraModuleDoc(id, backendPlans[id], backendTitles[id]), viewer: moduleViewer(id) }))
      // ⚠️ ONE order for the module tiles, the SAME the Verwaltung lists them in (lib/planOrder):
      // the number on the paper plan leads, so «M4» sits before «M5»/«ZUS»/«M6» whatever the
      // station document's `order` field says. Sorting the catalogue tiles and the synthesized
      // sub-slot tiles TOGETHER is the point — appended after the catalogue, a Modul 4 the
      // catalogue has no tile for landed behind every other module on the rail.
      const byModule = comparePlanModules(moduleCatalogue())
      const moduleTiles = [...moduleDocs, ...extras].sort((a, b) => byModule(a.id, b.id))
      // non-module surfaces (OSM «Umrisse», «Tafel») ALWAYS after the modules, in catalog order
      const surfaceDocs = surfaces.map((p) => (p.osm ? { ...p, osm: { ...p.osm, center } } : p))
      return [...moduleTiles, ...surfaceDocs]
    },
    [backendPlans, backendTitles, center, activeObjectId, effectiveBindings, incidentId],
  )

  // surface the nearest Einsatzobjekt's module plans (served from the backend) onto the
  // Plan tab; on failure or no object, only Umrisse + Tafel remain (no bundled plans)
  useEffect(() => {
    let alive = true
    objectsNearIncidentResilient(incidentId) // offline → falls back to the IDB-cached listing
      .then((objs) => {
        if (!alive) return
        const nearest = objs[0]
        setAutoInfo(nearest
          ? {
            id: nearest.id,
            ...buildPlanInfo(nearest.plans),
            name: nearest.name,
            address: nearest.address,
            pos: nearest.lat != null && nearest.lng != null ? [nearest.lng, nearest.lat] : null,
            nearby: objectNearbyOnly(nearest),
          }
          : { plans: {}, titles: {}, datasets: {} })
      })
      .catch(() => { /* no object reachable → Umrisse + Tafel only */ })
    return () => { alive = false }
  }, [incidentId])

  // Bind the active object's module sheets, once each: the FIRST answer freezes which dataset
  // revision and which fit this incident works on (addPlanBindings never replaces a binding).
  // A sheet whose legacy station fit sits under existing ink keeps that fit without asking the
  // server; everything else asks for the station-approved alignment of its exact revision.
  // «Unknown» is not «none»: when the answer is unreachable and uncached, the sheet stays
  // unbound this round and is asked again rather than frozen without its approval.
  const boundIdsKey = effectiveBindings.map((b) => b.id).join('|')
  useEffect(() => {
    const opts = bindingRef.current
    if (!opts || !activeObjectId) return
    const bound = new Set(boundIdsKey ? boundIdsKey.split('|') : [])
    const targets = Object.entries(backendDatasets)
      .filter(([planId]) => !bound.has(objectPlanGeorefKey(activeObjectId, planId)))
    if (!targets.length) return
    let alive = true
    void (async () => {
      const out: IncidentPlanBinding[] = []
      for (const [planId, ds] of targets) {
        const sheet = {
          id: objectPlanGeorefKey(activeObjectId, planId),
          objectId: activeObjectId,
          planId,
          datasetId: ds.id,
          planVersion: ds.version,
          title: backendTitles[planId] ?? planId,
        }
        const legacy = georefForPlan(sheet.id)
        const annotated = opts.legacyPlanIds.has(planId) || !!opts.preserveLegacy
        if (legacy?.pairs.length && annotated) {
          out.push(inheritPlanBinding(sheet, undefined, legacy, true))
          continue
        }
        try {
          const metadata = await getApprovedPlanAlignments(ds.id, ds.version)
          // a floor pack's ONE fit may sit on any of its floor pages (the EG page by default)
          const floors = metadata.floors?.length ? metadata.floors : undefined
          const approved = metadata.alignments.find((a) => a.page === 0 && a.aspect > 0)
            ?? (floors ? metadata.alignments.find((a) => a.aspect > 0) : undefined)
          out.push(inheritPlanBinding(sheet, approved ?? undefined, legacy, annotated, floors))
        } catch { /* offline and uncached — retry on the next resolve instead of freezing 'none' */ }
      }
      if (alive && out.length) {
        setProposed((prev) => addPlanBindings(prev, out))
        bindingRef.current?.onBind(out)
      }
    })()
    return () => { alive = false }
  }, [activeObjectId, backendDatasets, backendTitles, boundIdsKey])

  // …and a sheet bound WITHOUT floors asks once per session whether its revision has them by now
  // (lib/incidentPlanBindings · fillBindingFloors): bound before the station published the pack,
  // or by a device holding an older answer. Only the revision it froze – a newer one is not its.
  const floorsAsked = useRef(new Set<string>())
  const floorlessKey = effectiveBindings.filter((b) => b.objectId === activeObjectId && !b.floors?.length && b.source !== 'legacy')
    .map((b) => b.id).join('|')
  useEffect(() => {
    if (!bindingRef.current || !floorlessKey) return
    const ids = new Set(floorlessKey.split('|'))
    const targets = effectiveBindings.filter((b) => ids.has(b.id) && !floorsAsked.current.has(b.id)
      && backendDatasets[b.planId]?.id === b.datasetId && backendDatasets[b.planId]?.version === b.planVersion)
    if (!targets.length) return
    let alive = true
    void (async () => {
      const out: IncidentPlanBinding[] = []
      for (const b of targets) {
        floorsAsked.current.add(b.id)
        try {
          const metadata = await getApprovedPlanAlignments(b.datasetId, b.planVersion)
          if (metadata.floors?.length) out.push({ ...b, floors: metadata.floors })
        } catch { floorsAsked.current.delete(b.id) /* unreachable and uncached – ask again next time */ }
      }
      if (alive && out.length) {
        setProposed((prev) => fillBindingFloors(addPlanBindings(prev, out), out))
        bindingRef.current?.onBind(out)
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorlessKey, backendDatasets])

  // reflect the synced picked-object id (workspace blob): when set — this device's pick, a reload,
  // or ANOTHER device's pick arriving via the live-follow poll — fetch the object's plans; when
  // cleared, drop back to the auto-surfaced nearest object. Skip the fetch when we already hold this
  // object (we just picked it locally). Object gone → silently keep the auto-surface.
  useEffect(() => {
    if (!pickedObjectId) { setManualObject(null); return }
    if (manualObject?.id === pickedObjectId) return
    let alive = true
    getObjectResilient(pickedObjectId) // offline → falls back to the IDB-cached object
      .then((obj) => { if (alive) setManualObject({ id: obj.id, name: obj.name, address: obj.address, pos: obj.lat != null && obj.lng != null ? [obj.lng, obj.lat] : null, ...buildPlanInfo(obj.plans) }) })
      .catch(() => { /* object removed → fall back to auto */ })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedObjectId, incidentId])

  // manually surface another object's module plans (overrides the auto-surface). Build the same
  // modulN → referenceUrl map the auto path builds, persist the pick into the synced blob, then
  // jump to the first module so the chosen object's PDF is visible immediately.
  const pickObject = useCallback((obj: ObjectWithPlans) => {
    const info = buildPlanInfo(obj.plans)
    setManualObject({ id: obj.id, name: obj.name, address: obj.address, pos: obj.lat != null && obj.lng != null ? [obj.lng, obj.lat] : null, ...info })
    onPick(obj.id) // sync the pick per incident (workspace blob), so it survives switching + reload
    // jump to the object's FIRST module in the rail's own order — Modul 1 where it has one
    const firstModule = sortPlanModuleIds(moduleCatalogue(), Object.keys(info.plans))[0]
    if (firstModule) onActivePlan(firstModule)
    toast(fillTemplate(appConfig.copy.whiteboard.objectActive, { name: obj.name }), { icon: 'doc', tone: 'success' })
  }, [onActivePlan, onPick])
  // back to the auto-surfaced nearest object (and forget the synced pick for this incident)
  const resetObject = useCallback(() => {
    setManualObject(null)
    onPick(undefined)
    toast(appConfig.copy.whiteboard.objectReset, { icon: 'doc' })
  }, [onPick])

  // the name shown in the incident dropdown's «Objekt: …» row — manual pick wins, else the
  // auto-surfaced nearest object, else null (row falls back to «Anderes Objekt»)
  const activeObjectName = manualObject?.name ?? autoInfo.name ?? null
  // The chip over the plans reads the ADDRESS, not the name: «Mühlemattstrasse 8» is both
  // shorter than «Schloss Bottmingen» and the thing an Einsatz is actually called by. The name
  // stays the label everywhere the object is CHOSEN (the picker, the toast), where it is what
  // you search for. Falls back to the name when an object carries no address.
  const activeObjectAddress = manualObject?.address ?? autoInfo.address ?? null
  // the active object's own coordinate — the anchor «Automatisch ausrichten» fetches its OSM
  // reference box around. Null when the object carries none (callers fall back to the incident).
  const activeObjectPos = manualObject ? manualObject.pos ?? null : autoInfo.pos ?? null
  // the warning the object chip carries when the AUTO-surfaced object is merely the nearest one
  // and not the Einsatzadresse. A manual pick is the operator's own choice – no warning.
  // …with the object's id, so the plan surface can remember its banner per Einsatz and object
  const activeObjectNearby = manualObject || !autoInfo.nearby ? null : { ...autoInfo.nearby, objectId: autoInfo.id ?? '' }
  return { backendPlans, resolvedPlanDocs, effectiveBindings, manualObject, activeObjectId, activeObjectName, activeObjectAddress, activeObjectPos, activeObjectNearby, pickObject, resetObject }
}
