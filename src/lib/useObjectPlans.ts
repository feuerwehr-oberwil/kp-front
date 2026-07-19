import { useCallback, useEffect, useMemo, useState } from 'react'
import { planDocuments } from '../data/demoIncident'
import { objectsNearIncidentResilient, getObjectResilient, referenceUrl, type ObjectWithPlans, type ReferenceDataset } from './incidents'
import { toast } from './ui'
import { fillTemplate } from './format'
import { appConfig } from '../config/appConfig'
import { modulesFromConfig, moduleViewer } from './deploymentConfig'
import type { LngLat, PlanDocument } from '../types'

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
function normModule(m: string): string {
  const s = m.toLowerCase().replace(/\s+/g, '')
  const range = /(?:modul)?(\d+)[-_/](\d+)/.exec(s)
  if (range) return `modul${range[1]}-${range[2]}`
  const named = /(?:modul)?(\d+)-([a-z]{2,})/.exec(s) // modul5-wasser → keep the sub-slot
  if (named) return `modul${named[1]}-${named[2]}`
  const single = /(?:modul)?(\d+)/.exec(s)
  if (single) return `modul${single[1]}`
  return s.startsWith('modul') ? s : `modul${s}`
}

// Modul 4 and the Modul-5 sub-sheets (Wasser/PV/RWA/…) have no fixed tile in `planDocuments`
// and vary per station — so we DON'T hardcode their names. We synthesize a tile from the backend
// module key (the only structural part is the module number for the `code`) and label it with
// whatever the source filename carried, threaded through as the dataset `title`.
function extraModuleDoc(id: string, url: string, title?: string): PlanDocument {
  const num = /^modul(\d+)/.exec(id)?.[1] ?? '?'
  const label = (title || '').trim()
  // a sub-slot (modul5-wasser) uses the sub-sheet name as its label so the rail reads "Wasser",
  // not "Modul 5"; a bare module keeps "Modul N".
  const code = /^modul\d+-/.test(id) && label ? label : `Modul ${num}`
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

// Build the module→reference-URL map for an object's plans, collapsing a combined "Modul 2-3.pdf".
// The corps' Einsatzpläne ingest a combined sheet as TWO datasets (modul2 + modul3) with DIFFERENT
// storage keys but IDENTICAL content — so they share `size_bytes` (verified in the live DB: 112
// objects match, the 6 genuinely-separate ones differ). Equal size ⇒ synthesize a `modul2-3` key so
// the rail shows ONE 2/3 tile; unequal size ⇒ leave Modul 2 and Modul 3 as separate tiles.
function buildPlanInfo(plans: ReferenceDataset[]): { plans: Record<string, string>; titles: Record<string, string> } {
  const map: Record<string, string> = {}
  const titles: Record<string, string> = {} // module → label from the source filename (data-driven tiles)
  for (const pl of plans) {
    const k = planKey(pl)
    if (!k) continue
    map[k] = referenceUrl(pl.id)
    if (pl.title) titles[k] = pl.title
  }
  if (!map['modul2-3']) {
    const m2 = plans.find((p) => planKey(p) === 'modul2')
    const m3 = plans.find((p) => planKey(p) === 'modul3')
    if (m2 && m3 && m2.size_bytes != null && m2.size_bytes === m3.size_bytes) {
      map['modul2-3'] = referenceUrl(m2.id) // identical content → the combined sheet
    }
  }
  return { plans: map, titles }
}

export function useObjectPlans(
  incidentId: string,
  center: LngLat,
  onActivePlan: (planId: string) => void,
  /** the synced picked-object id from the workspace blob (undefined → auto-surface). */
  pickedObjectId: string | undefined,
  /** persist a new pick (or undefined to reset) into the synced workspace blob. */
  onPick: (objectId: string | undefined) => void,
) {
  const [autoInfo, setAutoInfo] = useState<{ plans: Record<string, string>; titles: Record<string, string>; name?: string }>({ plans: {}, titles: {} })
  const [manualObject, setManualObject] = useState<{ id: string; name: string; plans: Record<string, string>; titles: Record<string, string> } | null>(null)
  const backendPlans = manualObject?.plans ?? autoInfo.plans
  const backendTitles = manualObject?.titles ?? autoInfo.titles

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
      // module tiles: only those the near Einsatzobjekt actually provides
      const moduleDocs = catalogModules
        .filter((p) => !!backendPlans[p.id] && !combined.has(p.id))
        .map((p) => ({ ...p, imageUrl: backendPlans[p.id], viewer: moduleViewer(p.id) }))
      // Modul 4 / Modul-5 sub-slots the backend provides but the catalog has no tile for
      const known = new Set(catalogModules.map((p) => p.id))
      const extras = Object.keys(backendPlans)
        .filter((id) => !known.has(id) && /^modul\d/.test(id) && !combined.has(id))
        .sort()
        .map((id) => ({ ...extraModuleDoc(id, backendPlans[id], backendTitles[id]), viewer: moduleViewer(id) }))
      // non-module surfaces (OSM «Umrisse», «Tafel») ALWAYS after the modules, in catalog order
      const surfaceDocs = surfaces.map((p) => (p.osm ? { ...p, osm: { ...p.osm, center } } : p))
      return [...moduleDocs, ...extras, ...surfaceDocs]
    },
    [backendPlans, backendTitles, center],
  )

  // surface the nearest Einsatzobjekt's module plans (served from the backend) onto the
  // Plan tab; on failure or no object, only Umrisse + Tafel remain (no bundled plans)
  useEffect(() => {
    let alive = true
    objectsNearIncidentResilient(incidentId) // offline → falls back to the IDB-cached listing
      .then((objs) => {
        if (!alive) return
        const nearest = objs[0]
        setAutoInfo(nearest ? { ...buildPlanInfo(nearest.plans), name: nearest.name } : { plans: {}, titles: {} })
      })
      .catch(() => { /* no object reachable → Umrisse + Tafel only */ })
    return () => { alive = false }
  }, [incidentId])

  // reflect the synced picked-object id (workspace blob): when set — this device's pick, a reload,
  // or ANOTHER device's pick arriving via the live-follow poll — fetch the object's plans; when
  // cleared, drop back to the auto-surfaced nearest object. Skip the fetch when we already hold this
  // object (we just picked it locally). Object gone → silently keep the auto-surface.
  useEffect(() => {
    if (!pickedObjectId) { setManualObject(null); return }
    if (manualObject?.id === pickedObjectId) return
    let alive = true
    getObjectResilient(pickedObjectId) // offline → falls back to the IDB-cached object
      .then((obj) => { if (alive) setManualObject({ id: obj.id, name: obj.name, ...buildPlanInfo(obj.plans) }) })
      .catch(() => { /* object removed → fall back to auto */ })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedObjectId, incidentId])

  // manually surface another object's module plans (overrides the auto-surface). Build the same
  // modulN → referenceUrl map the auto path builds, persist the pick into the synced blob, then
  // jump to the first module so the chosen object's PDF is visible immediately.
  const pickObject = useCallback((obj: ObjectWithPlans) => {
    const info = buildPlanInfo(obj.plans)
    setManualObject({ id: obj.id, name: obj.name, ...info })
    onPick(obj.id) // sync the pick per incident (workspace blob), so it survives switching + reload
    // jump to Modul 1 if the object has it, else its lowest-numbered module
    const firstModule = info.plans.modul1 ? 'modul1' : Object.keys(info.plans).sort()[0]
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
  return { backendPlans, resolvedPlanDocs, manualObject, activeObjectName, pickObject, resetObject }
}
