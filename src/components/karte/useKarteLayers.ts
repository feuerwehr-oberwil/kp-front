// «Karte & Objekte» — the viewer's Ebenen (docs/karte-objekte.md · «The viewer», «Object colours»,
// «Unterirdische Bauten»): its layers, the object categories, the aligned plan, and the rows the
// LayerPanel shows beside the deployment's layers.

import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import { appConfig } from '../../config/appConfig'
import { getLocaleId } from '../../config/copy'
import { fillTemplate } from '../../lib/format'
import { objectCategoryRules } from '../../lib/deploymentConfig'
import { defaultLayers } from '../../lib/workspace'
import { toast } from '../../lib/ui'
import { getApprovedPlanAlignments, referenceUrl } from '../../lib/incidents'
import { useUnderground } from '../../lib/underground'
import { fitSimilarity } from '../../lib/georef'
import { withPdfPage } from '../../lib/whiteboard'
import type { StationObject } from '../../lib/api/stationReference'
import { categorize, categoryRules } from '../../lib/karte/categories'
import { applyLayerPreset, karteLayerPreset, presetFlips, type QuickTap } from '../../lib/karte/layerPresets'
import { ALWAYS_LAYER, OBJECTS_LAYER, UNCACHED_LAYER, UNDERGROUND_LAYER } from '../../lib/karte/overlays'
import { coordOf } from '../../lib/karte/search'
import { loadViewerLayerPrefs, saveViewerLayerPrefs, viewerLayers } from '../../lib/karte/session'
import type { LayerDef, LayerId } from '../../types'
import type { useKarteWeather } from '../../workspace/useKarteWeather'
import { panelPad } from './useKarteCamera'

/** the Ebenen rows the viewer adds (LayerPanel twins) */
const OBJECTS_ROW = 'karte:objekte'
const GEOREF_ROW = 'karte:objektplan'
/** an Ebenen row per object category (lib/karte/categories) */
const CAT_ROW = 'karte:kategorie:'
/** «Unterirdische Bauten» (owner, review rounds 4 + 5): every underground building and tunnel of
 *  the Einsatzgebiet, from street zoom on — ON by default and part of «Standard» (round 5), the
 *  Einsatz map shows the same layer (lib/underground) */
const UNDERGROUND_ROW = 'karte:unterirdisch'

/** The deployment's layers, minus the Einsatz-only ones, with this device's own choices
 *  (lib/karte/session), and the viewer's own two: the station objects, and «Unterirdische
 *  Bauten» — on when the viewer opens (round 5), asked once, kept for the visit; switched off it
 *  stays off until a reload brings the default back (lib/underground). `isVisible` is MapView's. */
export function useViewerLayers() {
  const [layers, setLayers] = useState<LayerDef[]>(() => viewerLayers(defaultLayers(), loadViewerLayerPrefs()))
  const [objectsOn, setObjectsOn] = useState(true)
  const [underOn, setUnderOn] = useState(true)
  const under = useUnderground(underOn)
  const updateLayers = (fn: (ls: LayerDef[]) => LayerDef[]) => setLayers((ls) => { const next = fn(ls); saveViewerLayerPrefs(next); return next })
  const isVisible = useCallback((id: LayerId) => {
    if (id === OBJECTS_LAYER) return objectsOn
    if (id === UNDERGROUND_LAYER) return underOn
    if (id === ALWAYS_LAYER || id === UNCACHED_LAYER) return true
    return layers.find((l) => l.id === id)?.visible ?? true
  }, [layers, objectsOn, underOn])
  return {
    layers, updateLayers, isVisible, objectsOn, underOn, under,
    toggleObjects: () => setObjectsOn((v) => !v),
    toggleUnder: () => setUnderOn((v) => !v),
  }
}

