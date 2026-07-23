import { useMemo, useRef, useState } from 'react'
import Map, { Layer, Marker, Source, type MapRef } from 'react-map-gl/maplibre'
import type { Map as MapLibreMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Icon } from '../lib/icons'
import { Overlay } from '../lib/overlays'
import { appConfig } from '../config/appConfig'
import { operationalExtentPoints } from '../lib/report'
import { circlePolygon } from '../lib/geo'
import { TacticalSymbol } from '../lib/symbolRender'
import { ShapeGlyph } from '../lib/shapes'
import { krokiEntity, krokiSymbolMul } from '../lib/krokiPayload'
import { shapePx, symPx } from '../lib/mapView'
import type { Drawing, Entity, LayerDef, LngLat } from '../types'
import type { KrokiView } from '../lib/report'

// WYSIWYG framing step before PDF / Ausdrucken: the auto-fit (or the last chosen crop) is
// just the STARTING point — the operator pans/zooms and exactly this crop becomes the
// printed Kroki. Preview-grade rendering: real glyphs at a fixed small size + plain
// drawing geometry; the server render stays the source of truth for the final look.

const FIT_MAX_ZOOM = 20 // mirror of the server's fit_view max_z
const CARTO_FALLBACK = 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'
// backend/app/kroki.py renders print overlays against this reference viewport. Scaling the
// complete decorated marker (not only its glyph) makes badges/spreads/shapes WYSIWYG here.
const PRINT_REF_WIDTH = 1050

