// «Karte & Objekte» — the station reference viewer outside an Einsatz (docs/karte-objekte.md).
// Its own lazy chunk (App · lazy), mounted for the `/karte` route.
//
// What it is: the station area on the Einsatz's map (MapView, its Ebenen, the vehicles, the
// weather), every station object as a red outline with its name tag (a key box as the FKS
// «Schlüsseldepot»), one panel for whatever is known about the selected place, the object's plans
// in the NavRail grammar (on a phone: as rows in its slide-up sheet, KartePanel), and the reference
// tools — Punkt setzen, Messen, Gefahrgut — that need no symbol placed first.
//
// ⚠️ What it never is: an Einsatz. It holds NO workspace, writes no drawing, binds no plan and
// moves nothing in any incident. Measurements, the Gefahrgut rings and a dropped pin live in this
// component's state and die with it; the only things kept are its own Ebenen and where it was
// looking (lib/karte/session). The single way it changes anything is the Objektbesuch button,
// which hands over to the existing capture (`/besuche/neu?…&from=karte`, contract C1).
//
// It is HOME too (owner, 16.10.2026 · variant B): with no Einsatz open an account lands here, and
// the «Einsätze ▾» at the top left opens the app menu — the same rows as the Einsatz menu
// (panels/AppMenuRows, owner 17.10.2026). App renders them (`einsaetze.render`, its handlers);
// this file only opens and closes the sheet, and hands in its own «Auf diesem Gerät».

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MapRef } from 'react-map-gl/maplibre'
import { Marker } from 'react-map-gl/maplibre'
import { appConfig } from '../../config/appConfig'
import { getLocaleId } from '../../config/copy'
import { Icon, IconSprite } from '../../lib/icons'
import { cx } from '../../lib/cx'
import { fillTemplate } from '../../lib/format'
import { useAuth } from '../../lib/auth'
import { useIsPhone } from '../../lib/useIsPhone'
import { useOnline } from '../../lib/useOnline'
import { onReachable } from '../../lib/connectivity'
import { useNightTheme } from '../../lib/useNightTheme'
import { useViewportPan } from '../../lib/useViewportPan'
import { focusWithoutPan, useTypingLock } from '../../lib/iosKeyboard'
import { primeKeyboard } from '../../lib/keyboardPrime'
import { defuseAutofill, typingFieldProps } from '../../lib/typingField'
import { useSymbols } from '../../lib/useSymbols'
import { useMeasure } from '../../lib/useMeasure'
import { useVehicleLayer } from '../../lib/useVehicleLayer'
import { useWeather } from '../../lib/useWeather'
import { useKarteWeather } from '../../workspace/useKarteWeather'
import { deploymentDefaultCenter, objectCategoryRules, objectVisitsConfig } from '../../lib/deploymentConfig'
import { defaultLayers } from '../../lib/workspace'
import { fmtLV95, fmtWGS } from '../../lib/geo'
import { themeToken, uiBlue } from '../../lib/themeToken'
import { toast } from '../../lib/ui'
import { geocodeReverse, geocodeSearch, type GeoHit } from '../../lib/api/geo'
import { getApprovedPlanAlignments, referenceUrl } from '../../lib/api/reference'
import { loadStationBuilding, loadStationObjects, type StationObject, type StationObjects } from '../../lib/api/stationReference'
import type { IncidentMeta } from '../../lib/api/incidents'
import { listVisits } from '../../objectVisits/api'
import { ovHref, navigateTo } from '../../objectVisits/route'
import { lookupErg } from '../../lib/erg'
import { DEFAULT_ERG_RING_MODE, ergRingsFor, type ErgRingMode } from '../../lib/ergRings'
import { fitSimilarity } from '../../lib/georef'
import { withPdfPage } from '../../lib/whiteboard'
import { coordOf, openableCount, searchObjects } from '../../lib/karte/search'
import {
  nearbyObjects, nearestPoints, objectAtAddress, objectBuildings, objectVisitHref, pinNear, placeVisitHref, REPORT_CHECKLIST,
  normAddress, pointsFromGeoJson, ringAt, splitAddress, type NamedPoint,
} from '../../lib/karte/places'
import { LABEL_MIN_ZOOM, placeTags, samePlacement, tagRank, tagSize, type Rect, type TagCandidate } from '../../lib/karte/labels'
import { symPx } from '../../lib/mapView'
import { cellOf, cellsFor, loadCell, OUTLINE_MIN_ZOOM } from '../../lib/karte/outlines'
import { GEBAEUDE_DOC, viewerPlanDocs } from '../../lib/karte/plans'
import { moduleCatalogue } from '../../lib/planOrder'
import { karteHref } from '../../lib/karte/route'
import { applyLayerPreset, karteLayerPreset, presetFlips, type QuickTap } from '../../lib/karte/layerPresets'
import { karteRadarStore, loadKarteView, loadViewerLayerPrefs, saveKarteView, saveViewerLayerPrefs, viewerLayers, type KarteTool } from '../../lib/karte/session'
import { KEY_BOX_SYMBOL, KeyBoxSvg } from '../../lib/karte/keyBox'
import { categorize, categoryCounts, categoryRules, inkOn } from '../../lib/karte/categories'
import { tagAnchor } from '../../lib/karte/tagAnchor'
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
import { KartePanel, type PanelSel, type RegisterState, type VisitsState } from './KartePanel'
import { KarteSearch, type AddrState } from './KarteSearch'
import { KarteGefahrgut } from './KarteGefahrgut'
import { KarteKeySheet } from './KarteKeySheet'
import { KarteNavRail, KarteSurface } from './KartePlans'
import { KarteDevice } from './KarteDevice'
import { KeyBoxGlyph } from './KeyBoxGlyph'
import { useMapCoverage, useObjectAvailability } from './useKarteOffline'
import { NoBasemapMeldung } from '../NoBasemapMeldung'
import { planKey, tileRing, type TileXY } from '../../lib/karte/availability'
import s from './Karte.module.css'

