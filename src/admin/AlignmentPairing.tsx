import { useEffect, useMemo, useRef, useState } from 'react'
import Map, { Source, Layer, NavigationControl, type MapRef } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import '../lib/maplibreWorker'
import { QuietAttributionControl } from '../components/MapAttribution'
import { GeorefBoardLayer, GeorefInstrument, type PlanViewApi } from '../components/GeorefMode'
import { GeorefCheckOutline, GeorefMapLoupe, GeorefMapMarks } from '../components/GeorefMapLayer'
import { PdfViewport } from '../components/PdfViewport'
import { useBoardView } from '../components/useBoardView'
import { appConfig } from '../config/appConfig'
import { adminGeorefKey, registerAdminGeoref } from '../lib/adminGeorefSink'
import { referenceUrl } from '../lib/api/reference'
import { cartoRasterTiles } from '../lib/carto'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import type { GeorefPair } from '../lib/georef'
import { georefDispatch, georefWantsMap, startGeorefMode, useGeorefMode, useGeorefStorage } from '../lib/georefMode'
import { alignmentBounds } from '../lib/planAlignmentReview'
import { planUrl, withPdfPage } from '../lib/whiteboard'
import type { LayerDef } from '../types'
import type { AlignmentItem } from './planAlignmentApi'

/** Aligning by hand in the admin = the FIELD's «Karte verknüpfen», not a copy of it: the same
 *  pairing mode (lib/georefMode), the same crosses, loupe and capture on the sheet
 *  (GeorefBoardLayer), the same marks and loupe on the map (GeorefMapLayer), the same
 *  instrument. The only thing that differs is where the pairs go: an `admin:` key routes the
 *  mode's writes into this modal's draft (adminGeorefSink), and nothing is stored until
 *  «Ausrichtung freigeben». The plan half needs a small board of its own — the field's board is
 *  the Whiteboard — so this file carries just enough of one: fit, pan, wheel zoom.
 *
 *  ⚠️ The instrument sits BELOW the split here (15.09.2026), not above it: in a full-screen
 *  editor the bar is the row of decisions you reach for after looking at both halves, and above
 *  them it pushed the sheet and the map down a bar's height for nothing. The FIELD keeps its own
 *  placement – there the same component is `position: fixed` at the foot of the screen. */
