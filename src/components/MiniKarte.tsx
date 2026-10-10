import { useEffect, useMemo, useRef, useState } from 'react'
import Map, { Layer, Source, type MapRef } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import { appConfig } from '../config/appConfig'
import { EMPTY_STYLE, fc, lineFeat, polyFeat } from '../lib/mapView'
import { LINE_DASH_ML } from '../lib/draw'
import { DEFAULT_INK } from '../lib/lineStyle'
import { circlePolygon } from '../lib/geo'
import { operationalExtentPoints } from '../lib/report'
import { MapImages } from './MapImages'
import { MapLayers } from './MapLayers'
import { MapMarkers } from './MapMarkers'
import type { CaptionMode, Drawing, Entity, LayerDef, LayerId, LngLat, Trupp } from '../types'

/**
 * The «Lagekarte» box of a Tafel page (owner, 10.10.2026): a small, READ-ONLY, live view of the
 * Einsatz-Karte — the same base and reference layers (MapLayers), the same point-symbol images
 * (MapImages), the same placed objects (MapMarkers) and the drawings in their own colours —
 * framed on what the Einsatz has placed. A tap on the box opens the Karte (TafelFormPage).
 *
 * ⚠️ Cheap on purpose: a second MapLibre instance exists only while a page with a map box is ON
 * SCREEN (this chunk is lazy, the component unmounts with the page), it takes no input at all
 * (`interactive={false}` — no pan, no zoom, no selection, nothing that could write), and it
 * refits only when the extent of the Lage really moved. It is NOT a second MapView: none of the
 * Karte's editing, GPS or label machinery runs here. The print uses a server-rendered snapshot
 * of the same scene instead (reportPdfDirect · boardMapPayload).
 */
export interface MiniKarteProps {
  entities: Entity[]
  drawings: Drawing[]
  layers: LayerDef[]
  isVisible: (id: LayerId) => boolean
  byName: Record<string, string>
  center: LngLat
  symMul?: number
  captionMode?: CaptionMode
  trupps?: Trupp[]
}

const noop = () => {}

/** the frame: what is placed, else the Einsatzort — rounded so a moving vehicle does not refit */
function frameOf(center: LngLat, entities: Entity[], drawings: Drawing[]) {
  const pts = operationalExtentPoints(center, entities, drawings, false)
  const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1])
  const b: [[number, number], [number, number]] = [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]]
  const key = b.flat().map((x) => x.toFixed(4)).join(',')
  return { bounds: b, single: pts.length < 2 || (b[0][0] === b[1][0] && b[0][1] === b[1][1]), key }
}

export default function MiniKarte({ entities, drawings, layers, isVisible, byName, center, symMul = 1, captionMode = 'off', trupps }: MiniKarteProps) {
  const ref = useRef<MapRef>(null)
  const [ready, setReady] = useState(false)
  const [zoom, setZoom] = useState(17)
  const frame = useMemo(() => frameOf(center, entities, drawings), [center, entities, drawings])

  useEffect(() => {
    const m = ref.current
    if (!m || !ready) return
    try {
      m.resize()
      if (frame.single) m.jumpTo({ center: frame.bounds[0], zoom: 17 })
      else m.fitBounds(frame.bounds, { padding: 28, duration: 0, maxZoom: 18.5 })
    } catch { /* map gone */ }
    // the KEY, not the object: a re-render with the same extent must not jump the view
  }, [frame.key, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  const drawFC = useMemo(() => fc(drawings.filter((d) => Array.isArray(d.coords) && d.coords.length > 0).map((d) => {
    const p = { id: d.id, color: d.color || DEFAULT_INK, width: d.width || 4, dashed: !!d.dashed, fillOpacity: d.fillOpacity ?? 0.14 }
    if (d.kind === 'circle') return polyFeat(circlePolygon(d.coords[0], d.radiusM ?? 0)[0] as LngLat[], p)
    return d.kind === 'area' && d.coords.length >= 3 ? polyFeat(d.coords, p) : lineFeat(d.coords, p)
  })), [drawings])
  const drawingsOn = isVisible(appConfig.defaults.drawingLayerId)
  const vis = drawingsOn ? 'visible' : 'none'

  return (
    <Map
      ref={ref}
      interactive={false}
      attributionControl={false}
      mapStyle={EMPTY_STYLE}
      initialViewState={{ longitude: center[0], latitude: center[1], zoom: 17 }}
      maxZoom={21}
      style={{ position: 'absolute', inset: 0 }}
      onLoad={() => setReady(true)}
      onMoveEnd={(e) => setZoom(e.viewState.zoom)}
    >
      <MapImages layers={layers} byName={byName} />
      <MapLayers layers={layers} preparedOverlays={[]} isVisible={isVisible} mapReady={ready} />
      <Source id="s-mini-draw" type="geojson" data={drawFC}>
        <Layer id="l-mini-fill" type="fill" filter={['==', ['geometry-type'], 'Polygon']} layout={{ visibility: vis }}
          paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': ['coalesce', ['get', 'fillOpacity'], 0.14] }} />
        <Layer id="l-mini-line" type="line" filter={['!', ['get', 'dashed']]} layout={{ 'line-cap': 'round', 'line-join': 'round', visibility: vis }}
          paint={{ 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] }} />
        <Layer id="l-mini-dash" type="line" filter={['get', 'dashed']} layout={{ 'line-cap': 'butt', 'line-join': 'round', visibility: vis }}
          paint={{ 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-dasharray': LINE_DASH_ML }} />
      </Source>
      {ready && (
        <MapMarkers
          entities={entities}
          byName={byName}
          isVisible={isVisible}
          selectedId={null}
          zoom={zoom}
          symMul={symMul}
          captionMode={captionMode}
          readOnly
          draggable={false}
          project={(c) => { try { const p = ref.current?.project(c); return p ? { x: p.x, y: p.y } : undefined } catch { return undefined } }}
          unproject={() => undefined}
          setDragPan={noop}
          onSelect={noop}
          onMarkerDragStart={noop}
          onMarkerMove={noop}
          onMarkerDragEnd={noop}
          onDelete={noop}
          trupps={trupps}
        />
      )}
    </Map>
  )
}