type Sel =
  | { kind: 'object'; id: string; approxAt?: LngLat | null }
  | { kind: 'building'; at: LngLat; ring: LngLat[] | null; address: string | null }
  | { kind: 'pin'; at: LngLat }
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
/** how much of a phone's height the object sheet may cover (Ebenen's cap, 15-mobile · .layers-card):
 *  a place framed for it stands in the strip above */
const SHEET_SHARE = 0.72
/** px between a building's south edge and the tag hanging under it */
const TAG_GAP = 4
/** an Ebenen row per object category (lib/karte/categories) */
const CAT_ROW = 'karte:kategorie:'

export interface KarteAppProps {
  /** «Einsätze ▾»: the app menu as a sheet (App owns the rows and their handlers) and the badge
   *  on the button — running Einsätze + alarms waiting to be taken. `onDevice` opens this
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
    const wanted = new URLSearchParams(window.location.search).get('objekt') ?? v?.objectId ?? null
    return { view: v, wanted, center: v?.center ?? deploymentDefaultCenter() ?? COUNTRY_CENTER, zoom: v?.zoom ?? (deploymentDefaultCenter() ? 15.5 : 8) }
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
  const [surface, setSurface] = useState<string | null>(null) // an open document id, null = the Karte
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
  // An object no rule takes keeps the default look (red; a key box its FKS glyph). Each category
  // is an Ebenen row of its own; a hidden one takes its objects off the map (outline, dot, tag,
  // tap) — the selected object stays, it was chosen on purpose.
  const catRules = useMemo(() => categoryRules(objectCategoryRules(), lang), [lang])
  const cats = useMemo(() => categorize(objects, catRules), [objects, catRules])
  const [hiddenCats, setHiddenCats] = useState<ReadonlySet<string>>(() => new Set())
  const catOff = useCallback((id: string) => { const c = cats.get(id); return !!c && hiddenCats.has(c.id) }, [cats, hiddenCats])
  const selObj = sel?.kind === 'object' ? byId.get(sel.id) ?? null : null
  // titled and typed by the station's module catalogue, as the Einsatz's plan chooser is
  const docs = useMemo(() => (selObj ? viewerPlanDocs(selObj, C.floorsRow, moduleCatalogue()) : []), [selObj, C.floorsRow])
  const openDoc = surface ? docs.find((d) => d.doc.id === surface) ?? null : null

  // ── offline: which of the object's plans this device holds (lib/karte/availability) ─────────
  // Re-asked every few seconds while an open sheet is not held yet and the network is up: opening
  // it online is what puts it in the cache, and the chip should say so once it is there.
  const [availNonce, setAvailNonce] = useState(0)
  const avail = useObjectAvailability(selObj, availNonce)
  const docHeld = (d: { plan: StationObject['plans'][number] | null } | null): boolean | null => {
    if (!d || !avail) return null
    return d.plan ? avail.plans[planKey(d.plan)] ?? false : avail.gebaeude === 'device'
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
  const ringsNear = useCallback((at: LngLat) => cells[cellOf(at)] ?? [], [cells])
  /** each station object's buildings — the server's official set, else the OSM outline its point
   *  lies in (lib/karte/places · objectBuildings) — and the one its tag hangs off */
  const outlines = useMemo(() => {
    const m = new Map<string, { rings: LngLat[][]; main: LngLat[] | null }>()
    for (const o of objects) {
      const at = coordOf(o)
      if (!at || o.kind === 'depot') continue
      const b = objectBuildings(o, cells[cellOf(at)] ?? [])
      if (b) m.set(o.id, b)
    }
    return m
  }, [objects, cells])