/** The station's object colours (config `map.objectCategories`, lib/karte/categories). An object
 *  no rule takes keeps the default look (`--obj-plans`; grey without plans). Each category is an
 *  Ebenen row of its own; a hidden one takes its objects off the map (`catOff`: outline, dot, tag,
 *  tap) — the selected object stays, it was chosen on purpose. */
export function useObjectCategories(objects: readonly StationObject[], lang: string) {
  const catRules = useMemo(() => categoryRules(objectCategoryRules(), lang), [lang])
  const cats = useMemo(() => categorize(objects, catRules), [objects, catRules])
  const [hiddenCats, setHiddenCats] = useState<ReadonlySet<string>>(() => new Set())
  const catOff = useCallback((id: string) => { const c = cats.get(id); return !!c && hiddenCats.has(c.id) }, [cats, hiddenCats])
  const toggleCat = (id: string) => setHiddenCats((h) => { const next = new Set(h); if (!next.delete(id)) next.add(id); return next })
  return { catRules, cats, hiddenCats, catOff, toggleCat }
}

type Corners = [[number, number], [number, number], [number, number], [number, number]]

/** The selected object's aligned plan on the map — view only, its opacity in Ebenen. Switched on,
 *  the map eases onto the object; a plan that cannot be fitted switches itself off with a toast. */