export default function AlignmentPairing({ item, pairs, onPairs, onDone, onReset, previewUrl }: {
  item: AlignmentItem
  /** the draft's real pairs — what the mode is seeded with and writes back to */
  pairs: GeorefPair[]
  onPairs: (pairs: GeorefPair[]) => void
  /** the instrument's «Fertig» / «Schliessen» (or Esc) ended the mode – the modal then shows
   *  the result as the field would: the sheet laid on the map */
  onDone: () => void
  /** «Zurücksetzen» in the bar. Here the pairs are a DRAFT, so resetting means throwing that
   *  draft away and going back to what stands on the server – the editor's old footer button
   *  «Anpassung verwerfen», now that there is no footer to hold it. The field's own reset
   *  (delete every point, behind a confirm) is what happens when this is not given. */
  onReset: () => void
  /** the exact page raster, for «Deckung prüfen» on the map — the modal mounts this only once
   *  it has one, so the mode starts with it */
  previewUrl: string
}) {
  const C = appConfig.copy.admin.alignment
  const aspect = item.aspect && Number.isFinite(item.aspect) && item.aspect > 0 ? item.aspect : 1.414
  const storageKey = adminGeorefKey(item.id)
  const mode = useGeorefMode()
  useGeorefStorage()
  const armed = mode.planId != null && mode.storageKey === storageKey
  const wasArmed = useRef(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  useEffect(() => {
    if (armed) wasArmed.current = true
    else if (wasArmed.current) { wasArmed.current = false; onDoneRef.current() }
  }, [armed])

  // The draft is the mode's home for this key. Registered before the mode starts (the start
  // reads the pairs through the same lookup), forgotten when the modal goes.
  const pairsRef = useRef(pairs)
  pairsRef.current = pairs
  const onPairsRef = useRef(onPairs)
  onPairsRef.current = onPairs
  useEffect(() => {
    // seeded with EVERYTHING that stands, the proposal's automatic anchors included: they show
    // as the field's ghosted «A» crosses and step aside once two real points are set (settleSlots)
    const unregister = registerAdminGeoref(storageKey, { pairs: () => pairsRef.current, save: p => onPairsRef.current(p) })
    // `inset`: the sheet and the map stand side by side here, so BOTH halves wear the same
    // magnifier – an inset in the corner of the pane being aimed at, never two different ones
    startGeorefMode(item.module ?? 'modul2', aspect, { storageKey, previewUrl, loupe: 'inset' })
    return () => { georefDispatch({ type: 'dismiss' }); unregister() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, item.module, aspect])

  /** the bar's «Zurücksetzen»: the draft goes, and the mode is started again over the pairs that
   *  stand. ⚠️ `pairsRef` is written first – the restart reads the draft through the same sink
   *  lookup, in this tick, long before the parent's state change reaches us as a new `pairs`. */
  const resetDraft = () => {
    pairsRef.current = item.pairs
    onReset()
    startGeorefMode(item.module ?? 'modul2', aspect, { storageKey, previewUrl, loupe: 'inset' })
  }

  // ── the plan half: a board of its own (fit → pan → wheel zoom), the field's layer on top ──
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null)
  const boardRef = useRef<HTMLDivElement | null>(null)
  const [vp, setVp] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => setVp({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])
  const fit = useMemo(() => {
    if (!vp.w || !vp.h) return { w: 0, h: 0 }
    const byW = { w: vp.w, h: vp.w / aspect }
    return byW.h <= vp.h ? byW : { w: vp.h * aspect, h: vp.h }
  }, [vp, aspect])
  const { scale, pos, scaleRef, posRef, applyView, zoomTo } = useBoardView(canvasRef, canvasEl)
  const sW = fit.w * scale, sH = fit.h * scale
  const toNorm = (clientX: number, clientY: number): [number, number] | null => {
    const r = boardRef.current?.getBoundingClientRect()
    if (!r || !r.width) return null
    return [(clientX - r.left) / r.width, (clientY - r.top) / r.height]
  }
  const view: PlanViewApi = { toNorm, applyView, zoomTo, scaleRef, posRef, canvasEl, boardRef }
  // pan: a drag anywhere on the stage moves the sheet; the capture layer's own tap detection
  // keeps a still press a placement (it watches the same pointer)
  const pan = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null)
  const panDown = (e: React.PointerEvent) => { pan.current = { x: e.clientX, y: e.clientY, px: posRef.current.x, py: posRef.current.y, moved: false } }
  const panMove = (e: React.PointerEvent) => {
    const st = pan.current
    if (!st) return
    const dx = e.clientX - st.x, dy = e.clientY - st.y
    if (!st.moved && Math.hypot(dx, dy) > 8) st.moved = true
    if (st.moved) applyView(scaleRef.current, { x: st.px + dx, y: st.py + dy })
  }
  const panUp = () => { pan.current = null }

  // ── the map half: the review's map with the field's marks, loupe and check outline ──
  const mapRef = useRef<MapRef>(null)
  const [mapInst, setMapInst] = useState<ReturnType<MapRef['getMap']> | null>(null)
  const aimRef = useRef<{ lng: number; lat: number } | null>(null)
  const bounds = useMemo(() => alignmentBounds(item.reference_rings, pairs), [item.reference_rings, pairs])
  const hasCarto = !!getDeploymentConfig().integrations?.cartoBasemapKey
  const tiles = useMemo(() => hasCarto ? cartoRasterTiles('rastertiles/voyager') : ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], [hasCarto])
  const style = useMemo(() => ({
    version: 8 as const,
    sources: { base: { type: 'raster' as const, tiles, tileSize: 256, maxzoom: hasCarto ? 20 : 19, attribution: hasCarto ? '© CARTO, © OpenStreetMap contributors' : '© OpenStreetMap contributors' } },
    layers: [{ id: 'base', type: 'raster' as const, source: 'base' }],
  }), [hasCarto, tiles])
  // the loupe crops the base tiles itself; it only needs to know which template the map shows
  const loupeLayers = useMemo<LayerDef[]>(() => [{ id: 'base', group: 'base', label: 'Basiskarte', icon: 'map', base: true, visible: true, tiles, maxzoom: hasCarto ? 20 : 19 }], [tiles, hasCarto])
  const geometry = useMemo(() => ({
    type: 'FeatureCollection' as const, features: item.reference_rings.filter(ring => ring.length >= 3).map(ring => {
      const coords = ring.map(p => [p.lng, p.lat])
      return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...coords, coords[0]]] } }
    }),
  }), [item.reference_rings])
  useEffect(() => { if (mapInst && bounds) mapInst.fitBounds(bounds, { padding: 45, maxZoom: 19, duration: 0 }) }, [mapInst, bounds])
  const mapTurn = armed && georefWantsMap(mode)
  /**
   * Is the pointer on the MAP half right now? ⚠️ ONE loupe at a time (15.09.2026): here the sheet
   * and the map stand side by side under one pointer, and the map's magnifier used to be up for
   * the whole mode — so it stood open beside the sheet's, crosshairs and all, over a place nobody
   * was pointing at. The field asks the same two questions (MapView): whose turn it is (`want`,
   * which the hover below sets) and whether this surface is the one being aimed at.
   * ⚠️ Only a HOVERING pointer takes it back down: a touch pointer is destroyed at every lift,
   * and there the last thing tapped is what is being worked on — as on the sheet (GeorefMode · leave).
   */
  const [mapAimed, setMapAimed] = useState(false)
  const mapPoint = () => {
    if (!mapTurn) return
    setMapAimed(true)
    if (mode.want !== 'map') georefDispatch({ type: 'goMap' })
  }
  const mapLeave = (e: React.PointerEvent) => { if (e.pointerType !== 'touch') setMapAimed(false) }

  return <div className="adm-pairing">
    <div className={`adm-pairing-panes${mode.check ? ' checking' : ''}`}>
      <div className="wb-stage adm-pairing-plan" ref={stageRef} aria-label={C.planPreview}>
        <div ref={el => { canvasRef.current = el; setCanvasEl(el) }} className="wb-canvas tool-pan"
          onPointerDownCapture={panDown} onPointerMoveCapture={panMove} onPointerUpCapture={panUp} onPointerCancelCapture={panUp}>
          <div ref={boardRef} className="wb-board" style={{ width: sW || undefined, height: sH || undefined, transform: `translate(-50%, -50%) translate(${pos.x}px, ${pos.y}px)` }}>
            {fit.w > 0 && <PdfViewport key={item.dataset_id + item.plan_version} url={planUrl(item.page_count && item.page_count > 1 ? withPdfPage(referenceUrl(item.dataset_id, item.plan_version), item.page) : referenceUrl(item.dataset_id, item.plan_version))} /* a pack's fit is measured on ONE page – show that page, not the stitched document */ fitW={fit.w} fitH={fit.h} scale={scale} pos={pos} vw={vp.w} vh={vp.h} onAspect={() => {}} />}
            {armed && <GeorefBoardLayer pairs={pairs} mode={mode} armed sW={sW} sH={sH} view={view} />}
          </div>
        </div>
      </div>
      <div className={`adm-align-map adm-pairing-map${mapTurn ? ' adm-align-turn' : ''}`} aria-label={C.mapPreview}
        onPointerEnter={mapPoint} onPointerMove={mapPoint} onPointerDown={mapPoint}
        onPointerLeave={mapLeave} onPointerCancel={mapLeave}>
        <Map ref={mapRef} mapStyle={style} initialViewState={bounds
            ? { longitude: (bounds[0][0] + bounds[1][0]) / 2, latitude: (bounds[0][1] + bounds[1][1]) / 2, zoom: 16 }
            // no reference rings (an unsupported module, an unfitted sheet): start at the OBJECT, not over the whole country
            : item.object_lng != null && item.object_lat != null ? { longitude: item.object_lng, latitude: item.object_lat, zoom: 17 }
            : { longitude: 8.2275, latitude: 46.8182, zoom: 7 }}
          attributionControl={false} onLoad={() => setMapInst(mapRef.current?.getMap() ?? null)}
          // Use the same canvas/transform-aware coordinates for aiming and placing.
          // (whose turn it is follows the POINTER, on the pane itself – see `mapPoint`)
          onMouseMove={e => { aimRef.current = { lng: e.lngLat.lng, lat: e.lngLat.lat } }}
          onClick={e => { if (mapTurn) georefDispatch({ type: 'mapTap', lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat } }) }}
          cursor={mapTurn ? 'crosshair' : 'grab'}>
          <QuietAttributionControl /><NavigationControl position="top-right" />
          <Source id="admin-align-buildings" type="geojson" data={geometry}><Layer id="admin-align-buildings-layer" type="line" paint={{ 'line-color': '#1f6feb', 'line-width': 2 }} /></Source>
          {armed && !mode.check && <GeorefMapMarks mode={mode} map={mapInst} />}
          {armed && <GeorefCheckOutline mode={mode} map={mapInst} />}
          {mapTurn && mode.want === 'map' && mapAimed && <GeorefMapLoupe map={mapInst} layers={loupeLayers} isVisible={() => true} night={false} atRef={aimRef} />}
        </Map>
        {/* ⚠️ Fehlende Gebäudeumrisse werden NICHT gemeldet (15.09.). Sie entstehen allein im
            Matcher-Lauf (app/plan_alignment_compute · match), also hat jedes Blatt, das hier von
            Hand ausgerichtet wird – Modul 5/6, Geschosspakete, «alignment: manual», jedes Objekt
            ohne gedruckten Massstab – von Haus aus keine. Der bernsteinfarbene Balken stand
            deshalb praktisch immer da und riet zu dem, was man ohnehin gerade tut. Die blauen
            Umrisse sind eine Zugabe, wenn sie da sind; ihr Fehlen ist kein Zustand. */}
      </div>
    </div>
    {/* below the split, where the decisions are made – see the note at the top of this file */}
    {armed && <GeorefInstrument mode={mode} inline onReset={resetDraft} />}
  </div>
}