  /** where each object's tag hangs — never on another object's building (lib/karte/tagAnchor) */
  const anchors = useMemo(() => {
    const all = [...outlines.entries()]
    const m = new Map<string, { at: LngLat; under: boolean }>()
    for (const o of objects) {
      const at = coordOf(o)
      if (!at || o.kind === 'depot') continue
      const others = all.filter(([id]) => id !== o.id).flatMap(([, b]) => b.rings)
      m.set(o.id, tagAnchor(outlines.get(o.id), at, others))
    }
    return m
  }, [objects, outlines])

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
  const viewLabel = selObj
    ? [selObj.name, openDoc && (openDoc.plan ? fillTemplate(C.backPlan, { code: openDoc.doc.code }) : openDoc.doc.title)].filter(Boolean).join(' · ')
    : null
  // ⚠️ Not before the catalogue has answered (or failed): until then nothing is selected yet, and
  // leaving that early would overwrite the object the session was on with «nothing».
  useEffect(() => {
    if (!catLoaded) return
    const surf = !openDoc ? 'karte' as const : openDoc.plan ? { plan: openDoc.plan.id } : 'gebaeude' as const
    saveKarteView({ ...view, objectId: objectInUrl, surface: surf, tool: keptTool, label: viewLabel })
  }, [catLoaded, view, objectInUrl, openDoc, keptTool, viewLabel])
  // back from an Einsatz: one line that says where it picked up (mockup j8-5), once per entry
  const announced = useRef(false)
  useEffect(() => {
    // once per mount (a ref, so StrictMode's second run says nothing): the entry is what is announced
    if (announced.current) return
    announced.current = true
    if (announceReturn && start.view?.label) toast(fillTemplate(C.backAt, { where: start.view.label }), { icon: 'check' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── «Einsätze ▾»: the app menu as a sheet under the bar ─────────────────────────────────────
  const [sheetOpen, setSheetOpen] = useState(false)
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
  // the phone: the bar has a round search button, the field lives in a slide-up (review round 3,
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
  const featured = useMemo(() => objects.filter((o) => o.kind === 'einsatzobjekt').slice(0, 6), [objects])

  // ── selecting ─────────────────────────────────────────────────────────────────────────────
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
  const selectObject = (id: string, fly = true) => {
    const o = byId.get(id)
    if (!o) return
    setSel({ kind: 'object', id })
    setSurface(null); setSearchOpen(false); setSheetShut(false)
    if (tool !== 'measure' && tool !== 'erg') setToolState(null)
    const at = coordOf(o)
    // a tapped object is revealed beside / above the panel like a tapped building
    if (at) { if (fly) flyTo(at); else reveal(at) } else if (o.address && online) {
      // no coordinates in the catalogue: the address says roughly where — marked «ungefähr»
      geocodeSearch(o.address, 1).then(([hit]) => {
        if (!hit) return
        const approx: LngLat = [hit.lng, hit.lat]
        setSel((cur) => (cur?.kind === 'object' && cur.id === id ? { ...cur, approxAt: approx } : cur))
        flyTo(approx, 17)
      }).catch(() => {})
    }
  }
  const selectBuilding = (at: LngLat, ring: LngLat[] | null, address: string | null = null) => {
    setSel({ kind: 'building', at, ring, address })
    setSurface(null); setSearchOpen(false); setSheetShut(false)
    if (tool !== 'measure' && tool !== 'erg') setToolState(null)
    reveal(at)
  }
  const dropPin = (at: LngLat) => {
    setSel({ kind: 'pin', at })
    setSurface(null); setSearchOpen(false); setSheetShut(false); setToolState(null)
    reveal(at)
  }
  const deselect = () => { setSel(null); setSurface(null); setSheetShut(false) }
  // ✕ / pushed down: on the tablet the panel IS the selection; on a phone the sheet only covers
  // the map, so it goes and the place stays selected for a second look
  const closePanel = () => { if (phone) setSheetShut(true); else deselect() }

  const pickAddress = (hit: GeoHit) => {
    setSearchOpen(false); setQuery(splitAddress(hit.label)[0])
    const at: LngLat = [hit.lng, hit.lat]
    const o = objectAtAddress(objects, hit.label)
    if (o) { selectObject(o.id); return }
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
      // a building whose register address IS a catalogue object's opens that object instead
      if (r && sel.kind === 'building') {
        const o = objectAtAddress(objects, r.value.address) ?? (r.value.object ? byId.get(r.value.object.id) : null)
        if (o && o.kind !== 'depot') setSel((cur) => (cur === sel ? { kind: 'object', id: o.id } : cur))
      }
    })
    return () => { alive = false }
    // regKey is the identity of what is asked; `sel` itself is read for the switch above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regKey, regTry, lang])
  const register: RegisterState = reg && reg.key === regKey ? reg.state : { state: 'loading', info: null, cached: false }

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
  const wantHydrants = !!sel && !!hydrantLayer?.geojson
  useEffect(() => {
    if (!wantHydrants || !hydrantLayer?.geojson || hydrants.length) return
    let alive = true
    fetch(hydrantLayer.geojson, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((fc) => { if (alive) setHydrants(pointsFromGeoJson(fc, 'h')) })
      .catch(() => {})
    return () => { alive = false }
  }, [wantHydrants, hydrantLayer, hydrants.length])
  const nearby = point ? nearbyObjects(objects, point, { exceptId: selObj?.id }) : []
  const nearHydrants = point ? nearestPoints(hydrants, point) : []

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
  const overlays = useMemo<PreparedMapOverlay[]>(() => {
    const out: PreparedMapOverlay[] = []
    // one overlay per colour: the default red first, then each category in the config's order
    const byColor = new Map<string, { id: string; rings: LngLat[][] }>()
    for (const [id, b] of outlines) {
      if (id === selObj?.id || catOff(id)) continue
      const c = cats.get(id)
      const key = c?.color ?? red
      const slot = byColor.get(key) ?? { id: c ? `karte-objects-${c.id}` : 'karte-objects', rings: [] }
      slot.rings.push(...b.rings)
      byColor.set(key, slot)
    }
    for (const [color, slot] of byColor) out.push({ id: slot.id, kind: 'polygons', layer: OBJECTS_LAYER, rings: slot.rings, color, fillOpacity: 0.14, lineWidth: 1.6, lineOpacity: 0.85 })
    // the selected object: EVERY one of its buildings in the strong style, in its own colour
    const mine = selObj ? outlines.get(selObj.id) : null
    if (mine) out.push({ id: 'karte-object-sel', kind: 'polygons', layer: ALWAYS_LAYER, rings: mine.rings, color: (selObj && cats.get(selObj.id)?.color) ?? red, fillOpacity: 0.3, lineWidth: 3, lineOpacity: 1 })
    // the building's outline — found again once its cell has loaded (a searched address flies first)
    const bRing = sel?.kind === 'building' ? sel.ring ?? ringAt(ringsNear(sel.at), sel.at) : null
    if (bRing) out.push({ id: 'karte-building', kind: 'polygons', layer: ALWAYS_LAYER, rings: [bRing], color: uiBlue(), fillOpacity: 0.16, lineWidth: 2.5, lineOpacity: 1 })
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
  }, [outlines, selObj, sel, tool, erg, red, ringsNear, uncached, hatchInk, cats, catOff])
  // key boxes are the FKS symbol from the tag zoom on; below it, a small glyph among the dots
  const tagZoom = view.zoom >= LABEL_MIN_ZOOM
  const entities = useMemo<Entity[]>(() => [
    ...liveVehicles,
    ...objects.filter((o) => tagZoom && o.kind === 'depot' && coordOf(o) && (!catOff(o.id) || o.id === selObj?.id)).map((o) => ({
      id: `karte:${o.id}`, kind: 'symbol' as const, layer: OBJECTS_LAYER, coord: coordOf(o)!, symbol: KEY_BOX_SYMBOL, label: o.name,
    })),
  ], [liveVehicles, objects, tagZoom, catOff, selObj?.id])
  const isVisible = useCallback((id: LayerId) => {
    if (id === OBJECTS_LAYER) return objectsOn
    if (id === ALWAYS_LAYER || id === UNCACHED_LAYER) return true
    return layers.find((l) => l.id === id)?.visible ?? true
  }, [layers, objectsOn])

  // ── taps ──────────────────────────────────────────────────────────────────────────────────
  // ⚠️ No long press drops a pin (owner, review round 3, 17.10.2026: «I can't delete nodes when
  // measuring because it wants to create a point»). Holding a measure node is how Messen removes it
  // (MapView · vertexPress), and a hold anywhere on the map dropped a pin under the finger and left
  // Messen. A pin is set with the ⊙ tool and a tap — the one way, on the phone and the tablet.
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
    if (objectsOn) {
      // any of an object's buildings opens the object
      for (const [id, b] of outlines) if (!catOff(id) && ringAt(b.rings, c)) { selectObject(id, false); return }
    }
    const ring = ringAt(ringsNear(c), c)
    if (ring) { selectBuilding(c, ring); return }
    if (sel) deselect()
  }
  const onEntity = (e: Entity) => {
    if (tool === 'measure') { measure.setPath((pts) => [...pts, e.coord]); return }
    if (e.id.startsWith('karte:')) selectObject(e.id.slice('karte:'.length), false)
  }

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
  const catCount = categoryCounts(cats)
  const twins = [
    { id: OBJECTS_ROW, group: C.layerGroupStation, label: C.layerObjects, sub: C.layerObjectsSub, icon: 'footprint', visible: objectsOn },
    // one row per category, its colour on the glyph, under «Station» (R2-BITS' Alle/Keine/Standard
    // work over these like over any row)
    ...catRules.map((c) => ({
      id: `${CAT_ROW}${c.id}`, group: C.layerGroupStation, label: c.label,
      sub: fillTemplate(C.layerCategorySub, { n: catCount.get(c.id) ?? 0 }), icon: 'footprint', swatch: c.color, visible: !hiddenCats.has(c.id),
    })),
    ...(georefPlan && selObj ? [{
      id: GEOREF_ROW, group: C.layerGroupPlans, label: fillTemplate(C.layerPlan, { code: georefPlan.code, name: selObj.name }),
      sub: C.layerPlanSub, icon: 'doc', visible: georefOn, opacity: georefOpacity,
    }] : []),
  ]

  // «Alle ein» / «Alle aus» / «Standard» (lib/karte/layerPresets): the viewer's own layers, and
  // every station row (Stationsobjekte, …) as a layer — never the aligned plan, like the Einsatz
  const karteDefaults = useMemo(() => viewerLayers(defaultLayers(), undefined), [])
  const presetRows = twins.filter((t) => t.id !== GEOREF_ROW).map((t) => ({ id: t.id, visible: t.visible }))
  const layersPreset = karteLayerPreset(layers, karteDefaults, presetRows, weather.on && weather.radarOn)
  const quickTap = (tap: QuickTap) => {
    updateLayers((ls) => applyLayerPreset(ls, karteDefaults, tap))
    for (const id of presetFlips(presetRows, tap)) toggleLayer(id)
    if (tap !== 'all') weather.setRadar(false)
  }

  // ── the compass menu: no saved views here (they are an Einsatz's), the rest as on the Karte ──
  const viewsApi: ViewsApi = {
    list: [], current: view, onGo: NOOP, onSave: NOOP, onRename: NOOP, onDelete: NOOP,
    onResetNorth: () => mapRef.current?.easeTo({ bearing: 0 }),
    onFit: () => {
      const pts = objects.map(coordOf).filter((c): c is LngLat => !!c)
      if (pts.length < 2) { mapRef.current?.easeTo({ center: deploymentDefaultCenter() ?? view.center, zoom: 15 }); return }
      const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1])
      mapRef.current?.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 64, duration: 600 })
    },
    onLocate: () => navigator.geolocation?.getCurrentPosition((p) => mapRef.current?.easeTo({ center: [p.coords.longitude, p.coords.latitude], zoom: Math.max(view.zoom, 17) }), () => {}, { enableHighAccuracy: true, timeout: 10_000 }),
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
      : sel.kind === 'building' ? { kind: 'building', at: sel.at, address: sel.address }
        : {
          kind: 'pin', at: sel.at, near: pinNearHit, onBuilding: !!ringAt(ringsNear(sel.at), sel.at),
          nearState: !online && !pinHit ? 'offline' : !pinHit ? 'loading' : pinNearHit ? 'ok' : 'none',
        }
  const onMapSurface = !openDoc
  /** the panel is on screen: on the map, not under Messen, and on a phone not under a tool's own
   *  card nor pushed away */
  const panelShown = onMapSurface && !!panelSel && tool !== 'measure' && !(phone && (tool === 'erg' || tool === 'layers' || sheetShut || searchOpen))
  const railShown = !phone && !!selObj && docs.length > 0
  const tabletTools = [
    { id: 'pin', icon: 'pin', label: C.tools.pin },
    { id: 'measure', icon: 'measure', label: C.tools.measure },
    { id: 'erg', icon: 'warn', label: C.tools.erg },
  ]
  const approxAt = sel?.kind === 'object' && selObj && !coordOf(selObj) ? sel.approxAt ?? null : null