export function KrokiFramingModal({ scene, initial, onCancel, onConfirm }: {
  scene: { entities: Entity[]; drawings: Drawing[]; layers: LayerDef[]; byName: Record<string, string>; center: LngLat }
  /** a previously chosen crop — reopens where the operator left it */
  initial: KrokiView | null
  onCancel: () => void
  onConfirm: (view: KrokiView) => void
}) {
  const P = appConfig.copy.preflight
  const mapRef = useRef<MapRef>(null)
  const [previewZoom, setPreviewZoom] = useState(initial?.zoom ?? 16)
  const [previewWidth, setPreviewWidth] = useState(720)
  const printScale = previewWidth / PRINT_REF_WIDTH

  // same base-layer pick as buildKrokiPayload, so the preview shows the printed basemap
  const base = scene.layers.find((l) => l.base && l.visible && l.tiles?.length) ?? scene.layers.find((l) => l.base && l.tiles?.length)
  const style = useMemo(() => ({
    version: 8 as const,
    sources: { base: { type: 'raster' as const, tiles: base?.tiles?.length ? [base.tiles[0]] : [CARTO_FALLBACK], tileSize: 256, maxzoom: base?.maxzoom } },
    layers: [{ id: 'base', type: 'raster' as const, source: 'base' }],
  }), [base])

  const layerVisible = (id: string) => scene.layers.find((l) => l.id === id)?.visible ?? true
  const drawingsVisible = layerVisible(appConfig.defaults.drawingLayerId)
  const shown = scene.entities.filter((e) => Array.isArray(e.coord) && layerVisible(e.layer))

  const bounds = useMemo(() => {
    const pts = operationalExtentPoints(scene.center, scene.entities, drawingsVisible ? scene.drawings : [], false)
    const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1])
    return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]] as [[number, number], [number, number]]
  }, [scene, drawingsVisible])

  const geojson = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: (drawingsVisible ? scene.drawings : []).filter((d) => Array.isArray(d.coords) && d.coords.length).map((d) => ({
      type: 'Feature' as const,
      properties: { color: d.color ?? appConfig.drawing.defaultColor, area: d.kind !== 'line' },
      geometry: d.kind === 'circle' && d.radiusM
        ? { type: 'Polygon' as const, coordinates: circlePolygon(d.coords[0], d.radiusM) }
        : d.kind === 'area'
          ? { type: 'Polygon' as const, coordinates: [[...d.coords, d.coords[0]]] }
          : { type: 'LineString' as const, coordinates: d.coords },
    })),
  }), [scene.drawings, drawingsVisible])

  const fit = () => mapRef.current?.getMap().fitBounds(bounds, { padding: 48, maxZoom: FIT_MAX_ZOOM })
  const syncView = (m: MapLibreMap) => {
    setPreviewZoom(m.getZoom())
    setPreviewWidth(m.getContainer().clientWidth)
  }
  const confirm = () => {
    const m = mapRef.current?.getMap()
    if (!m) return
    const c = m.getCenter()
    const b = m.getBounds()
    onConfirm({
      center: [c.lng, c.lat],
      zoom: m.getZoom(),
      bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    })
  }

  return (
    // Base UI Overlay portals to <body> (like the old createPortal): inside `.app` the mode-scoped
    // `.maplibregl-map { visibility: hidden }` rules (Plan / phone non-map modes) would blank the
    // preview canvas. Opens OVER the Rapport sheet (mp z-index 120 > ip 80); full `modal` makes the
    // Rapport behind it inert until framing is dismissed, and the preview map (inside the popup)
    // stays fully interactive for pan/zoom.
    <Overlay open onClose={onCancel} className="mp-sheet kf-sheet ui-dialog" backdropClassName="mp-backdrop" ariaLabel={P.framingTitle} modal>
        <div className="mp-head">
          <span>{P.framingTitle}</span>
          <button className="ip-x" onClick={onCancel} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
        </div>
        <div className="mp-map kf-map">
          <Map
            ref={mapRef}
            initialViewState={initial
              ? { longitude: initial.center[0], latitude: initial.center[1], zoom: initial.zoom }
              : { bounds, fitBoundsOptions: { padding: 48, maxZoom: FIT_MAX_ZOOM } }}
            mapStyle={style}
            dragRotate={false}
            pitchWithRotate={false}
            touchPitch={false}
            attributionControl={false}
            onLoad={(e) => { e.target.touchZoomRotate.disableRotation(); syncView(e.target) }}
            onMove={(e) => { setPreviewZoom(e.viewState.zoom) }}
            onResize={(e) => syncView(e.target)}
          >
            <Source id="draws" type="geojson" data={geojson}>
              <Layer id="draw-fill" type="fill" filter={['==', ['get', 'area'], true]} paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': 0.14 }} />
              <Layer id="draw-line" type="line" paint={{ 'line-color': ['get', 'color'], 'line-width': 2.5 }} />
            </Source>
            {shown.map((e) => (
              <Marker key={e.id} longitude={e.coord[0]} latitude={e.coord[1]} anchor="center">
                {(() => {
                  const printable = krokiEntity(e, scene.byName)
                  if (!printable) return null
                  if (e.kind === 'shape') {
                    const size = shapePx(e.sizeM, e.coord[1], previewZoom)
                    return (
                      <div className="kf-print-box" style={{ width: size * printScale, height: size * printScale }}>
                        <div className="kf-print-inner kf-glyph" style={{ width: size, height: size, transform: `translate(-50%, -50%) scale(${printScale}) rotate(${e.rotation ?? 0}deg)` }}>
                          <ShapeGlyph kind={e.shape ?? 'square'} color={e.color ?? '#1f6feb'} />
                        </div>
                      </div>
                    )
                  }
                  if (!printable.symbolSvg && !printable.symbol) {
                    return printable.caption ? <span className={`kf-plain ${e.kind}`}>{printable.caption}</span> : null
                  }
                  const svg = printable.symbolSvg ?? scene.byName[printable.symbol ?? ''] ?? ''
                  const size = symPx(e.kind, e.coord[1], previewZoom, krokiSymbolMul(previewZoom))
                  return (
                    <div className="kf-print-box" style={{ width: size * printScale, height: size * printScale }}>
                      <div className="kf-print-inner" style={{ transform: `translate(-50%, -50%) scale(${printScale})` }}>
                        <TacticalSymbol
                          svg={svg}
                          sizePx={size}
                          rotation={printable.rotation ?? 0}
                          floor={printable.floor}
                          floorFrom={printable.floorFrom}
                          floorTo={printable.floorTo}
                          spread={printable.spread}
                          count={printable.count}
                          caption={printable.caption}
                        />
                      </div>
                    </div>
                  )
                })()}
              </Marker>
            ))}
          </Map>
          <div className="kf-hint">{P.framingHint}</div>
        </div>
        <div className="mp-act">
          <button className="ip-btn kf-fit" onClick={fit}><Icon id="cross" /> {P.framingFit}</button>
          <button className="ip-btn" onClick={onCancel}>{appConfig.copy.cancel}</button>
          <button className="ip-btn primary" onClick={confirm}><Icon id="check" /> {P.framingConfirm}</button>
        </div>
    </Overlay>
  )
}