export function useGeorefPlan(selObj: StationObject | null, mapRef: RefObject<MapRef | null>, phone: boolean, zoom: number) {
  const C = appConfig.copy.karte
  const georefPlan = selObj?.plans.find((p) => p.georef) ?? null
  const [georefOn, setGeorefOn] = useState(false)
  const [georefOpacity, setGeorefOpacity] = useState(55)
  const [raster, setRaster] = useState<{ key: string; url: string; corners: Corners } | null>(null)
  const rasterKey = georefOn && georefPlan ? `${georefPlan.id}@${georefPlan.version}` : null
  useEffect(() => {
    if (!rasterKey || !georefPlan) return
    let alive = true
    void (async () => {
      const meta = await getApprovedPlanAlignments(georefPlan.id, georefPlan.version)
      const a = meta.alignments[0]
      const fit = a ? fitSimilarity(a.pairs, a.aspect) : null
      if (!a || !fit) throw new Error('no fit')
      const base = referenceUrl(georefPlan.id, georefPlan.version)
      const url = await import('../../lib/pdfRaster').then((m) => m.planPreviewUrl((meta.page_count ?? 1) > 1 ? withPdfPage(base, a.page) : base, window.innerWidth, window.innerHeight))
      const corners = ([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] as const).map((pt) => { const c = fit.toMap(pt); return [c.lng, c.lat] as [number, number] })
      if (alive) setRaster({ key: rasterKey, url, corners: corners as Corners })
    })().catch(() => { if (alive) { setGeorefOn(false); toast(C.georefFailed, { icon: 'warn', tone: 'warn' }) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rasterKey is the plan revision
  }, [rasterKey])
  const georefRasters = raster && raster.key === rasterKey ? [{ id: `karte-georef-${raster.key}`, url: raster.url, opacity: georefOpacity / 100, coordinates: raster.corners }] : []
  const toggleGeoref = () => {
    const next = !georefOn
    setGeorefOn(next)
    const at = selObj && coordOf(selObj)
    if (next && at) mapRef.current?.easeTo({ center: at, zoom: Math.max(zoom, 18), padding: panelPad(phone), duration: 600 })
  }
  return { georefPlan, georefOn, georefOpacity, setGeorefOpacity, georefRasters, toggleGeoref }
}

/** Ebenen's rows and taps: the deployment's layers, the viewer's own rows under «Station» (the
 *  objects, one per category, Unterirdische Bauten) and the selected object's aligned plan, and
 *  «Alle ein» / «Alle aus» / «Standard» (lib/karte/layerPresets) over all of them — never the
 *  aligned plan, like the Einsatz. */
export function useKarteEbenen(p: {
  viewer: ReturnType<typeof useViewerLayers>
  categories: ReturnType<typeof useObjectCategories>
  georef: ReturnType<typeof useGeorefPlan>
  selObj: StationObject | null
  weather: ReturnType<typeof useKarteWeather>
}) {
  const C = appConfig.copy.karte
  const { viewer, categories, georef, selObj, weather } = p
  const { layers, updateLayers, objectsOn, underOn, under } = viewer
  const toggleLayer = (id: string) => {
    if (id === OBJECTS_ROW) { viewer.toggleObjects(); return }
    if (id === UNDERGROUND_ROW) { viewer.toggleUnder(); return }
    if (id.startsWith(CAT_ROW)) { categories.toggleCat(id.slice(CAT_ROW.length)); return }
    if (id === GEOREF_ROW) { georef.toggleGeoref(); return }
    if (weather.handlesLayer(id)) { weather.toggleRadar(); return }
    updateLayers((ls) => {
      const hit = ls.find((l) => l.id === id)
      if (!hit) return ls
      if (hit.base) return ls.map((l) => (l.base ? { ...l, visible: l.id === id } : l))
      return ls.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l))
    })
  }
  const setOpacity = (id: string, v: number) => {
    if (id === GEOREF_ROW) { georef.setGeorefOpacity(v); return }
    if (weather.handlesLayer(id)) { weather.setRadarOpacity(v); return }
    updateLayers((ls) => ls.map((l) => (l.id === id ? { ...l, opacity: v } : l)))
  }
  const { georefPlan } = georef
  const twins = [
    { id: OBJECTS_ROW, group: C.layerGroupStation, label: C.layerObjects, sub: C.layerObjectsSub, icon: 'footprint', visible: objectsOn },
    // one row per category, its colour on the glyph (an `ink` one: the theme's `--obj-plans`, as a
    // CSS var so it follows the flip), under «Station» (R2-BITS' Alle/Keine/Standard work over these
    // like over any row); no object count on them – the owner doesn't want it (20.10.2026)
    ...categories.catRules.map((c) => ({
      id: `${CAT_ROW}${c.id}`, group: C.layerGroupStation, label: c.label,
      icon: 'footprint', swatch: c.color ?? 'var(--obj-plans)', visible: !categories.hiddenCats.has(c.id),
    })),
    {
      id: UNDERGROUND_ROW, group: C.layerGroupStation, label: C.layerUnderground, icon: 'footprint', visible: underOn,
      sub: !underOn || !under ? C.layerUndergroundSub
        : under.state === 'loading' ? C.layerUndergroundLoading
          : under.state === 'none' ? C.layerUndergroundNone
            : fillTemplate(C.layerUndergroundCount, { n: under.rings.length.toLocaleString(getLocaleId()) }),
    },
    ...(georefPlan && selObj ? [{
      id: GEOREF_ROW, group: C.layerGroupPlans, label: fillTemplate(C.layerPlan, { code: georefPlan.code, name: selObj.name }),
      sub: C.layerPlanSub, icon: 'doc', visible: georef.georefOn, opacity: georef.georefOpacity,
    }] : []),
  ]

  const karteDefaults = useMemo(() => viewerLayers(defaultLayers(), undefined), [])
  // every station row is on in «Standard» (Unterirdische Bauten too since round 5 — PresetRow.standard)
  const presetRows = twins.filter((t) => t.id !== GEOREF_ROW).map((t) => ({ id: t.id, visible: t.visible }))
  const layersPreset = karteLayerPreset(layers, karteDefaults, presetRows, weather.on && weather.radarOn)
  const quickTap = (tap: QuickTap) => {
    updateLayers((ls) => applyLayerPreset(ls, karteDefaults, tap))
    for (const id of presetFlips(presetRows, tap)) toggleLayer(id)
    if (tap !== 'all') weather.setRadar(false)
  }
  return { toggleLayer, setOpacity, twins, layersPreset, quickTap }
}