  // ── which objects carry their name tag (lib/karte/labels) ─────────────────────────────────
  // One greedy pass once the map has settled (`view` moves on moveend), again when what covers
  // the map changes (panel, sheet, search, a tool), and once more after a panel has slid in.
  const rootRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const sizes = useRef(new Map<string, { w: number; h: number }>())
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
  const covered = `${!!panelSel}|${sheetShut}|${tool}|${searchOpen}|${sheetOpen}|${!!openDoc}|${railShown}`
  useEffect(() => {
    if (!objectsOn) return
    let alive = true
    /** a tag's real size: the off-screen twin measured once per name (jsdom: an estimate) */
    const size = (name: string, n: number) => {
      const key = `${name}|${n}`
      const hit = sizes.current.get(key)
      if (hit) return hit
      const el = measureRef.current
      let box = { w: 0, h: 0 }
      if (el) {
        el.firstChild!.textContent = name
        ;(el.lastChild as HTMLElement).style.display = n > 0 ? '' : 'none'
        ;(el.lastChild as HTMLElement).textContent = String(n)
        const r = el.getBoundingClientRect()
        box = { w: Math.ceil(r.width), h: Math.ceil(r.height) }
      }
      if (!box.w) box = tagSize(name.length * 7, n)
      sizes.current.set(key, box)
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
        const zoom = map.getZoom()
        const cands: TagCandidate[] = []
        for (const o of objects) {
          const at = coordOf(o)
          if (!at || (catOff(o.id) && o.id !== selId)) continue
          if (o.kind === 'depot') {
            // the key box's FKS symbol is not covered by a tag
            const p = map.project(at)
            const k = symPx('symbol', at[1], zoom) / 2
            occupied.push({ left: p.x - k, top: p.y - k, right: p.x + k, bottom: p.y + k })
            continue
          }
          const a = anchors.get(o.id) ?? { at, under: false }
          const p = map.project(a.at)
          const n = openableCount(o)
          const { w, h } = size(o.name, n)
          cands.push({
            id: o.id, x: p.x, y: p.y, anchor: a.under ? 'top' : 'center', offsetY: TAG_GAP, w, h,
            rank: tagRank({ kind: o.kind, plans: n, selected: o.id === selId, wasShown: !!taggedRef.current?.has(o.id) }),
          })
        }
        next = placeTags(cands, { width: box.width, height: box.height, occupied, always: selId })
      }
      if (samePlacement(taggedRef.current, next)) return
      taggedRef.current = next
      setTagged(next)
    }
    const raf = requestAnimationFrame(run)
    const t = setTimeout(run, 400)
    return () => { alive = false; cancelAnimationFrame(raf); clearTimeout(t) }
  }, [view, objects, anchors, selId, objectsOn, covered, phone, resized, catOff])

  return (
    <KeyBoxSvg.Provider value={sym.byName[KEY_BOX_SYMBOL] ?? ''}>
      <div data-karte="" ref={rootRef} className={cx('app mode-map', s.root, phone && s.phone, phone && 'phone-tools')}>
        <IconSprite />
        {/* the name tag's off-screen twin: what a tag measures before it is placed */}
        <span ref={measureRef} className={cx(s.tagMk, s.measure)} aria-hidden><span /><span className={s.tagCount} /></span>
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
          preparedOverlays={overlays}
          isVisible={isVisible}
          selectedId={selObj?.kind === 'depot' ? `karte:${selObj.id}` : null}
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
          onSettled={() => { flyPending(); loadOutlines() }}
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
            const pick = (e: React.MouseEvent) => { e.stopPropagation(); selectObject(o.id, false) }
            const isSel = selObj?.id === o.id
            if (catOff(o.id) && !isSel) return null
            // the category's colour (lib/karte/categories); none = the default red, untouched
            const cat = cats.get(o.id)
            const catStyle = cat ? ({ '--cat': cat.color, '--cat-ink': inkOn(cat.color) } as React.CSSProperties) : undefined
            if (o.kind === 'depot') {
              if (tagZoom) return null // MapView draws the FKS symbol (entities above)
              return (
                <Marker key={`dot:${o.id}`} longitude={at[0]} latitude={at[1]} anchor="center" style={{ zIndex: 1 }}>
                  <button type="button" className={cx(s.dotMk, s.keyDot, cat && s.cat)} style={catStyle} aria-label={o.name} title={o.name} onClick={pick}><KeyBoxGlyph /></button>
                </Marker>
              )
            }
            if (!isSel && !(tagZoom && tagged?.has(o.id))) {
              return (
                <Marker key={`dot:${o.id}`} longitude={at[0]} latitude={at[1]} anchor="center" style={{ zIndex: 1 }}>
                  <button type="button" className={cx(s.dotMk, cat && s.cat)} style={catStyle} aria-label={o.name} title={o.name} onClick={pick} />
                </Marker>
              )
            }
            const n = openableCount(o)
            const a = anchors.get(o.id) ?? { at, under: false }
            const dx = (!isSel && tagged?.get(o.id)) || 0
            return (
              <Marker key={`tag:${o.id}`} longitude={a.at[0]} latitude={a.at[1]} anchor={a.under ? 'top' : 'center'} offset={[dx, a.under ? TAG_GAP : 0]} style={{ zIndex: isSel ? 3 : 2 }}>
                <button type="button" className={cx(s.tagMk, isSel && s.sel, cat && s.cat)} style={catStyle} onClick={pick}>
                  {o.name}{n > 0 && <span className={s.tagCount}>{n}</span>}
                </button>
              </Marker>
            )
          })}
          {approxAt && selObj && (
            <Marker longitude={approxAt[0]} latitude={approxAt[1]} anchor="center">
              <span className={cx(s.tagMk, s.approx, s.sel)}>{C.approxTag} · {selObj.name}</span>
            </Marker>
          )}
          {sel?.kind === 'pin' && (
            // the pin is the place: a tap on it brings back the sheet that was pushed away
            <Marker longitude={sel.at[0]} latitude={sel.at[1]} anchor="bottom" onClick={(e) => { e.originalEvent.stopPropagation(); setSheetShut(false) }}>
              <svg className={s.pinMk} viewBox="0 0 34 44" aria-hidden><path d="M17 43C17 43 3 26 3 16a14 14 0 0 1 28 0c0 10-14 27-14 27z" fill={red} stroke="#fff" strokeWidth="2.5" /><circle cx="17" cy="16" r="5" fill="#fff" /></svg>
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

        {/* the bar: NO title (owner, 16.10.2026) — Einsätze · search · weather · the running Einsatz */}
        <div className="topbar" ref={barRef}>
          <button type="button" className={cx(s.einsaetze, sheetOpen && s.open)} onClick={() => { setSheetOpen((o) => !o); setSearchOpen(false) }}
            title={C.einsaetzeTitle} aria-haspopup="dialog" aria-expanded={sheetOpen}>
            <Icon id="flag" />
            <span className={s.einsaetzeText}>{C.einsaetze}{!phone && <small>{!running.length ? C.einsaetzeNone : running.length === 1 ? C.einsaetzeOne : fillTemplate(C.einsaetzeMany, { n: running.length })}</small>}</span>
            <Icon id="chevron-down" className={s.chev} />
            {einsaetze.badge > 0 && <span className={s.einsaetzeBadge} aria-label={fillTemplate(C.einsaetzeBadge, { n: einsaetze.badge })}>{einsaetze.badge}</span>}
          </button>
          {!phone && (
            <SearchField
              {...typingFieldProps('search', 'karte')}
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
            <button type="button" className={s.offChip} onClick={() => setDeviceOpen(true)} title={C.offlineChipTitle} aria-label={C.offlineChipTitle}>
              <span className={s.offDot} aria-hidden />{!phone && C.offlineChip}
            </button>
          ) : !phone && liveWeather.data?.wind_dir_deg != null && <WeatherBadge weather={liveWeather.data} bearing={view.bearing} />}
          {!phone && runningChip}
          {phone && (
            <button type="button" className={cx(s.searchBtn, searchOpen && s.open)} onClick={() => (searchOpen ? setSearchOpen(false) : openPhoneSearch())}
              aria-label={C.searchOpen} title={C.searchOpen} aria-expanded={searchOpen} data-karte-search-open="">
              <Icon id="search" />
            </button>
          )}
          {/* the app menu, hung off the bar as the Einsatz menu hangs off its own (13-incident ·
              .ip-menu) — the same rows (panels/AppMenuRows), without the Einsatz card */}
          {sheetOpen && (
            <div className="ip-menu ip-einsaetze" role="dialog" aria-label={C.einsaetze}>
              {einsaetze.render(closeSheet, openDevice)}
            </div>
          )}
        </div>
        {/* the strip stands where the «Einsätze» sheet hangs — and the sheet lists the same Einsatz */}
        {phone && live && !sheetOpen && <div className={s.runningStrip}>{runningChip}</div>}

        {searchOpen && !phone && (
          <KarteSearch query={query} hits={hits} featured={featured} addresses={addrState === 'ok' ? addr.list : []} addrState={addrState}
            onPickObject={(id) => { setQuery(byId.get(id)?.name ?? ''); selectObject(id) }} onPickAddress={pickAddress} />
        )}
        {searchOpen && phone && (
          <KarteKeySheet
            label={C.searchOpen}
            onClose={() => setSearchOpen(false)}
            field={(
              <SearchField
                {...typingFieldProps('search', 'karte')}
                ref={sheetFieldRef} className={s.keyField} noClear value={query}
                onChange={setQuery}
                onKeyDown={(e) => { if (e.key === 'Escape') setSearchOpen(false); else if (e.key === 'Enter') e.currentTarget.blur() }}
                placeholder={defuseAutofill(C.searchPlaceholderShort)}
                aria-label={defuseAutofill(C.searchPlaceholder)}
              />
            )}
          >
            <KarteSearch inSheet query={query} hits={hits} featured={featured} addresses={addrState === 'ok' ? addr.list : []} addrState={addrState}
              onPickObject={(id) => { setQuery(byId.get(id)?.name ?? ''); selectObject(id) }} onPickAddress={pickAddress} />
          </KarteKeySheet>
        )}

        {railShown && selObj && (
          <KarteNavRail obj={selObj} docs={docs} active={openDoc?.doc.id ?? null} onMap={() => setSurface(null)} onDoc={(id) => { setSurface(id); setToolState(null) }}
            notHeld={!online ? new Set(docs.filter((d) => docHeld(d) === false).map((d) => d.doc.id)) : null} />
        )}

        {panelShown && panelSel && (
          <KartePanel
            sel={panelSel}
            register={register}
            nearby={nearby}
            hydrants={nearHydrants}
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

        {/* the phone: Karte · Messen · Gefahrgut · Ebenen at the foot, pin + compass above it. No
            «Pläne» tab (owner, 17.10.2026): an object's plans are rows in its sheet, and an open
            plan goes back with its «Zur Karte» chip or the Karte tab */}
        {phone && (
          <>
            <nav className="navrail rail folded labelled" aria-label={C.title}>
              <div className="rail-scroll-wrap"><div className="nav-scroll rail-scroll">
                <button type="button" className={cx('nav-item', onMapSurface && !tool && 'on')} onClick={() => { setSurface(null); setToolState(null) }}>
                  <span className="nav-glyph"><Icon id="map" /></span><span className="nav-label">{C.tools.map}</span>
                </button>
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

        {tool === 'pin' && (
          <div className={s.hintBar} role="status"><Icon id="pin" /><span>{C.pinHint}</span></div>
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

        {cat?.failed && !cat.data && (
          <div className={s.hintBar} role="status"><Icon id="warn" /><span>{online ? C.loadFailed : C.noCatalogue}</span></div>
        )}

        {noBasemap && !online && (
          <NoBasemapMeldung sub={C.basemapSub} actionLabel={C.basemapAction}
            onOpenOffline={() => { setNoBasemap(false); setDeviceOpen(true) }} onDismiss={() => setNoBasemap(false)} />
        )}
        {deviceOpen && (
          <KarteDevice offline={!online} objects={objects} map={coverage === 'far' ? 'far' : coverage ? { held: coverage.held, total: coverage.total } : null} onClose={() => setDeviceOpen(false)} />
        )}
      </div>
    </KeyBoxSvg.Provider>
  )
}
