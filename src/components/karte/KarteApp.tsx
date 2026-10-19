// «Karte & Objekte» — the station reference viewer outside an Einsatz (docs/karte-objekte.md).
// Its own lazy chunk (App · lazy), mounted for the `/karte` route.
//
// What it is: the station area on the Einsatz's map (MapView, its Ebenen, the vehicles, the
// weather), every station object as its building(s) outlined in red with its name tag (owner,
// review round 3: «just highlight buildings / building groups» — no key-box kind), one panel for whatever is known about the selected place, the object's plans
// in the NavRail grammar (on a phone: as rows in its slide-up sheet, KartePanel), and the reference
// tools — Punkt setzen, Messen, Gefahrgut — that need no symbol placed first.
//
// ⚠️ What it never is: an Einsatz. It holds NO workspace, writes no drawing, binds no plan and
// moves nothing in any incident. Measurements, the Gefahrgut rings and a dropped pin live in this
// component's state and die with it; the only things kept are its own Ebenen and where it was
// looking (lib/karte/session). The single way it changes anything is the Objektbesuch button,
// which hands over to the existing capture (`/besuche/neu?…&from=karte`, contract C1).
//
// Beside the map it has a second surface, «Checkliste» (owner, 19.10.2026): the station's
// checklists and device Anleitungen to READ in peace time — the Einsatz tab's word and glyph,
// because the same content lives there. This file only hosts it (`ChecklistLibrary`, which owns
// everything inside, the selection included) in the full-surface frame, and feeds it the top
// bar's search. The phone's bar is fixed: Karte · Checkliste │ Messen · Gefahrgut · Ebenen — a
// tool tapped on the Checkliste goes back to the Karte with that tool armed. The tablet's left
// rail is always there with the two surfaces; a selected object's plans hang under them.
//
// It is HOME too (owner, 16.10.2026 · variant B): with no Einsatz open an account lands here, and
// the menu button at the top left («FWO ▾», the station's short name or mark — it was «Einsätze ▾»
// until review round 5) opens the app menu — the same rows as the Einsatz menu
// (panels/AppMenuRows, owner 17.10.2026). App renders them (`einsaetze.render`, its handlers);
// this file only opens and closes the sheet, and hands in its own «Auf diesem Gerät».

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import { Marker } from 'react-map-gl/maplibre'
import { appConfig } from '../../config/appConfig'
import { getLocaleId } from '../../config/copy'
import { Icon, IconSprite } from '../../lib/icons'
import { MapPin } from '../MapPin'
import { cx } from '../../lib/cx'
import { fillTemplate } from '../../lib/format'
import { useAuth } from '../../lib/auth'
import { useIsPhone } from '../../lib/useIsPhone'
import { useOnline } from '../../lib/useOnline'
import { onReachable } from '../../lib/connectivity'
import { useNightTheme } from '../../lib/useNightTheme'
import { useViewportPan } from '../../lib/useViewportPan'
import { focusWithoutPan, noPanTouchEnd, useTypingLock } from '../../lib/iosKeyboard'
import { primeKeyboard } from '../../lib/keyboardPrime'
import { defuseAutofill, typingFieldProps } from '../../lib/typingField'
import { useSymbols } from '../../lib/useSymbols'
import { useMeasure } from '../../lib/useMeasure'
import { useVehicleLayer } from '../../lib/useVehicleLayer'
import { useWeather } from '../../lib/useWeather'
import { useKarteWeather } from '../../workspace/useKarteWeather'
import { deploymentDefaultCenter, deploymentMenuMark, deploymentName, objectCategoryRules, objectVisitsConfig } from '../../lib/deploymentConfig'
import { defaultLayers } from '../../lib/workspace'
import { fmtDistance, fmtLV95, fmtWGS, haversineM } from '../../lib/geo'
import { themeToken, uiBlue } from '../../lib/themeToken'
import { dismissToast, toast } from '../../lib/ui'
import { usePlacementLane } from '../../lib/toastLane'
import { geocodeReverse, geocodeSearch, type GeoHit } from '../../lib/api/geo'
import { getApprovedPlanAlignments, referenceUrl } from '../../lib/api/reference'
import { loadStationBuilding, loadStationObjects, type StationObject, type StationObjects } from '../../lib/api/stationReference'
import { UNDER_DASH, undergroundOverlay, useUnderground } from '../../lib/underground'
import type { IncidentMeta } from '../../lib/api/incidents'
import { listVisits } from '../../objectVisits/api'
import { ovHref, navigateTo } from '../../objectVisits/route'
import { lookupErg } from '../../lib/erg'
import { DEFAULT_ERG_RING_MODE, ergRingsFor, type ErgRingMode } from '../../lib/ergRings'
import { fitSimilarity } from '../../lib/georef'
import { withPdfPage } from '../../lib/whiteboard'
import { coordOf, nearestObjects, openableCount, searchObjects } from '../../lib/karte/search'
import {
  compass8, nearbyPlaces, objectAtAddress, objectBuildings, objectVisitHref, pinNear, placeVisitHref, REPORT_CHECKLIST,
  normAddress, pointsFromGeoJson, ringAt, splitAddress, type NamedPoint,
} from '../../lib/karte/places'
import { LABEL_MIN_ZOOM, placeTags, samePlacement, tagRank, tagSize, type Rect, type TagCandidate } from '../../lib/karte/labels'
import { cellOf, cellsFor, loadCell, OUTLINE_MIN_ZOOM, ringsAround, useHouses } from '../../lib/karte/outlines'
import { GEBAEUDE_DOC, viewerPlanDocs } from '../../lib/karte/plans'
import { moduleCatalogue } from '../../lib/planOrder'
import { karteHref } from '../../lib/karte/route'
import { applyLayerPreset, karteLayerPreset, presetFlips, type QuickTap } from '../../lib/karte/layerPresets'
import { karteRadarStore, loadKarteView, loadViewerLayerPrefs, saveKarteView, saveViewerLayerPrefs, viewerLayers, type KarteTool } from '../../lib/karte/session'
import { categorize, categoryRules, inkOn } from '../../lib/karte/categories'
import { cameraOnClose, returnOnSelect, toolTakesTaps, type Camera, type CameraReturn } from '../../lib/karte/camera'
import type { Entity, LayerDef, LayerId, LngLat, PreparedMapOverlay } from '../../types'
import { MapView } from '../MapView'
import { LayerPanel } from '../LayerPanel'
import { MeasurePanel } from '../MeasurePanel'
import { ToolDock } from '../ToolDock'
import { ToolRail } from '../ToolRail'
import { MapViewsButton, type ViewsApi } from '../MapViewsMenu'
import { WeatherBadge } from '../TopBar'
import { WeatherRadarControls } from '../weatherLazy'
import { SearchField } from '../SearchField'
import { ChecklistLibrary } from '../ChecklistLibrary'
import { KartePanel, type HydrantCue, type PanelLevel, type PanelSel, type RegisterState, type VisitsState } from './KartePanel'
import { KarteSearch, type AddrState } from './KarteSearch'
import { KarteGefahrgut } from './KarteGefahrgut'
import { KarteKeySheet } from './KarteKeySheet'
import { KarteNavRail, KarteSurface } from './KartePlans'
import { KarteDevice } from './KarteDevice'
import { useMapCoverage, useObjectAvailability } from './useKarteOffline'
import { NoBasemapMeldung } from '../NoBasemapMeldung'
import { UpdateBanner } from '../UpdateBanner'
import { consumeJustUpdated } from '../../lib/swUpdate'
import { buildLabel } from '../../lib/buildInfo'
import { planKey, tileRing, type TileXY } from '../../lib/karte/availability'
import s from './Karte.module.css'

// Karte Haus round 1 (owner, variant A): a tap on one of an object's buildings opens the object
// and remembers that building (`hit`, drawn dashed); the panel's switch then opens just that house —
// a `building` that knows it is part of the object (`of`), so the register rule «this address is
// an object's → open the object» never throws it back.
type Sel =
  | { kind: 'object'; id: string; approxAt?: LngLat | null; hit?: { at: LngLat; ring: LngLat[] } }
  | { kind: 'building'; at: LngLat; ring: LngLat[] | null; address: string | null; of?: string }
  | { kind: 'pin'; at: LngLat }
/** what the mouse is over (never touch): an object's building, a plain building, or a hydrant */
type Hover =
  | { kind: 'object'; id: string; ring: LngLat[] | null }
  | { kind: 'plain'; ring: LngLat[] }
  | { kind: 'hydrant'; id: string }
/** the same thing under the mouse as before (rings compare by identity: they come from one set) */
function sameHover(a: Hover | null, b: Hover | null): boolean {
  if (!a || !b) return a === b
  if (a.kind === 'hydrant') return b.kind === 'hydrant' && a.id === b.id
  if (a.kind === 'object') return b.kind === 'object' && a.id === b.id && a.ring === b.ring
  return b.kind === 'plain' && a.ring === b.ring
}
/** how close (px) the mouse must come to a hydrant on the map to name it */
const HYDRANT_HOVER_PX = 14
type Tool = null | 'pin' | 'measure' | 'erg' | 'layers'

/** layer ids the viewer draws under that are not in the deployment's list */
const OBJECTS_LAYER = 'karte-objekte' as LayerId
const ALWAYS_LAYER = 'karte-immer' as LayerId
/** the hatching over map area this device holds no base map for (offline only) */
const UNCACHED_LAYER = 'karte-ohne-karte' as LayerId
/** the Ebenen rows the viewer adds (LayerPanel twins) */
const OBJECTS_ROW = 'karte:objekte'
const GEOREF_ROW = 'karte:objektplan'
const COUNTRY_CENTER: LngLat = [8.2275, 46.8182]
const EMPTY_OBJECTS: StationObject[] = []
const NO_TILES: TileXY[] = []
const NOOP = () => {}
/** `surface` while the Checkliste is shown (a document id never looks like this) */
const LIBRARY = 'karte:checkliste'
/** how much of a phone's height the object sheet may cover (Ebenen's cap, 15-mobile · .layers-card):
 *  a place framed for it stands in the strip above */
const SHEET_SHARE = 0.72
/** a tag's text: a number range («1-14») never folds at its hyphen (a word joiner after it) */
const tagText = (name: string) => name.replace(/(\d)-(?=\d)/g, '$1-\u2060')
/** an Ebenen row per object category (lib/karte/categories) */
const CAT_ROW = 'karte:kategorie:'
/** «Unterirdische Bauten» (owner, review rounds 4 + 5): every underground building and tunnel of
 *  the Einsatzgebiet, from street zoom on — ON by default and part of «Standard» (round 5), the
 *  Einsatz map shows the same layer (lib/underground) */
const UNDERGROUND_ROW = 'karte:unterirdisch'
const UNDERGROUND_LAYER = 'karte-unterirdisch' as LayerId

export interface KarteAppProps {
  /** the menu button: the app menu as a sheet (App owns the rows and their handlers) and the count
   *  behind the button's red dot — running Einsätze + alarms waiting to be taken. `onDevice` opens this
   *  viewer's «Auf diesem Gerät», the menu's offline row on home. */
  einsaetze: { badge: number; render: (close: () => void, onDevice: () => void) => ReactNode }
  /** entered from an Einsatz (its menu's «Karte & Objekte» row): say where it picked up again */
  announceReturn?: boolean
  /** hand over to the Objektbesuche surface at this address */
  onOpenVisits: (href: string) => void
  /** the open Einsätze, the newest first (the red chip shows the first) */
  running: IncidentMeta[]
  onOpenIncident: (i: IncidentMeta) => void
}

export default function KarteApp({ einsaetze, announceReturn = false, onOpenVisits, running, onOpenIncident }: KarteAppProps) {
  const C = appConfig.copy.karte
  const { user } = useAuth()
  const phone = useIsPhone()
  const online = useOnline()
  const sym = useSymbols()
  const mapRef = useRef<MapRef | null>(null)
  // the surface's frame (the tag placement's chrome, the hover label's box)
  const rootRef = useRef<HTMLDivElement>(null)
  const ov = objectVisitsConfig()
  const canCapture = ov.enabled && !!user && ov.captureRoles.includes(user.role)
  const lang = getLocaleId().slice(0, 2).toLowerCase()
  // the keyboard on a phone (owner-r2-keyboard): the visible band as CSS (`--vv-pan`, `--vv-foot`,
  // `html[data-kb]`), the Einsatz's one hook — the bars stay on the screen, and a card with a field
  // stands on the keys (Karte.module.css · «the keyboard»)
  useViewportPan()
  // …and on a phone the page itself never moves while a field has the caret (review round 3: the
  // real iPhone moved it anyway — lib/iosKeyboard): any iOS pan is undone, a drag that nothing
  // under the finger can scroll is cancelled
  useTypingLock(phone)

  // ── where to start: the last view of this session, else the station ───────────────────────
  const [start] = useState(() => {
    const v = loadKarteView()
    // the deep link (?objekt=) wins over where this session last was — read NOW, before the
    // address starts following the selection
    const linked = new URLSearchParams(window.location.search).get('objekt')
    const wanted = linked ?? v?.objectId ?? null
    // the Checkliste comes back with the session — unless a deep link asks for another object
    const library = v?.surface === 'checkliste' && (!linked || linked === v.objectId)
    return { view: v, wanted, library, center: v?.center ?? deploymentDefaultCenter() ?? COUNTRY_CENTER, zoom: v?.zoom ?? (deploymentDefaultCenter() ? 15.5 : 8) }
  })
  const [view, setView] = useState<{ center: LngLat; zoom: number; bearing: number }>({ center: start.center, zoom: start.zoom, bearing: start.view?.bearing ?? 0 })

  // a frame asked for before the map exists (a deep link resolves faster than MapLibre loads)
  const pendingFly = useRef<LngLat | null>(null)
  // read by the (once-per-mount) deep-link frame, which must not re-run when the layout flips
  const phoneRef = useRef(phone)
  useEffect(() => { phoneRef.current = phone }, [phone])
  const flyPending = useCallback(() => {
    const map = mapRef.current
    if (!map || !pendingFly.current) return
    // on a phone the sheet opens over the lower part: frame the object in the strip above it
    map.jumpTo({ center: pendingFly.current, zoom: 17.6, ...(phoneRef.current ? { padding: { top: 80, bottom: window.innerHeight * SHEET_SHARE, left: 0, right: 0 } } : {}) })
    pendingFly.current = null
  }, [])

  // ── the catalogue ─────────────────────────────────────────────────────────────────────────
  const [cat, setCat] = useState<{ data: StationObjects | null; fromDevice: boolean; failed: boolean } | null>(null)
  const [sel, setSel] = useState<Sel | null>(null)
  // what is shown over the map: an open document id, LIBRARY (the Checkliste), null = the Karte
  const [surface, setSurface] = useState<string | null>(() => (start.library ? LIBRARY : null))
  const onLibrary = surface === LIBRARY
  useEffect(() => {
    let alive = true
    loadStationObjects().then((r) => {
      if (!alive) return
      setCat({ data: r.value, fromDevice: r.source !== 'network', failed: false })
      const o = start.wanted ? r.value.objects.find((x) => x.id === start.wanted) : null
      if (o) {
        setSel({ kind: 'object', id: o.id })
        // a deep link frames its object; a restored session keeps the frame it had
        const at = coordOf(o)
        if (at && start.wanted !== start.view?.objectId) { pendingFly.current = at; flyPending() }
        const surf = start.view?.objectId === o.id ? start.view.surface : 'karte'
        if (surf === 'gebaeude') setSurface(GEBAEUDE_DOC)
        else if (typeof surf === 'object') {
          const d = viewerPlanDocs(o, C.floorsRow, moduleCatalogue()).find((x) => x.plan?.id === surf.plan)
          if (d) setSurface(d.doc.id)
        }
      }
    }).catch(() => { if (alive) setCat({ data: null, fromDevice: false, failed: true }) })
    return () => { alive = false }
    // once per mount: the start view is read once
  }, [start, C.floorsRow, flyPending])
  // shown from the device because the server could not be asked: take the fresh one as soon as
  // it answers again (lib/connectivity · onReachable), without touching the selection
  const catStale = !!cat && (cat.fromDevice || cat.failed)
  useEffect(() => {
    if (!catStale) return
    const refresh = () => {
      loadStationObjects().then((r) => { if (r.source === 'network') setCat({ data: r.value, fromDevice: false, failed: false }) }).catch(() => {})
    }
    const offReach = onReachable(refresh)
    window.addEventListener('online', refresh)
    return () => { offReach(); window.removeEventListener('online', refresh) }
  }, [catStale])
  const objects = cat?.data?.objects ?? EMPTY_OBJECTS
  const byId = useMemo(() => new Map(objects.map((o) => [o.id, o])), [objects])
  // ── the station's object colours (config `map.objectCategories`, lib/karte/categories) ──────
  // An object no rule takes keeps the default look (red; grey without plans). Each category
  // is an Ebenen row of its own; a hidden one takes its objects off the map (outline, dot, tag,
  // tap) — the selected object stays, it was chosen on purpose.
  const catRules = useMemo(() => categoryRules(objectCategoryRules(), lang), [lang])
  const cats = useMemo(() => categorize(objects, catRules), [objects, catRules])
  const [hiddenCats, setHiddenCats] = useState<ReadonlySet<string>>(() => new Set())
  const catOff = useCallback((id: string) => { const c = cats.get(id); return !!c && hiddenCats.has(c.id) }, [cats, hiddenCats])
  const selObj = sel?.kind === 'object' ? byId.get(sel.id) ?? null : null
  // titled and typed by the station's module catalogue, as the Einsatz's plan chooser is
  const docs = useMemo(() => (selObj ? viewerPlanDocs(selObj, C.floorsRow, moduleCatalogue(), C.planRow) : []), [selObj, C.floorsRow, C.planRow])
  const openDoc = surface ? docs.find((d) => d.doc.id === surface) ?? null : null

  // ── offline: which of the object's plans this device holds (lib/karte/availability) ─────────
  // Re-asked every few seconds while an open sheet is not held yet and the network is up: opening
  // it online is what puts it in the cache, and the chip should say so once it is there.
  const [availNonce, setAvailNonce] = useState(0)
  const avail = useObjectAvailability(selObj, availNonce)
  const docHeld = (d: { plan: StationObject['plans'][number] | null } | null): boolean | null => {
    if (!d || !avail) return null
    // opens here at all (◐ included: a soft deep zoom, storeys partly) — lib/karte/availability · planLamp
    return (d.plan ? avail.plans[planKey(d.plan)] ?? 'online' : avail.gebaeude ?? 'online') !== 'online'
  }
  const openHeld = docHeld(openDoc)
  useEffect(() => {
    if (!openDoc || openHeld !== false || !online) return
    const t = setInterval(() => setAvailNonce((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [openDoc, openHeld, online])

  // ── the address: /karte?objekt=<id> follows the selection (deep-linkable, no history entry) ──
  const objectInUrl = selObj?.id ?? null
  const catLoaded = !!cat
  useEffect(() => {
    if (!catLoaded) return // the deep link is still being resolved
    const want = karteHref({ objekt: objectInUrl })
    if (`${window.location.pathname}${window.location.search}` !== want && window.location.pathname.startsWith('/karte')) navigateTo(want, { replace: true })
  }, [objectInUrl, catLoaded])

  // ── layers: the deployment's, minus the Einsatz-only ones, with this device's own choices ──
  const [layers, setLayers] = useState<LayerDef[]>(() => viewerLayers(defaultLayers(), loadViewerLayerPrefs()))
  const [objectsOn, setObjectsOn] = useState(true)
  // ── «Unterirdische Bauten»: on when the viewer opens (round 5), asked once, kept for the visit;
  // switched off it stays off until a reload brings the default back (lib/underground) ──────────
  const [underOn, setUnderOn] = useState(true)
  const under = useUnderground(underOn)
  const toggleUnder = () => setUnderOn((v) => !v)
  const updateLayers = (fn: (ls: LayerDef[]) => LayerDef[]) => setLayers((ls) => { const next = fn(ls); saveViewerLayerPrefs(next); return next })
  const weather = useKarteWeather(true, karteRadarStore)
  const liveWeather = useWeather(view.center)
  const { liveVehicles } = useVehicleLayer({})

  // ── offline: the base map this device holds for the view ─────────────────────────────────────
  // Hatched where there is NOTHING behind the map (neither the tile nor a parent MapLibre could
  // scale up) — asked only while offline or while «Auf diesem Gerät» is open.
  const night = useNightTheme()
  const [deviceOpen, setDeviceOpen] = useState(false)
  const base = layers.find((l) => l.base && l.visible) ?? null
  const baseTemplates = base ? (night && base.nightTiles?.length ? base.nightTiles : base.tiles ?? null) : null
  const coverage = useMapCoverage({
    enabled: !online || deviceOpen,
    mapRef,
    viewKey: `${view.center[0].toFixed(4)},${view.center[1].toFixed(4)}@${view.zoom.toFixed(1)}`,
    templates: baseTemplates,
    maxzoom: base?.maxzoom,
  })
  const uncached = useMemo(() => (!online && coverage && coverage !== 'far' ? coverage.missing : NO_TILES), [online, coverage])
  // the «Keine Basiskarte» Meldung (MapView · onBasemapUnavailable): once per visit to the viewer,
  // withdrawn the moment the link is back — the Einsatz's rule (IncidentWorkspace)
  const [noBasemap, setNoBasemap] = useState(false)
  const noBasemapSaid = useRef(false)
  const onBasemapUnavailable = useCallback(() => {
    if (noBasemapSaid.current) return
    noBasemapSaid.current = true
    setNoBasemap(true)
  }, [setNoBasemap]) // the setter named: the React Compiler infers it (lint ratchet)
  const [wasOnline, setWasOnline] = useState(online)
  if (online !== wasOnline) { setWasOnline(online); if (online) setNoBasemap(false) }

  // ── outlines (OSM, per cell) ──────────────────────────────────────────────────────────────
  const [cells, setCells] = useState<Record<string, LngLat[][]>>({})
  const loadOutlines = useCallback(() => {
    const map = mapRef.current
    if (!map || map.getZoom() < OUTLINE_MIN_ZOOM) return
    const b = map.getBounds()
    for (const key of cellsFor(b.getWest(), b.getSouth(), b.getEast(), b.getNorth())) {
      void loadCell(key).then((rings) => setCells((c) => (c[key] ? c : { ...c, [key]: rings }))).catch(() => {})
    }
  }, [])
  // a building tap / hover matches the survey's houses first, one per house, OSM where they have
  // none (lib/karte/outlines · ringsAround)
  const houses = useHouses()
  const ringsNear = useCallback((at: LngLat) => ringsAround(houses, cells[cellOf(at)], at), [houses, cells])
  /** each station object's buildings — the server's official set, else the survey house its point
   *  lies in, else the OSM outline (lib/karte/places · objectBuildings, the same `ringsNear` a tap uses) */
  const outlines = useMemo(() => {
    const m = new Map<string, { rings: LngLat[][]; main: LngLat[] | null; under: LngLat[][] }>()
    for (const o of objects) {
      const at = coordOf(o)
      if (!at) continue
      const b = objectBuildings(o, ringsNear(at))
      if (b) m.set(o.id, b)
    }
    return m
  }, [objects, ringsNear])


  // ── tools ─────────────────────────────────────────────────────────────────────────────────
  // the open tool comes back too (only WHICH one — lib/karte/session); never the pin mode
  const [tool, setToolState] = useState<Tool>(() => start.view?.tool ?? null)
  const measure = useMeasure(tool === 'measure')
  const [erg, setErg] = useState<{ un: string; mode: ErgRingMode; center: LngLat | null; at: Date }>(() => ({ un: '', mode: DEFAULT_ERG_RING_MODE, center: null, at: new Date() }))
  const [viewsOpen, setViewsOpen] = useState(false)
  // the phone's Gefahrgut opened by a TAP with no UN number yet: the number pad comes up at once
  // (owner, review round 3); with a number set it opens on the result, no keyboard. Only a tap may
  // raise it (iOS), so a Gefahrgut restored with the session never takes the caret.
  const [ergKeys, setErgKeys] = useState(false)
  const openPhoneTool = (t: 'measure' | 'erg' | 'layers') => {
    const keys = t === 'erg' && tool !== 'erg' && !erg.un
    // inside the tap: iOS raises the keyboard only for a focus made in it (lib/keyboardPrime)
    if (keys) primeKeyboard()
    setErgKeys(keys)
    setTool(t)
  }
  // the phone sheet pushed away / ✕ while its place stays selected (outline, tag, pin): a tap on
  // the place again brings it back (owner R2). Every new selection opens it.
  const [sheetShut, setSheetShut] = useState(false)
  const selPoint = (x: Sel | null): LngLat | null => {
    if (!x) return null
    if (x.kind !== 'object') return x.at
    const o = byId.get(x.id)
    return (o && coordOf(o)) ?? x.approxAt ?? null
  }
  const setTool = (t: Tool) => {
    setToolState((cur) => {
      const next = cur === t ? null : t
      if (cur === 'measure' && next !== 'measure') measure.reset()
      return next
    })
    setViewsOpen(false)
    if (t === 'erg' && !erg.center) setErg((e) => ({ ...e, center: selPoint(sel) ?? view.center, at: new Date() }))
    if (phone && t && t !== 'pin') { setSurface(null); setSearchOpen(false) }
  }

  // …and the view is kept for the way back (an Objektbesuch, an Einsatz, a reload) — with the
  // words the Einsatz menu's row says it returns to («Zurück zu Schloss Musterdorf · Modul 1»)
  const keptTool: KarteTool | null = tool === 'measure' || tool === 'erg' || tool === 'layers' ? tool : null
  const viewLabel = onLibrary ? appConfig.copy.modes.checklists
    : selObj
    ? [selObj.name, openDoc && (openDoc.plan ? fillTemplate(C.backPlan, { code: openDoc.doc.code }) : openDoc.doc.title)].filter(Boolean).join(' · ')
    : null
  // ⚠️ Not before the catalogue has answered (or failed): until then nothing is selected yet, and
  // leaving that early would overwrite the object the session was on with «nothing».
  useEffect(() => {
    if (!catLoaded) return
    const surf = onLibrary ? 'checkliste' as const : !openDoc ? 'karte' as const : openDoc.plan ? { plan: openDoc.plan.id } : 'gebaeude' as const
    saveKarteView({ ...view, objectId: objectInUrl, surface: surf, tool: keptTool, label: viewLabel })
  }, [catLoaded, view, objectInUrl, openDoc, onLibrary, keptTool, viewLabel])
  // back from an Einsatz: one line that says where it picked up (mockup j8-5), once per entry
  const announced = useRef(false)
  useEffect(() => {
    // once per mount (a ref, so StrictMode's second run says nothing): the entry is what is announced
    if (announced.current) return
    announced.current = true
    if (announceReturn && start.view?.label) toast(fillTemplate(C.backAt, { where: start.view.label }), { icon: 'check' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // …and the one-shot «Aktualisiert – v…» after an update reload, the Einsatz's toast
  // (IncidentWorkspace): the Karte is home now, so an update that lands with no Einsatz open
  // reloads into HERE (review round 7). consumeJustUpdated is one-shot app-wide, so a covered
  // Einsatz behind the Karte can never say it a second time.
  useEffect(() => {
    if (consumeJustUpdated()) toast(fillTemplate(appConfig.copy.update.updated, { v: buildLabel() }), { icon: 'check', tone: 'success' })
  }, [])

  // ── the menu button («FWO ▾», review round 5 — it was «Einsätze ▾»): the app menu as a sheet ──
  const [sheetOpen, setSheetOpen] = useState(false)
  // the station's mark and/or short name (lib/deploymentConfig · deploymentMenuMark); a mark that
  // does not load (offline before it was ever fetched) steps back to the symbol, never a broken image
  const brand = deploymentMenuMark()
  const [markFailed, setMarkFailed] = useState(false)
  const mark = markFailed ? null : brand.mark
  const menuName = fillTemplate(C.menuLabel, { name: deploymentName() })
  const barRef = useRef<HTMLDivElement>(null)
  const closeSheet = useCallback(() => setSheetOpen(false), [setSheetOpen])
  const openDevice = () => { setSheetOpen(false); setDeviceOpen(true) }
  useEffect(() => {
    if (!sheetOpen) return
    // 'pointerdown' (touch fires the compat mousedown late or never) — the IncidentSwitcher's
    // rule: a press inside a sheet or dialog opened FROM here is not «outside»
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Element
      if (barRef.current && !barRef.current.contains(t) && !t.closest?.('.ip-sheet, .ui-backdrop, .help-scrim, .confirm-backdrop, .toaster')) setSheetOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheetOpen(false) }
    document.addEventListener('pointerdown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [sheetOpen])

  // ── search ────────────────────────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  // the Checkliste's search: the same field in the bar, its own words (the map's stay for the way back)
  const [libQuery, setLibQuery] = useState('')
  /** to the Checkliste: the map's tools and lists close (the Karte tab's rule), the selection stays */
  const openLibrary = () => {
    setSurface(LIBRARY); setToolState(null); setSearchOpen(false); setViewsOpen(false)
  }
  // the phone: the bar has a search button («Einsätze ▾»'s twin since round 4), the field lives in a slide-up (review round 3,
  // owner: «Einsätze ▾ + a search button», the sheet «like Ebenen», the keyboard right away)
  const sheetFieldRef = useRef<HTMLInputElement>(null)
  const openPhoneSearch = () => {
    // inside the tap: iOS raises the keyboard only for a focus made in it (lib/keyboardPrime)
    primeKeyboard()
    setSearchOpen(true)
    setSheetOpen(false)
    // one sheet at a time at the foot: Ebenen / Gefahrgut give way (the measure stays armed)
    setToolState((t) => (t === 'layers' || t === 'erg' ? null : t))
  }
  useLayoutEffect(() => {
    if (phone && searchOpen) focusWithoutPan(sheetFieldRef.current)
  }, [phone, searchOpen])
  const [addr, setAddr] = useState<{ q: string; state: 'ok' | 'error'; list: GeoHit[] }>({ q: '', state: 'ok', list: [] })
  const q = query.trim()
  useEffect(() => {
    if (!online || q.length < 3) return
    let alive = true
    const t = setTimeout(() => {
      geocodeSearch(q, 6).then((list) => { if (alive) setAddr({ q, state: 'ok', list }) })
        .catch(() => { if (alive) setAddr({ q, state: 'error', list: [] }) })
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [q, online])
  const addrState: AddrState = !q ? 'idle' : !online ? 'offline' : q.length < 3 ? 'short' : addr.q !== q ? 'loading' : addr.state
  const hits = useMemo(() => searchObjects(objects, query, view.center), [objects, query, view.center])
  const nearest = useMemo(() => nearestObjects(objects, view.center), [objects, view.center])

  // ── selecting ─────────────────────────────────────────────────────────────────────────────
  // Closing gives the camera back (owner, review round 4 — lib/karte/camera): the camera before the
  // selection is kept here, the first selection's while one stays open, and dropped the moment the
  // user moves the map themselves (the `movestart` below, fired with an originalEvent).
  const camBack = useRef<CameraReturn | null>(null)
  const cameraNow = (): Camera | null => {
    const map = mapRef.current
    if (!map || typeof map.getPadding !== 'function') return null
    const c = map.getCenter()
    const p = map.getPadding()
    return { center: [c.lng, c.lat], zoom: map.getZoom(), padding: { top: p.top ?? 0, bottom: p.bottom ?? 0, left: p.left ?? 0, right: p.right ?? 0 } }
  }
  const noteSelect = (how: 'tap' | 'search' = 'tap') => {
    const now = cameraNow()
    if (now) camBack.current = returnOnSelect(camBack.current, now, how)
  }
  const giveCameraBack = () => {
    const r = camBack.current
    camBack.current = null
    const now = cameraNow()
    const to = now && cameraOnClose(r, now)
    if (to) mapRef.current?.easeTo({ center: to.center, zoom: to.zoom, padding: to.padding, duration: 350 })
  }
  const watchingMoves = useRef(false)
  const watchUserMoves = useCallback(() => {
    const map = mapRef.current?.getMap?.()
    if (!map || watchingMoves.current) return
    watchingMoves.current = true
    map.on('movestart', (e) => { if ((e as { originalEvent?: unknown }).originalEvent) camBack.current = null })
  }, [])
  // on a phone the sheet is Ebenen's (up to ~72 % of the height): the place goes in the strip above
  const panelPad = () => (phone ? { top: 80, bottom: window.innerHeight * SHEET_SHARE, left: 0, right: 0 } : { top: 80, bottom: 0, left: 440, right: 0 })
  const flyTo = (at: LngLat, zoom = 17.6) => mapRef.current?.easeTo({ center: at, zoom: Math.max(view.zoom, zoom), padding: panelPad(), duration: 700 })
  /** keep the tapped place visible beside / above the panel, without changing the zoom */
  const reveal = (at: LngLat) => {
    const map = mapRef.current
    if (!map) return
    const p = map.project(at)
    const hidden = phone ? p.y > window.innerHeight * (1 - SHEET_SHARE) - 16 || p.y < 90 : p.x < 440
    if (hidden) map.easeTo({ center: at, padding: panelPad(), duration: 500 })
  }
  const selectObject = (id: string, fly = true, how: 'tap' | 'search' = 'tap', hit?: { at: LngLat; ring: LngLat[] }) => {
    const o = byId.get(id)
    if (!o) return
    noteSelect(how)
    setSel(hit ? { kind: 'object', id, hit } : { kind: 'object', id })
    setSurface(null); setSearchOpen(false); setSheetShut(false)
    if (tool !== 'measure' && tool !== 'erg') setToolState(null)
    const at = coordOf(o)
    // a tapped object is revealed beside / above the panel like a tapped building – the house that
    // was tapped, not the object's point (its label, maybe a block away: owner, Karte Haus round 2)
    if (at) { if (fly) flyTo(at); else reveal(hit?.at ?? at) } else if (o.address && online) {
      // no coordinates in the catalogue: the address says roughly where — marked «ungefähr»
      geocodeSearch(o.address, 1).then(([hit]) => {
        if (!hit) return
        const approx: LngLat = [hit.lng, hit.lat]
        setSel((cur) => (cur?.kind === 'object' && cur.id === id ? { ...cur, approxAt: approx } : cur))
        flyTo(approx, 17)
      }).catch(() => {})
    }
  }
  const selectBuilding = (at: LngLat, ring: LngLat[] | null, address: string | null = null, of?: string) => {
    noteSelect()
    setSel(of ? { kind: 'building', at, ring, address, of } : { kind: 'building', at, ring, address })
    setSurface(null); setSearchOpen(false); setSheetShut(false)
    if (tool !== 'measure' && tool !== 'erg') setToolState(null)
    reveal(at)
  }
  const dropPin = (at: LngLat) => {
    noteSelect()
    setSel({ kind: 'pin', at })
    setSurface(null); setSearchOpen(false); setSheetShut(false); setToolState(null)
    reveal(at)
  }
  const deselect = () => { setSel(null); setSurface(null); setSheetShut(false) }
  /** the switch «Objekt | <Haus>»: one tap to the other level, both ways, the camera left alone */
  const toLevel = (to: 'object' | 'house') => {
    if (to === 'house' && sel?.kind === 'object' && sel.hit) setSel({ kind: 'building', at: sel.hit.at, ring: sel.hit.ring, address: null, of: sel.id })
    else if (to === 'object' && sel?.kind === 'building' && sel.of && sel.ring) setSel({ kind: 'object', id: sel.of, hit: { at: sel.at, ring: sel.ring } })
  }
  // ✕ / pushed down: on the tablet the panel IS the selection; on a phone the sheet only covers
  // the map, so it goes and the place stays selected for a second look
  const closePanel = () => { giveCameraBack(); if (phone) setSheetShut(true); else deselect() }

  const pickAddress = (hit: GeoHit) => {
    setSearchOpen(false); setQuery(splitAddress(hit.label)[0])
    const at: LngLat = [hit.lng, hit.lat]
    const o = objectAtAddress(objects, hit.label)
    if (o) { selectObject(o.id, true, 'search'); return }
    noteSelect('search')
    flyTo(at, 18)
    selectBuilding(at, ringAt(ringsNear(at), at), normAddress(hit.label))
  }

  // ── what the panel shows: register, nearby, visits, the pin's address ─────────────────────
  const point = selPoint(sel)
  const regKey = sel && sel.kind !== 'pin' && point ? `${point[0].toFixed(6)},${point[1].toFixed(6)}|${sel.kind === 'object' ? selObj?.address ?? '' : sel.address ?? ''}` : null
  const [reg, setReg] = useState<{ key: string; state: RegisterState } | null>(null)
  const [regTry, setRegTry] = useState(0)
  useEffect(() => {
    if (!regKey || !point || !sel || sel.kind === 'pin') return
    let alive = true
    const address = sel.kind === 'object' ? selObj?.address ?? null : sel.address
    void loadStationBuilding(point[1], point[0], address, lang).then((r) => {
      if (!alive) return
      setReg({ key: regKey, state: r ? { state: 'ok', info: r.value, cached: r.source !== 'network' } : { state: navigator.onLine ? 'error' : 'offline', info: null, cached: false } })
      // a building whose register address IS a catalogue object's opens that object instead —
      // never a house reached as one of an object's buildings (`of`: its level was chosen)
      if (r && sel.kind === 'building' && !sel.of) {
        const o = objectAtAddress(objects, r.value.address) ?? (r.value.object ? byId.get(r.value.object.id) : null)
        if (o) setSel((cur) => (cur === sel ? { kind: 'object', id: o.id } : cur))
      }
    })
    return () => { alive = false }
    // regKey is the identity of what is asked; `sel` itself is read for the switch above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regKey, regTry, lang])
  const register: RegisterState = reg && reg.key === regKey ? reg.state : { state: 'loading', info: null, cached: false }
  // the switch names the tapped house by its register address, asked at the tapped point as a
  // building tap asks (the same cached answer the house level then shows)
  const hitAt = sel?.kind === 'object' ? sel.hit?.at ?? null : null
  const hitKey = hitAt ? `${hitAt[0].toFixed(6)},${hitAt[1].toFixed(6)}` : null
  const [hitAddr, setHitAddr] = useState<{ key: string; street: string | null } | null>(null)
  useEffect(() => {
    if (!hitKey || !hitAt) return
    let alive = true
    void loadStationBuilding(hitAt[1], hitAt[0], null, lang).then((r) => { if (alive) setHitAddr({ key: hitKey, street: splitAddress(r?.value.address)[0] || null }) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hitKey is the point
  }, [hitKey, lang])

  const [pinAddr, setPinAddr] = useState<{ key: string; hit: GeoHit | null; failed: boolean } | null>(null)
  const pinKey = sel?.kind === 'pin' ? `${sel.at[0].toFixed(6)},${sel.at[1].toFixed(6)}` : null
  useEffect(() => {
    if (!pinKey || sel?.kind !== 'pin' || !online) return
    let alive = true
    geocodeReverse(sel.at[1], sel.at[0]).then((hit) => { if (alive) setPinAddr({ key: pinKey, hit, failed: false }) })
      .catch(() => { if (alive) setPinAddr({ key: pinKey, hit: null, failed: true }) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pinKey is the pin
  }, [pinKey, online])
  const pinHit = pinAddr && pinAddr.key === pinKey ? pinAddr : null
  const pinNearHit = sel?.kind === 'pin' && pinHit ? pinNear(pinHit.hit, sel.at) : null

  const [visits, setVisits] = useState<{ id: string; state: VisitsState } | null>(null)
  const visitObjectId = selObj && ov.enabled ? selObj.id : null
  useEffect(() => {
    if (!visitObjectId) return
    let alive = true
    listVisits({ object: visitObjectId, limit: 10 })
      .then((list) => { if (alive) setVisits({ id: visitObjectId, state: { state: 'ok', list: list.filter((v) => v.lifecycle !== 'discarded') } }) })
      .catch(() => { if (alive) setVisits({ id: visitObjectId, state: { state: 'error', list: [] } }) })
    return () => { alive = false }
  }, [visitObjectId])
  const visitsState: VisitsState = !ov.enabled ? { state: 'off', list: [] }
    : visits && visits.id === visitObjectId ? visits.state : { state: 'loading', list: [] }

  // hydrants for «In der Nähe»: the deployment's hydrant layer, fetched once when first needed
  const hydrantLayer = useMemo(() => layers.find((l) => l.geojson && l.vectorKind === 'point' && /hydrant/i.test(`${l.id} ${l.label} ${l.symbol ?? ''}`)), [layers])
  const [hydrants, setHydrants] = useState<NamedPoint[]>([])
  // …and for the mouse over the map's hydrants while their layer is on (a label names the one under it)
  const wantHydrants = !!hydrantLayer?.geojson && (!!sel || hydrantLayer.visible)
  useEffect(() => {
    if (!wantHydrants || !hydrantLayer?.geojson || hydrants.length) return
    let alive = true
    fetch(hydrantLayer.geojson, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((fc) => { if (alive) setHydrants(pointsFromGeoJson(fc, 'h')) })
      .catch(() => {})
    return () => { alive = false }
  }, [wantHydrants, hydrantLayer, hydrants.length])
  // ONE list by distance, objects and hydrants (lib/karte/places · nearbyPlaces); a house never
  // lists its own object
  const exceptId = selObj?.id ?? (sel?.kind === 'building' ? sel.of ?? null : null)
  // measured from the house that was tapped when there is one (owner, Karte Haus round 1: a row of 21
  // houses is not stood at its catalogue point), else from the selection's point
  const nearAt = hitAt ?? point
  const [px, py] = nearAt ?? [null, null]
  const nearby = useMemo(() => (px != null && py != null ? nearbyPlaces(objects, hydrants, [px, py], { exceptId }) : []), [objects, hydrants, px, py, exceptId])

  // ── a hydrant of In der Nähe on the map (owner, Karte Haus round 1) ───────────────────────────
  // The mouse over its row shows it while it stays there; a tap (touch) shows it until tapped
  // again. Either way it belongs to the selection it was shown for — a new one clears it. A tap
  // also switches the Hydranten Ebene on, kept like a toggle in Ebenen (owner, Karte Haus round 2);
  // the mouse passing over a row never changes the layers.
  const [hydShown, setHydShown] = useState<{ sel: Sel; id: string; pinned: boolean } | null>(null)
  const shownHyd = hydShown && hydShown.sel === sel ? hydShown : null
  const onHydrant = (id: string, cue: HydrantCue) => {
    if (!sel) return
    if (cue === 'tap') {
      setHydShown(shownHyd?.id === id && shownHyd.pinned ? null : { sel, id, pinned: true })
      const layerId = hydrantLayer && !hydrantLayer.visible ? hydrantLayer.id : null
      if (layerId) updateLayers((ls) => ls.map((l) => (l.id === layerId ? { ...l, visible: true } : l)))
    }
    else if (cue === 'enter') { if (!shownHyd?.pinned) setHydShown({ sel, id, pinned: false }) }
    else if (shownHyd?.id === id && !shownHyd.pinned) setHydShown(null)
  }
  const hydPoint = shownHyd ? hydrants.find((h) => h.id === shownHyd.id) ?? null : null

  // ── the aligned plan on the map (view only, opacity in Ebenen) ────────────────────────────
  const georefPlan = selObj?.plans.find((p) => p.georef) ?? null
  const [georefOn, setGeorefOn] = useState(false)
  const [georefOpacity, setGeorefOpacity] = useState(55)
  const [raster, setRaster] = useState<{ key: string; url: string; corners: [[number, number], [number, number], [number, number], [number, number]] } | null>(null)
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
      const url = await import('../PdfViewport').then((m) => m.planPreviewUrl((meta.page_count ?? 1) > 1 ? withPdfPage(base, a.page) : base, window.innerWidth, window.innerHeight))
      const corners = ([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] as const).map((pt) => { const c = fit.toMap(pt); return [c.lng, c.lat] as [number, number] })
      if (alive) setRaster({ key: rasterKey, url, corners: corners as [[number, number], [number, number], [number, number], [number, number]] })
    })().catch(() => { if (alive) { setGeorefOn(false); toast(C.georefFailed, { icon: 'warn', tone: 'warn' }) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rasterKey is the plan revision
  }, [rasterKey])
  const georefRasters = raster && raster.key === rasterKey ? [{ id: `karte-georef-${raster.key}`, url: raster.url, opacity: georefOpacity / 100, coordinates: raster.corners }] : []
  const toggleGeoref = () => {
    const next = !georefOn
    setGeorefOn(next)
    const at = selObj && coordOf(selObj)
    if (next && at) mapRef.current?.easeTo({ center: at, zoom: Math.max(view.zoom, 18), padding: panelPad(), duration: 600 })
  }

  // ── the map's content ─────────────────────────────────────────────────────────────────────
  const red = themeToken('--red', appConfig.ergRings.isolationColor)
  const hatchInk = themeToken('--ink-faint', '#6c7686')
  // the underground buildings: dashed like an object's own garage, but in the neutral ink (never an
  // object's red or a category colour) and only an outline. ONE overlay object for as long as the
  // set and the theme stay, so MapLayers never re-sends ~15 000 rings on a re-render.
  const underInk = themeToken('--ink-dim', '#4d586a')
  const underRings = under?.rings
  const underOverlay = useMemo<PreparedMapOverlay | null>(() => (underRings?.length
    ? undergroundOverlay(underRings, underInk, UNDERGROUND_LAYER, 'karte-underground')
    : null), [underRings, underInk])
  const overlays = useMemo<PreparedMapOverlay[]>(() => {
    const out: PreparedMapOverlay[] = []
    // one overlay per colour: the default red first, then each category in the config's order
    const byColor = new Map<string, { id: string; rings: LngLat[][]; under: LngLat[][] }>()
    for (const [id, b] of outlines) {
      if (id === selObj?.id || catOff(id)) continue
      const c = cats.get(id)
      const key = c?.color ?? red
      const slot = byColor.get(key) ?? { id: c ? `karte-objects-${c.id}` : 'karte-objects', rings: [], under: [] }
      slot.rings.push(...b.rings)
      slot.under.push(...b.under)
      byColor.set(key, slot)
    }
    // underground garages / shelters (a named row's, review round 3): dashed, barely filled —
    // under the buildings, so a house drawn over its garage keeps its solid line
    for (const [color, slot] of byColor) if (slot.under.length) out.push({ id: `${slot.id}-under`, kind: 'polygons', layer: OBJECTS_LAYER, rings: slot.under, color, fillOpacity: 0.05, lineWidth: 1.6, lineOpacity: 0.85, lineDasharray: UNDER_DASH })
    for (const [color, slot] of byColor) out.push({ id: slot.id, kind: 'polygons', layer: OBJECTS_LAYER, rings: slot.rings, color, fillOpacity: 0.14, lineWidth: 1.6, lineOpacity: 0.85 })
    // the selected object: EVERY one of its buildings in the strong style, in its own colour
    const mine = selObj ? outlines.get(selObj.id) : null
    const mineColor = (selObj && cats.get(selObj.id)?.color) ?? red
    if (mine?.under.length) out.push({ id: 'karte-object-sel-under', kind: 'polygons', layer: ALWAYS_LAYER, rings: mine.under, color: mineColor, fillOpacity: 0.1, lineWidth: 2.5, lineOpacity: 1, lineDasharray: UNDER_DASH })
    if (mine) out.push({ id: 'karte-object-sel', kind: 'polygons', layer: ALWAYS_LAYER, rings: mine.rings, color: mineColor, fillOpacity: 0.3, lineWidth: 3, lineOpacity: 1 })
    // …and the one building the tap hit, dashed in blue: what the switch's house level opens
    if (sel?.kind === 'object' && sel.hit) out.push({ id: 'karte-object-hit', kind: 'polygons', layer: ALWAYS_LAYER, rings: [sel.hit.ring], color: uiBlue(), fillOpacity: 0, lineWidth: 2.5, lineOpacity: 1, lineDasharray: [2, 1.4] })
    // the building's outline — found again once its cell has loaded (a searched address flies first)
    const bRing = sel?.kind === 'building' ? sel.ring ?? ringAt(ringsNear(sel.at), sel.at) : null
    if (bRing) out.push({ id: 'karte-building', kind: 'polygons', layer: ALWAYS_LAYER, rings: [bRing], color: uiBlue(), fillOpacity: 0.16, lineWidth: 2.5, lineOpacity: 1 })
    // the Einsatzgebiet's underground structures: under every object (an object's own dashed garage keeps
    // its colour on top), only while the row is on
    if (underOn && underOverlay) out.unshift(underOverlay)
    // offline: hatch the tiles with no base map behind them; under every other overlay (first in)
    if (uncached.length) out.unshift({ id: 'karte-uncached', kind: 'polygons', layer: UNCACHED_LAYER, rings: uncached.map(tileRing), color: hatchInk, hatch: true, fillOpacity: 0.55, lineWidth: 0, lineOpacity: 0 })
    if (tool === 'erg' && erg.un && erg.center) {
      const row = lookupErg(erg.un)?.tih?.[0]
      for (const ring of ergRingsFor(row, erg.mode, erg.at, erg.center)) {
        const iso = ring.kind === 'isolation'
        out.push({
          id: `karte-erg-${ring.kind}`, kind: 'circle', layer: ALWAYS_LAYER, center: erg.center, radiusM: ring.radiusM,
          color: iso ? appConfig.ergRings.isolationColor : appConfig.ergRings.protectColor,
          fillOpacity: iso ? appConfig.ergRings.isolationFillOpacity : 0, lineWidth: appConfig.drawing.circleLineWidth, lineDasharray: iso ? undefined : [2, 2],
        })
      }
    }
    return out
  }, [outlines, selObj, sel, tool, erg, red, ringsNear, uncached, hatchInk, cats, catOff, underOn, underOverlay])
  const tagZoom = view.zoom >= LABEL_MIN_ZOOM
  // Messen / Punkt setzen / Gefahrgut's centre take every tap, on an object too (owner, review
  // round 4 — lib/karte/camera · toolTakesTaps): its dot and tag let the finger through to the map
  const takesTaps = toolTakesTaps(tool, erg.mode)
  const entities = liveVehicles
  const isVisible = useCallback((id: LayerId) => {
    if (id === OBJECTS_LAYER) return objectsOn
    if (id === UNDERGROUND_LAYER) return underOn
    if (id === ALWAYS_LAYER || id === UNCACHED_LAYER) return true
    return layers.find((l) => l.id === id)?.visible ?? true
  }, [layers, objectsOn, underOn])

  // ── taps ──────────────────────────────────────────────────────────────────────────────────
  // ⚠️ No long press drops a pin (owner, review round 3, 17.10.2026: «I can't delete nodes when
  // measuring because it wants to create a point»). Holding a measure node is how Messen removes it
  // (MapView · vertexPress), and a hold anywhere on the map dropped a pin under the finger and left
  // Messen. A pin is set with the ⊙ tool and a tap — the one way, on the phone and the tablet.
  /** The station object whose building is under `c`, and that building's ring (null when only an
   *  underground structure of it is). A building two objects claim (a row of houses named by its
   *  addresses, and a house of the row that is an object of its own) is the one whose point stands in it. */
  const objectAt = (c: LngLat): { id: string; ring: LngLat[] | null } | null => {
    let hit: { id: string; ring: LngLat[] | null } | null = null
    for (const [id, b] of outlines) {
      if (catOff(id)) continue
      const ring = ringAt(b.rings, c)
      if (!ring && !ringAt(b.under, c)) continue
      if (b.main && ringAt([b.main], c)) return { id, ring }
      hit ??= { id, ring }
    }
    return hit
  }
  const onMapClick = (c: LngLat) => {
    if (tool === 'measure') { measure.setPath((pts) => [...pts, c]); return }
    if (tool === 'pin') { dropPin(c); return }
    if (tool === 'erg' && erg.mode !== 'off') { setErg((e) => ({ ...e, center: c, at: new Date() })); return }
    // the phone's search sheet stays until a pick or its ✕ (owner, review round 3): a tap on the
    // map only lets the keyboard go; the tablet's list hung from the bar closes as before
    if (searchOpen && phone) {
      const a = document.activeElement
      if (a instanceof HTMLElement && sheetFieldRef.current === a) { a.blur(); return }
    } else if (searchOpen) { setSearchOpen(false); return }
    // any of an object's buildings opens the object (`objectAt`), and remembers the building when
    // the object has several — the switch's house (variant A). On house level the level sticks
    // while the taps stay on the same object; another object opens at object level.
    const hit = objectsOn ? objectAt(c) : null
    if (hit) {
      const house = hit.ring && (outlines.get(hit.id)?.rings.length ?? 0) > 1 ? { at: c, ring: hit.ring } : undefined
      if (house && sel?.kind === 'building' && sel.of === hit.id) selectBuilding(c, house.ring, null, hit.id)
      else selectObject(hit.id, false, 'tap', house)
      return
    }
    const ring = ringAt(ringsNear(c), c)
    if (ring) { selectBuilding(c, ring); return }
    if (sel) { giveCameraBack(); deselect() }
  }
  const onEntity = (e: Entity) => {
    if (tool === 'measure') measure.setPath((pts) => [...pts, e.coord])
  }

  // ── hover: the mouse and the trackpad only (owner, Karte Haus round 1) ─────────────────────────
  // Touch never shows a hover state: only `pointerType === 'mouse'` moves are read (a finger's
  // tap also sends compat mouse events, which never reach here). The pointer cursor stands over
  // whatever a click opens — an object's building, a plain building (a tag has its own) — and
  // the normal one elsewhere and while a tool takes the taps. Over an object's building ALL its
  // buildings brighten, the one under the cursor gets a white line and a label beside the cursor
  // names the object; a plain building gets a thin blue line. Over a hydrant (its layer on): the
  // label says how far and which way it lies from the selected place, its In der Nähe row lights
  // up — and it stays not clickable. The target is state (it changes rarely); the label follows
  // the pointer by its style, so a mouse move re-renders nothing.
  const [hover, setHover] = useState<Hover | null>(null)
  const hoverNow = useRef<Hover | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const placeTip = useCallback(() => {
    const el = tipRef.current, p = pointer.current, root = rootRef.current
    if (!el || !p || !root) return
    const r = root.getBoundingClientRect()
    const x = p.x - r.left, y = p.y - r.top
    const left = x + 16 + el.offsetWidth > r.width - 8 ? x - el.offsetWidth - 12 : x + 16
    const top = y + 18 + el.offsetHeight > r.height - 8 ? y - el.offsetHeight - 12 : y + 18
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  }, [])
  const hydrantUnder = (map: MapRef, at: { x: number; y: number }, c: LngLat) => {
    if (!hydrantLayer?.visible || !hydrants.length) return null
    // only the hydrants within the hover reach (degrees, with room for a turned map) are projected
    const edge = map.unproject([at.x + HYDRANT_HOVER_PX, at.y + HYDRANT_HOVER_PX])
    const reach = Math.max(Math.abs(edge.lng - c[0]), Math.abs(edge.lat - c[1])) * 1.5
    let best: string | null = null
    let bestPx: number = HYDRANT_HOVER_PX
    for (const h of hydrants) {
      if (Math.abs(h.coord[0] - c[0]) > reach || Math.abs(h.coord[1] - c[1]) > reach) continue
      const q = map.project(h.coord)
      const d = Math.hypot(q.x - at.x, q.y - at.y)
      if (d < bestPx) { bestPx = d; best = h.id }
    }
    return best
  }
  const onHoverMove = (e: PointerEvent | null) => {
    const map = mapRef.current
    const canvas = map && typeof map.getCanvas === 'function' ? map.getCanvas() : null
    let next: Hover | null = null
    pointer.current = e ? { x: e.clientX, y: e.clientY } : null
    // over the canvas itself, no button held (a pan), no tool taking the taps
    if (map && canvas && e && e.target === canvas && !e.buttons && !takesTaps) {
      const r = canvas.getBoundingClientRect()
      const at = { x: e.clientX - r.left, y: e.clientY - r.top }
      const ll = map.unproject([at.x, at.y])
      const c: LngLat = [ll.lng, ll.lat]
      const hy = hydrantUnder(map, at, c)
      const obj = !hy && objectsOn ? objectAt(c) : null
      const ring = !hy && !obj ? ringAt(ringsNear(c), c) : null
      next = hy ? { kind: 'hydrant', id: hy } : obj ? { kind: 'object', id: obj.id, ring: obj.ring } : ring ? { kind: 'plain', ring } : null
    }
    if (canvas) canvas.style.cursor = next && next.kind !== 'hydrant' ? 'pointer' : 'default'
    if (!sameHover(hoverNow.current, next)) { hoverNow.current = next; setHover(next) }
    placeTip()
  }
  // the listener is added once (with the map) and calls the handler of the latest render
  const hoverMove = useRef(onHoverMove)
  useEffect(() => { hoverMove.current = onHoverMove })
  const watchingHover = useRef(false)
  const watchHover = useCallback(() => {
    const map = mapRef.current?.getMap?.()
    if (!map || typeof map.getCanvasContainer !== 'function' || watchingHover.current) return
    watchingHover.current = true
    const box = map.getCanvasContainer()
    let frame = 0
    let last: PointerEvent | null = null
    box.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return
      last = e
      frame ||= requestAnimationFrame(() => { frame = 0; hoverMove.current(last) })
    })
    box.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hoverMove.current(null) })
  }, [])
  // a tool armed under a still mouse: the hover goes at once, not on the next move
  const shownHover = takesTaps ? null : hover
  useLayoutEffect(() => { placeTip() }, [shownHover, placeTip])
  const litHydrant = shownHover?.kind === 'hydrant' ? shownHover.id : shownHyd?.id ?? null
  /** the selected place as the hydrant label says it («… von Storchenweg 4») */
  const placeName = (hitAt && hitAddr?.key === hitKey ? hitAddr.street : null) ?? selObj?.name
    ?? (sel?.kind === 'building' ? splitAddress(register.info?.address ?? sel.address)[0] || C.building : sel?.kind === 'pin' ? C.pin : null)
  let tip: ReactNode = null
  if (shownHover?.kind === 'object') {
    const o = byId.get(shownHover.id)
    if (o) tip = <><span className={s.eyebrow}>{C.kind[o.kind]}</span><b>{o.name}</b></>
  } else if (shownHover?.kind === 'hydrant') {
    const h = hydrants.find((x) => x.id === shownHover.id)
    tip = h && nearAt && placeName
      ? <><span className={s.eyebrow}>{C.nearHydrant}</span><b>{fillTemplate(C.hydrantFrom, { m: fmtDistance(haversineM(nearAt, h.coord)), dir: C.compass[compass8(nearAt, h.coord)], place: placeName })}</b></>
      : <b>{C.nearHydrant}</b>
  }
  // what the mouse is over and the hydrant shown, over the selection: their own overlays, so a
  // hover never rebuilds (and re-sends) the station's outlines
  const blue = uiBlue()
  const hoverOverlays = useMemo<PreparedMapOverlay[]>(() => {
    const out: PreparedMapOverlay[] = []
    if (shownHover?.kind === 'object') {
      const b = outlines.get(shownHover.id)
      if (b) out.push({ id: 'karte-hover-object', kind: 'polygons', layer: ALWAYS_LAYER, rings: b.rings, color: cats.get(shownHover.id)?.color ?? red, fillOpacity: 0.16, lineWidth: 2.6, lineOpacity: 1 })
      if (shownHover.ring) out.push({ id: 'karte-hover-house', kind: 'polygons', layer: ALWAYS_LAYER, rings: [shownHover.ring], color: '#ffffff', fillOpacity: 0, lineWidth: 2.5, lineOpacity: 1 })
    } else if (shownHover?.kind === 'plain') {
      out.push({ id: 'karte-hover-plain', kind: 'polygons', layer: ALWAYS_LAYER, rings: [shownHover.ring], color: blue, fillOpacity: 0, lineWidth: 2, lineOpacity: 1 })
    }
    if (hydPoint && px != null && py != null) out.push({ id: 'karte-hydrant-line', kind: 'line', layer: ALWAYS_LAYER, coords: [[px, py], hydPoint.coord], color: blue, width: 3, dasharray: [2, 1.5] })
    return out
  }, [shownHover, outlines, cats, red, blue, hydPoint, px, py])
  const mapOverlays = useMemo(() => (hoverOverlays.length ? [...overlays, ...hoverOverlays] : overlays), [overlays, hoverOverlays])

  // the hydrant shown off-screen or under the panel: the map moves so both ends are in view
  const hydId = shownHyd?.id ?? null
  useEffect(() => {
    const map = mapRef.current
    const root = rootRef.current
    if (!hydId || !hydPoint || px == null || py == null || !map || !root || typeof map.project !== 'function') return
    const box = map.getContainer().getBoundingClientRect()
    const panel = root.querySelector('[data-karte-panel]')?.getBoundingClientRect()
    // the free part of the map: under the bar, beside the tablet's panel / above the phone's sheet
    const free = { left: 0, top: 80, right: box.width - (phone ? 0 : 88), bottom: box.height }
    if (panel && phone) free.bottom = panel.top - box.top
    else if (panel) free.left = panel.right - box.left
    const q = map.project(hydPoint.coord)
    if (q.x > free.left + 24 && q.x < free.right - 24 && q.y > free.top + 24 && q.y < free.bottom - 24) return
    // both ends into the free part, zoomed out only as far as the line needs: its middle to the
    // free part's middle (an explicit zero padding, so the offset is the screen's own)
    const o = map.project([px, py])
    const fw = Math.max(40, free.right - free.left - 64), fh = Math.max(40, free.bottom - free.top - 64)
    const scale = Math.min(1, fw / Math.max(1, Math.abs(q.x - o.x)), fh / Math.max(1, Math.abs(q.y - o.y)))
    map.easeTo({
      center: [(px + hydPoint.coord[0]) / 2, (py + hydPoint.coord[1]) / 2],
      zoom: map.getZoom() + Math.log2(scale),
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
      offset: [(free.left + free.right) / 2 - box.width / 2, (free.top + free.bottom) / 2 - box.height / 2],
      duration: 500,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per hydrant shown
  }, [hydId])

  // ── actions from the panel ────────────────────────────────────────────────────────────────
  /** «Objektbesuch» (the chooser) or «Melden» (`checklist` = the station's Fehlermeldung, asked
   *  for up front — objectVisits/NewVisit falls back to the chooser where there is none) */
  const startVisit = (checklist?: string) => {
    if (!sel) return
    if (sel.kind === 'object') { onOpenVisits(objectVisitHref(sel.id, checklist)); return }
    if (sel.kind === 'building') {
      const address = register.info?.address ?? sel.address
      const street = splitAddress(address)[0]
      onOpenVisits(placeVisitHref({ at: sel.at, label: street || C.building, address, checklist }))
      return
    }
    onOpenVisits(placeVisitHref({
      at: sel.at,
      label: pinNearHit ? fillTemplate(C.pinLabelNear, { a: pinNearHit.label }) : C.pin,
      address: pinNearHit && pinHit?.hit ? normAddress(pinHit.hit.label) : null,
      checklist,
    }))
  }
  const copyCoords = () => {
    if (sel?.kind !== 'pin') return
    const text = `LV95 ${fmtLV95(sel.at[0], sel.at[1])} · WGS84 ${fmtWGS(sel.at[0], sel.at[1])}`
    void navigator.clipboard?.writeText(text).then(() => toast(C.copied, { icon: 'check' })).catch(() => {})
  }

  // ── Ebenen ────────────────────────────────────────────────────────────────────────────────
  const toggleLayer = (id: string) => {
    if (id === OBJECTS_ROW) { setObjectsOn((v) => !v); return }
    if (id === UNDERGROUND_ROW) { toggleUnder(); return }
    if (id.startsWith(CAT_ROW)) {
      const cat = id.slice(CAT_ROW.length)
      setHiddenCats((h) => { const next = new Set(h); if (!next.delete(cat)) next.add(cat); return next })
      return
    }
    if (id === GEOREF_ROW) { toggleGeoref(); return }
    if (weather.handlesLayer(id)) { weather.toggleRadar(); return }
    updateLayers((ls) => {
      const hit = ls.find((l) => l.id === id)
      if (!hit) return ls
      if (hit.base) return ls.map((l) => (l.base ? { ...l, visible: l.id === id } : l))
      return ls.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l))
    })
  }
  const setOpacity = (id: string, v: number) => {
    if (id === GEOREF_ROW) { setGeorefOpacity(v); return }
    if (weather.handlesLayer(id)) { weather.setRadarOpacity(v); return }
    updateLayers((ls) => ls.map((l) => (l.id === id ? { ...l, opacity: v } : l)))
  }
  const twins = [
    { id: OBJECTS_ROW, group: C.layerGroupStation, label: C.layerObjects, sub: C.layerObjectsSub, icon: 'footprint', visible: objectsOn },
    // one row per category, its colour on the glyph, under «Station» (R2-BITS' Alle/Keine/Standard
    // work over these like over any row); no object count on them – the owner doesn't want it
    // (20.10.2026)
    ...catRules.map((c) => ({
      id: `${CAT_ROW}${c.id}`, group: C.layerGroupStation, label: c.label,
      icon: 'footprint', swatch: c.color, visible: !hiddenCats.has(c.id),
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
      sub: C.layerPlanSub, icon: 'doc', visible: georefOn, opacity: georefOpacity,
    }] : []),
  ]

  // «Alle ein» / «Alle aus» / «Standard» (lib/karte/layerPresets): the viewer's own layers, and
  // every station row (Stationsobjekte, …) as a layer — never the aligned plan, like the Einsatz
  const karteDefaults = useMemo(() => viewerLayers(defaultLayers(), undefined), [])
  // every station row is on in «Standard» (Unterirdische Bauten too since round 5 — PresetRow.standard)
  const presetRows = twins.filter((t) => t.id !== GEOREF_ROW).map((t) => ({ id: t.id, visible: t.visible }))
  const layersPreset = karteLayerPreset(layers, karteDefaults, presetRows, weather.on && weather.radarOn)
  const quickTap = (tap: QuickTap) => {
    updateLayers((ls) => applyLayerPreset(ls, karteDefaults, tap))
    for (const id of presetFlips(presetRows, tap)) toggleLayer(id)
    if (tap !== 'all') weather.setRadar(false)
  }

  // ── the compass menu: no saved views here (they are an Einsatz's), the rest as on the Karte ──
  const fitAll = () => {
    const pts = objects.map(coordOf).filter((c): c is LngLat => !!c)
    if (pts.length < 2) { mapRef.current?.easeTo({ center: deploymentDefaultCenter() ?? view.center, zoom: 15 }); return }
    const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1])
    mapRef.current?.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 64, duration: 600 })
  }
  /** one GPS fix, then zoom (≥ 17) onto it; `orElse` when there is no position */
  const locate = (orElse?: () => void) => {
    if (!navigator.geolocation) { orElse?.(); return }
    navigator.geolocation.getCurrentPosition((p) => mapRef.current?.easeTo({ center: [p.coords.longitude, p.coords.latitude], zoom: Math.max(view.zoom, 17) }), () => orElse?.(), { enableHighAccuracy: true, timeout: 10_000 })
  }
  const viewsApi: ViewsApi = {
    list: [], current: view, onGo: NOOP, onSave: NOOP, onRename: NOOP, onDelete: NOOP,
    onResetNorth: () => mapRef.current?.easeTo({ bearing: 0 }),
    onFit: fitAll,
    onLocate: () => locate(),
    // holding the compass goes to where I stand – more often wanted than the whole village (owner,
    // Karte Haus round 2); no position (denied, timed out, no GPS) fits the village as before
    hold: { run: () => locate(fitAll), hint: C.compassHoldHint },
  }

  // ── chrome ────────────────────────────────────────────────────────────────────────────────
  const live = running[0] ?? null
  const runningChip = live && (
    <button type="button" className={s.running} onClick={() => onOpenIncident(live)} aria-label={fillTemplate(C.runningOpen, { t: live.title })}>
      <span className={s.pulse} aria-hidden />
      <span className={s.runningText}><b>{live.title}</b>{live.address && <small>{live.address.split(',')[0]}</small>}</span>
      <Icon id="chevron" />
    </button>
  )
  const panelSel: PanelSel | null = !sel ? null
    : sel.kind === 'object' ? (selObj ? { kind: 'object', obj: selObj } : null)
      : sel.kind === 'building' ? { kind: 'building', at: sel.at, address: sel.address, partOf: sel.of ? byId.get(sel.of)?.name ?? null : null }
        : {
          kind: 'pin', at: sel.at, near: pinNearHit, onBuilding: !!ringAt(ringsNear(sel.at), sel.at),
          nearState: !online && !pinHit ? 'offline' : !pinHit ? 'loading' : pinNearHit ? 'ok' : 'none',
        }
  // the switch «Objekt | <Haus>»: after a tap that hit one of an object's buildings, on both levels
  const levelObj = sel?.kind === 'object' && sel.hit ? selObj : sel?.kind === 'building' && sel.of ? byId.get(sel.of) ?? null : null
  const level: PanelLevel | null = levelObj && sel ? {
    on: sel.kind === 'object' ? 'object' : 'house',
    plans: openableCount(levelObj),
    house: sel.kind === 'object' ? (hitAddr && hitAddr.key === hitKey ? hitAddr.street : null)
      : splitAddress(register.info?.address ?? null)[0] || null,
    onPick: toLevel,
  } : null
  const onMapSurface = !openDoc && !onLibrary
  // Punkt setzen / Messen / Gefahrgut's centre take the map's taps: the toasts give way to the top
  // lane meanwhile (lib/toastLane · usePlacementLane; owner, Karte Haus round 3: «the toasts
  // sometimes block … the point placement thing»)
  usePlacementLane(onMapSurface && (tool === 'pin' || tool === 'measure' || tool === 'erg'))
  // Punkt setzen's instruction and the missing-catalogue notice are messages over the map, so they
  // wear the ONE message surface (08-toasts): sticky toasts for as long as they hold, in the lane
  // with the others — a pill of their own (`.hintBar`) lay under an undo toast on the tablet
  const pinHint = onMapSurface && tool === 'pin'
  useEffect(() => {
    if (!pinHint) return
    const id = toast(C.pinHint, { sticky: true, icon: 'pin' })
    return () => dismissToast(id)
  }, [pinHint, C.pinHint])
  const catNote = cat?.failed && !cat.data && !onLibrary ? (online ? C.loadFailed : C.noCatalogue) : null
  useEffect(() => {
    if (!catNote) return
    const id = toast(catNote, { sticky: true, icon: 'warn' })
    return () => dismissToast(id)
  }, [catNote])
  /** the panel is on screen: on the map, not under Messen, and on a phone not under a tool's own
   *  card nor pushed away */
  const panelShown = onMapSurface && !!panelSel && tool !== 'measure' && !(phone && (tool === 'erg' || tool === 'layers' || sheetShut || searchOpen))
  // the tablet's left rail is always there (owner, 19.10.2026): Karte · Checkliste, then the plans
  const railShown = !phone
  const tabletTools = [
    { id: 'pin', icon: 'pin', label: C.tools.pin },
    { id: 'measure', icon: 'measure', label: C.tools.measure },
    { id: 'erg', icon: 'warn', label: C.tools.erg },
  ]
  const approxAt = sel?.kind === 'object' && selObj && !coordOf(selObj) ? sel.approxAt ?? null : null

  // ── which objects carry their name tag (lib/karte/labels) ─────────────────────────────────
  // One greedy pass once the map has settled (`view` moves on moveend), again when what covers
  // the map changes (panel, sheet, search, a tool), and once more after a panel has slid in.
  const measureRef = useRef<HTMLSpanElement>(null)
  const sizes = useRef(new Map<string, { w: number; h: number }>())
  /** name → the width a FOLDED tag is given: its widest line plus its chrome (the twin's measure) */
  const [fits, setFits] = useState<ReadonlyMap<string, number>>(() => new Map())
  const fitsRef = useRef(fits)
  /** id → how far its tag slides sideways to stay on the map */
  const [tagged, setTagged] = useState<Map<string, number> | null>(null)
  const taggedRef = useRef<Map<string, number> | null>(null)
  const [resized, setResized] = useState(0)
  useEffect(() => {
    const on = () => setResized((n) => n + 1)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  const selId = selObj?.id ?? null
  const covered = `${!!panelSel}|${sheetShut}|${tool}|${searchOpen}|${sheetOpen}|${!!openDoc}|${onLibrary}|${railShown}`
  useEffect(() => {
    if (!objectsOn) return
    let alive = true
    /** a tag's real size: the off-screen twin measured once per name (jsdom: an estimate). A
     *  name that folds keeps the box of its 280px cap in CSS (owner, round 3: «wrapped lines …
     *  fitted to the width»): its lines are read off the twin and the tag is given the widest
     *  one's width (`fit`) – measured again at that width, so the placement collides the fitted box */
    let folded: Map<string, number> | null = null
    const size = (name: string) => {
      const hit = sizes.current.get(name)
      if (hit) return hit
      const el = measureRef.current
      let box = { w: 0, h: 0 }
      if (el) {
        el.textContent = tagText(name)
        el.style.width = ''
        let r = el.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(el)
        const lines = new Map<number, number>()
        for (const l of Array.from(range.getClientRects?.() ?? [])) lines.set(Math.round(l.top), Math.max(lines.get(Math.round(l.top)) ?? 0, l.width))
        if (lines.size > 1) {
          // the box is border-box: the line, its padding and border; +1 – a sub-pixel short of the
          // line, the balanced wrap would fold one word more
          const cs = getComputedStyle(el)
          const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
          const fit = Math.ceil(Math.max(...lines.values()) + chrome) + 1
          el.style.width = `${fit}px`
          r = el.getBoundingClientRect()
          el.style.width = ''
          ;(folded ??= new Map(fitsRef.current)).set(name, fit)
        }
        box = { w: Math.ceil(r.width), h: Math.ceil(r.height) }
      }
      if (!box.w) box = tagSize(name.length * 7)
      sizes.current.set(name, box)
      return box
    }
    const run = () => {
      const map = mapRef.current
      const root = rootRef.current
      if (!alive || !map || !root) return
      let next = new Map<string, number>()
      if (map.getZoom() >= LABEL_MIN_ZOOM) {
        const box = map.getContainer().getBoundingClientRect()
        // the chrome: every piece of the surface that is not the map itself and not a full-screen
        // layer (an open plan) — the bars, the rails, an open panel or sheet, the hint bars
        const occupied: Rect[] = []
        for (const el of Array.from(root.children)) {
          if (!(el instanceof HTMLElement) || el.querySelector('.maplibregl-canvas')) continue
          const r = el.getBoundingClientRect()
          if (r.width < 1 || r.height < 1 || r.width * r.height > box.width * box.height * 0.6) continue
          occupied.push({ left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top })
        }
        const cands: TagCandidate[] = []
        for (const o of objects) {
          const at = coordOf(o)
          if (!at || (catOff(o.id) && o.id !== selId)) continue
          // the tag sits on the object's point (lib/karte/labels): only whether it shows is decided
          const p = map.project(at)
          const { w, h } = size(o.name)
          cands.push({
            id: o.id, x: p.x, y: p.y, w, h,
            rank: tagRank({ kind: o.kind, plans: openableCount(o), selected: o.id === selId, wasShown: !!taggedRef.current?.has(o.id) }),
          })
        }
        next = placeTags(cands, { width: box.width, height: box.height, occupied, always: selId })
      }
      if (folded) { fitsRef.current = folded; setFits(folded); folded = null }
      if (samePlacement(taggedRef.current, next)) return
      taggedRef.current = next
      setTagged(next)
    }
    const raf = requestAnimationFrame(run)
    const t = setTimeout(run, 400)
    return () => { alive = false; cancelAnimationFrame(raf); clearTimeout(t) }
  }, [view, objects, selId, objectsOn, covered, phone, resized, catOff])

  return (
    <>
      <div data-karte="" ref={rootRef} className={cx('app mode-map', s.root, phone && s.phone, phone && 'phone-tools', onLibrary && s.onLibrary)}>
        <IconSprite />
        {/* the name tag's off-screen twin: what a tag measures before it is placed */}
        <span ref={measureRef} className={cx(s.tagMk, s.measure)} aria-hidden />
        {tip && <div ref={tipRef} className={s.hoverTip} role="tooltip" data-karte-hover="">{tip}</div>}
        <MapView
          ref={mapRef}
          entities={entities}
          layers={layers}
          byName={sym.byName}
          captionMode="off"
          initialCenter={start.center}
          initialZoom={start.zoom}
          initialBearing={start.view?.bearing ?? 0}
          showOrigin={false}
          // never past the visible base's last sharp level (owner on #383) — the Karte only
          zoomCapAtBase
          preparedOverlays={mapOverlays}
          isVisible={isVisible}
          selectedId={null}
          onSelect={onEntity}
          onMapClick={onMapClick}
          readOnly
          drawings={[]}
          drawingsVisible={false}
          draft={[]}
          draftKind={null}
          placing={tool !== null}
          draggable={false}
          onMarkerDragStart={NOOP}
          onMarkerMove={NOOP}
          onMarkerDragEnd={NOOP}
          onView={(v) => { setView(v); loadOutlines() }}
          onSettled={() => { flyPending(); loadOutlines(); watchUserMoves(); watchHover() }}
          freehand={null}
          onFreehand={NOOP}
          drawColor="#000000"
          drawWidth={3}
          drawDashed={false}
          selectedDrawingId={null}
          onSelectDrawing={NOOP}
          onDelete={NOOP}
          measurePoints={tool === 'measure' ? measure.path : []}
          measureKind={tool === 'measure' ? measure.mode : null}
          measureLabels={measure.labels}
          onMeasureDrag={(i, c) => measure.setPath((pts) => pts.map((p, j) => (j === i ? c : p)))}
          onMeasureInsert={(i, c) => measure.setPath((pts) => { const next = [...pts]; next.splice(i, 0, c); return next })}
          onMeasureDelete={(i) => measure.setPath((pts) => pts.filter((_, j) => j !== i))}
          georefPlanRasters={georefRasters}
          weatherRadar={weather.mapRadar}
          onBasemapUnavailable={onBasemapUnavailable}
        >
          {/* every object: a dot, or its name tag where the tag fits (lib/karte/labels) — the
              outline carries the object, the tag only names it */}
          {objectsOn && objects.map((o) => {
            const at = coordOf(o)
            if (!at) return null
            // a tap tool armed: the marker lets taps through (`.through`); one that reaches it anyway
            // (a keyboard) is the tool's, at the object's point — never a selection
            const pick = (e: React.MouseEvent) => { e.stopPropagation(); if (takesTaps) onMapClick(at); else selectObject(o.id, false) }
            const isSel = selObj?.id === o.id
            if (catOff(o.id) && !isSel) return null
            // the category's colour (lib/karte/categories); none = the default red, untouched
            const cat = cats.get(o.id)
            const catStyle = cat ? ({ '--cat': cat.color, '--cat-ink': inkOn(cat.color) } as React.CSSProperties) : undefined
            // without categories, «has plans» is the red; an object without any is drawn quieter
            const bare = !o.plans.length
            if (!isSel && !(tagZoom && tagged?.has(o.id))) {
              return (
                <Marker key={`dot:${o.id}`} longitude={at[0]} latitude={at[1]} anchor="center" style={{ zIndex: 1, pointerEvents: takesTaps ? 'none' : undefined }}>
                  <button type="button" className={cx(s.dotMk, cat && s.cat, !cat && bare && s.bare, takesTaps && s.through)} style={catStyle} aria-label={o.name} title={o.name} onClick={pick} />
                </Marker>
              )
            }
            // the tag takes the dot's place, on the point; the name only, no plan count (owner R3)
            const dx = (!isSel && tagged?.get(o.id)) || 0
            // a folded name: the box of its widest line, not of the 280px cap (the placement pass's `fits`)
            const fit = fits.get(o.name)
            return (
              <Marker key={`tag:${o.id}`} longitude={at[0]} latitude={at[1]} anchor="center" offset={[dx, 0]} style={{ zIndex: isSel ? 3 : 2, pointerEvents: takesTaps ? 'none' : undefined }}>
                <button type="button" className={cx(s.tagMk, isSel && s.sel, cat && s.cat, !cat && bare && s.bare, takesTaps && s.through)} style={fit ? { ...catStyle, width: fit } : catStyle} onClick={pick}>
                  {tagText(o.name)}
                </button>
              </Marker>
            )
          })}
          {approxAt && selObj && (
            <Marker longitude={approxAt[0]} latitude={approxAt[1]} anchor="center">
              <span className={cx(s.tagMk, s.approx, s.sel)}>{C.approxTag} · {selObj.name}</span>
            </Marker>
          )}
          {/* the hydrant shown from In der Nähe: a ring on it, its metres at the dashed line's middle */}
          {hydPoint && nearAt && (
            <>
              <Marker longitude={hydPoint.coord[0]} latitude={hydPoint.coord[1]} anchor="center" style={{ zIndex: 4, pointerEvents: 'none' }}>
                <span className={s.hydRing} data-karte-hydrant-ring="" />
              </Marker>
              <Marker longitude={(nearAt[0] + hydPoint.coord[0]) / 2} latitude={(nearAt[1] + hydPoint.coord[1]) / 2} anchor="center" style={{ zIndex: 4, pointerEvents: 'none' }}>
                <span className={s.hydDist}>{fmtDistance(haversineM(nearAt, hydPoint.coord))}</span>
              </Marker>
            </>
          )}
          {sel?.kind === 'pin' && (
            // the pin is the place: a tap on it brings back the sheet that was pushed away
            <Marker longitude={sel.at[0]} latitude={sel.at[1]} anchor="bottom" onClick={(e) => { e.originalEvent.stopPropagation(); setSheetShut(false) }}>
              <MapPin className={s.pinMk} />
            </Marker>
          )}
        </MapView>

        {openDoc && selObj && (
          <KarteSurface
            obj={selObj} doc={openDoc} phone={phone} sym={sym}
            offline={!online} held={openHeld} gebaeude={avail?.gebaeude ?? null}
            onMap={() => setSurface(null)}
          />
        )}

        {/* the Checkliste: the Einsatz surfaces' frame (Surface.module.css · .shell — under the bar,
            beside the rail, above the phone's bar, below the Meldeleiste and the keyboard); the
            library fills it. The map stays mounted behind, for the way back. */}
        {onLibrary && (
          <div className={cx(s.library, phone && live && s.belowStrip)} data-karte-library-surface="">
            <ChecklistLibrary query={libQuery} />
          </div>
        )}

        {/* the bar: NO title (owner, 16.10.2026) — the menu · search · weather · the running Einsatz */}
        <div className="topbar" ref={barRef}>
          {/* the menu button (owner, review round 5: «not "Einsätze" as the main top button» → the
              station's short name and/or mark, ▾; neither configured → the menu symbol). The red dot
              is the old count: an Einsatz running or an alarm waiting; the number is in its name. */}
          <button type="button" className={cx('ip-switch-btn', s.einsaetze, sheetOpen && s.open)} onClick={() => { setSheetOpen((o) => !o); setSearchOpen(false) }}
            title={C.menu} aria-label={einsaetze.badge > 0 ? `${menuName}, ${fillTemplate(C.einsaetzeBadge, { n: einsaetze.badge })}` : menuName}
            aria-haspopup="dialog" aria-expanded={sheetOpen} data-karte-menu="">
            {mark ? <img className={s.menuMark} src={mark} alt="" onError={() => setMarkFailed(true)} />
              : !brand.short && <Icon id="menu" />}
            {brand.short && <span className={s.menuName}>{brand.short}</span>}
            {/* `chev` = the app's shared flip on [aria-expanded=true] (02-base.css), as every other dropdown */}
            <Icon id="chevron-down" className={cx('chev', s.chev)} />
            {einsaetze.badge > 0 && <span className={s.einsaetzeBadge} data-karte-menu-dot="" aria-hidden />}
          </button>
          {/* the Checkliste: the bar's field searches the library (on a phone too, inline — the map's
              round search button is the map's) */}
          {onLibrary ? (
            <SearchField
              {...typingFieldProps('search', 'karte-checkliste')}
              key="library"
              className={cx(s.search, phone && s.libSearch)}
              value={libQuery}
              onChange={setLibQuery}
              onTouchEnd={phone ? noPanTouchEnd : undefined}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              placeholder={defuseAutofill(C.librarySearchPlaceholder)}
              aria-label={defuseAutofill(C.librarySearch)}
            />
          ) : !phone && (
            <SearchField
              {...typingFieldProps('search', 'karte')}
              key="map"
              className={s.search}
              value={query}
              onChange={(v) => { setQuery(v); setSearchOpen(true) }}
              onFocus={() => setSearchOpen(true)}
              onKeyDown={(e) => { if (e.key === 'Escape') setSearchOpen(false) }}
              placeholder={defuseAutofill(C.searchPlaceholder)}
              aria-label={defuseAutofill(C.searchPlaceholder)}
            />
          )}
          {/* offline: the chip stands where the weather was and opens «Auf diesem Gerät» */}
          {!online ? (
            <button type="button" className={cx('ip-offline-chip', s.offChip)} onClick={() => setDeviceOpen(true)} title={C.offlineChipTitle} aria-label={C.offlineChipTitle}>
              <span className={s.offDot} aria-hidden />{!phone && C.offlineChip}
            </button>
          ) : !phone && liveWeather.data?.wind_dir_deg != null && <WeatherBadge weather={liveWeather.data} bearing={view.bearing} />}
          {!phone && runningChip}
          {phone && !onLibrary && (
            <button type="button" className={cx('ip-switch-btn', s.searchBtn, searchOpen && s.open)} onClick={() => (searchOpen ? setSearchOpen(false) : openPhoneSearch())}
              aria-label={C.searchOpen} title={C.searchOpen} aria-expanded={searchOpen} data-karte-search-open="">
              <Icon id="search" />
            </button>
          )}
          {/* the app menu, hung off the bar as the Einsatz menu hangs off its own (13-incident ·
              .ip-menu) — the same rows (panels/AppMenuRows), without the Einsatz card */}
          {sheetOpen && (
            <div className="ip-menu ip-einsaetze" role="dialog" aria-label={C.menu}>
              {einsaetze.render(closeSheet, openDevice)}
            </div>
          )}
        </div>
        {/* the strip stands where the «Einsätze» sheet hangs — and the sheet lists the same Einsatz */}
        {phone && live && !sheetOpen && <div className={s.runningStrip} data-karte-running="">{runningChip}</div>}

        {searchOpen && !phone && !onLibrary && (
          <KarteSearch query={query} hits={hits} nearest={nearest} addresses={addrState === 'ok' ? addr.list : []} addrState={addrState}
            onPickObject={(id) => { setQuery(byId.get(id)?.name ?? ''); selectObject(id, true, 'search') }} onPickAddress={pickAddress} />
        )}
        {searchOpen && phone && !onLibrary && (
          <KarteKeySheet
            fill
            label={C.searchOpen}
            onClose={() => setSearchOpen(false)}
            field={(
              <SearchField
                {...typingFieldProps('search', 'karte')}
                ref={sheetFieldRef} className={s.keyField} noClear value={query}
                // the keyboard back with a tap on the field: focused without Safari's scroll to it,
                // as Gefahrgut's field (review round 5: that pan moved the whole sheet)
                onChange={setQuery} onTouchEnd={noPanTouchEnd}
                onKeyDown={(e) => { if (e.key === 'Escape') setSearchOpen(false); else if (e.key === 'Enter') e.currentTarget.blur() }}
                placeholder={defuseAutofill(C.searchPlaceholderShort)}
                aria-label={defuseAutofill(C.searchPlaceholder)}
              />
            )}
          >
            <KarteSearch inSheet query={query} hits={hits} nearest={nearest} addresses={addrState === 'ok' ? addr.list : []} addrState={addrState}
              onPickObject={(id) => { setQuery(byId.get(id)?.name ?? ''); selectObject(id, true, 'search') }} onPickAddress={pickAddress} />
          </KarteKeySheet>
        )}

        {railShown && (
          <KarteNavRail obj={selObj} docs={docs} active={onLibrary ? 'library' : openDoc ? { doc: openDoc.doc.id } : 'map'}
            onMap={() => setSurface(null)} onLibrary={openLibrary} onDoc={(id) => { setSurface(id); setToolState(null) }}
            notHeld={!online ? new Set(docs.filter((d) => docHeld(d) === false).map((d) => d.doc.id)) : null} />
        )}

        {panelShown && panelSel && (
          <KartePanel
            sel={panelSel}
            register={register}
            nearby={nearby}
            litHydrant={litHydrant}
            onHydrant={onHydrant}
            level={level}
            visits={visitsState}
            canCapture={canCapture}
            docs={docs}
            offline={!online}
            avail={avail}
            sheet={phone}
            withRail={railShown}
            onClose={closePanel}
            onStartVisit={() => startVisit()}
            onReport={() => startVisit(REPORT_CHECKLIST)}
            onOpenDoc={(id) => { setSurface(id); setToolState(null) }}
            onSelectObject={(id) => selectObject(id)}
            onRetryRegister={() => setRegTry((n) => n + 1)}
            // `from=karte`: the visit's «Zurück» lands here again, not on the Objektbesuche list
            onOpenVisit={(id) => onOpenVisits(`${ovHref({ kind: 'visit', id })}?from=karte`)}
            onPinBuilding={() => { if (sel?.kind === 'pin') selectBuilding(sel.at, ringAt(ringsNear(sel.at), sel.at)) }}
            onCopyCoords={copyCoords}
          />
        )}

        {/* the tablet's tools: the Einsatz's right rail, with the viewer's three reference tools */}
        {!phone && onMapSurface && (
          <ToolRail
            className="tool-rail"
            primary={{ id: '__none', icon: 'plus', label: '' }}
            tools={tabletTools}
            active={tool === 'layers' ? '' : tool ?? ''}
            onPick={(id) => setTool(id as Tool)}
            footer={(
              <>
                <button className={cx('vrail-nbtn vrail-layers', tool === 'layers' && 'on')} title={C.tools.layers} aria-label={C.tools.layers} aria-pressed={tool === 'layers'} onClick={() => setTool('layers')}>
                  <span className="vrail-glyph"><Icon id="layers" /></span><span className="vrail-label">{C.tools.layers}</span>
                </button>
                <MapViewsButton api={viewsApi} bearing={view.bearing} readOnly variant="rail" btnClassName="vrail-nbtn vrail-views" activeClassName="on" glyphClassName="vrail-compass"
                  label={appConfig.copy.mapViews.title} open={viewsOpen} onOpenChange={(o) => { setViewsOpen(o); if (o && tool === 'layers') setToolState(null) }} />
              </>
            )}
          />
        )}

        {/* the phone: Karte · Checkliste │ Messen · Gefahrgut · Ebenen at the foot (owner, 19.10.2026 ·
            variant A — the bar never changes: a tool tapped on the Checkliste goes back to the Karte
            with it armed, setTool), pin + compass above it on the map. No «Pläne» tab (owner,
            17.10.2026): an object's plans are rows in its sheet, and an open plan goes back with its
            «Zur Karte» chip or the Karte tab */}
        {phone && (
          <>
            <nav className="navrail rail folded labelled" aria-label={C.title}>
              <div className="rail-scroll-wrap"><div className="nav-scroll rail-scroll">
                <button type="button" className={cx('nav-item', onMapSurface && !tool && 'on')} onClick={() => { setSurface(null); setToolState(null) }}>
                  <span className="nav-glyph"><Icon id="map" /></span><span className="nav-label">{C.tools.map}</span>
                </button>
                <button type="button" className={cx('nav-item', onLibrary && 'on')} aria-pressed={onLibrary} onClick={openLibrary} data-karte-library="">
                  <span className="nav-glyph"><Icon id="checklist" /></span><span className="nav-label">{appConfig.copy.modes.checklists}</span>
                </button>
                {/* the surfaces │ the map's tools */}
                <div className={cx('nav-sep', s.barSep)} aria-hidden />
                {(['measure', 'erg', 'layers'] as const).map((t) => (
                  <button key={t} type="button" className={cx('nav-item', tool === t && 'on')} aria-pressed={tool === t} onClick={() => openPhoneTool(t)}>
                    <span className="nav-glyph"><Icon id={t === 'erg' ? 'warn' : t} /></span><span className="nav-label">{C.tools[t]}</span>
                  </button>
                ))}
              </div></div>
            </nav>
            {onMapSurface && !tool && !panelShown && !searchOpen && (
              <div className={s.phoneUtil}>
                <button type="button" className={cx(s.utilBtn)} aria-label={C.tools.pin} onClick={() => setTool('pin')}><Icon id="pin" /></button>
                <MapViewsButton api={viewsApi} bearing={view.bearing} readOnly variant="util" btnClassName={s.utilBtn} glyphClassName={s.utilGlyph}
                  open={viewsOpen} onOpenChange={setViewsOpen} />
              </div>
            )}
          </>
        )}

        {tool === 'measure' && (
          <>
            <ToolDock groups={[
              [{ type: 'close', onClick: () => setTool('measure') }],
              [
                { type: 'toggle', icon: 'measure', label: appConfig.copy.measure.modeLine, on: measure.mode === 'line', onClick: () => measure.setMode('line') },
                { type: 'toggle', icon: 'area', label: appConfig.copy.measure.modeArea, on: measure.mode === 'area', onClick: () => measure.setMode('area') },
              ],
              [{ type: 'action', icon: 'trash', label: appConfig.copy.measure.clear, disabled: !measure.path.length, onClick: () => measure.setPath(() => []) }],
              [{ type: 'info', text: appConfig.copy.dockHints.measure }],
            ]} />
            {/* temporary by construction: no «Als Linie/Fläche übernehmen» (no onAdopt) — and no
                line saying so either (owner-6): nothing on this surface is ever saved */}
            <MeasurePanel mode={measure.mode} coords={measure.path} profile={measure.profile} profileLoading={measure.loading} className={s.measurePanel} />
          </>
        )}

        {tool === 'erg' && (
          <KarteGefahrgut
            un={erg.un} onUn={(un) => setErg((e) => ({ ...e, un, center: e.center ?? selPoint(sel) ?? view.center, at: new Date() }))}
            mode={erg.mode} onMode={(mode) => setErg((e) => ({ ...e, mode, at: new Date() }))}
            center={erg.center} onClose={() => setTool('erg')} phone={phone} focusOnOpen={phone && ergKeys}
          />
        )}

        {tool === 'layers' && (
          <LayerPanel
            layers={layers}
            onToggle={toggleLayer}
            onOpacity={setOpacity}
            twins={twins}
            // «Station» first (owner, review round 4: «it's the most relevant one in this case»)
            leadTwinGroups={[C.layerGroupStation]}
            weather={weather.row}
            onShowAll={() => quickTap('all')}
            onHideAll={() => quickTap('none')}
            onReset={() => quickTap('standard')}
            preset={layersPreset}
            note={C.layersOwn}
            onClose={() => setTool('layers')}
          />
        )}

        {weather.on && weather.layer && weather.radarOn && onMapSurface && !panelShown && (
          <div className="wb-botleft wx-row">
            <Suspense fallback={null}>
              <WeatherRadarControls radar={weather.radar} frameIndex={weather.playback.frameIndex}
                playing={weather.playback.playing} onPick={weather.playback.pick}
                onTogglePlaying={weather.playback.togglePlaying} stale={weather.radarStale} now={weather.now} />
            </Suspense>
          </div>
        )}

        {noBasemap && !online && (
          <NoBasemapMeldung sub={C.basemapSub} actionLabel={C.basemapAction}
            onOpenOffline={() => { setNoBasemap(false); setDeviceOpen(true) }} onDismiss={() => setNoBasemap(false)} />
        )}
        {/* «Neue Version bereit» — the Einsatz's own row (UpdateBanner), in the same strip: the Karte
            is home with no Einsatz open, and a covered Einsatz behind it paints no rows of its own
            but the alarms (review round 7) */}
        <UpdateBanner />
        {deviceOpen && (
          <KarteDevice offline={!online} objects={objects} map={coverage === 'far' ? 'far' : coverage ? { held: coverage.held, total: coverage.total } : null} onClose={() => setDeviceOpen(false)} />
        )}
      </div>
    </>
  )
}
