import { useEffect, useMemo, useRef, useState } from 'react'
import Map, { Source, Layer, Marker, NavigationControl, type MapRef } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import { QuietAttributionControl } from '../components/MapAttribution'
import { appConfig } from '../config/appConfig'
import { cartoRasterTiles } from '../lib/carto'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { alignmentBounds, alignmentCorners } from '../lib/planAlignmentReview'
import type { GeoPt, GeorefPair, PlanPt } from '../lib/georef'
import { fillTemplate } from '../lib/format'
import type { AlignmentItem } from './planAlignmentApi'

/** The exact PDF raster over its fit; point repair reuses the same map beside the paper. */
export default function AlignmentPreview({ item, pairs, imageUrl, opacity, manual, pendingPoint, onPlanPoint, onMapPoint }: {
  item: AlignmentItem
  pairs: GeorefPair[]
  imageUrl: string
  opacity: number
  manual: boolean
  pendingPoint: PlanPt | null
  onPlanPoint: (point: PlanPt) => void
  onMapPoint: (point: GeoPt) => void
}) {
  const C = appConfig.copy.admin.alignment
  const sourceLabel = item.reference_source?.startsWith('OSM') ? 'OpenStreetMap' : item.reference_source ?? C.referenceUnknown
  const mapRef = useRef<MapRef>(null)
  const [loaded, setLoaded] = useState(false)
  const [mapError, setMapError] = useState(false)
  const [cursor, setCursor] = useState<PlanPt>({ x: .5, y: .5 })
  const corners = useMemo(() => alignmentCorners(pairs, item.aspect ?? 1), [pairs, item.aspect])
  const bounds = useMemo(() => {
    const sheet = alignmentCorners(item.pairs, item.aspect ?? 1)
    return sheet
      ? alignmentBounds([sheet.map(([lng, lat]) => ({ lng, lat }))], [])
      : alignmentBounds(item.reference_rings, item.pairs)
  }, [item.reference_rings, item.pairs, item.aspect])
  const hasCarto = !!getDeploymentConfig().integrations?.cartoBasemapKey
  const style = useMemo(() => ({
    version: 8 as const,
    sources: { base: { type: 'raster' as const,
      tiles: hasCarto ? cartoRasterTiles('rastertiles/voyager') : ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256, maxzoom: hasCarto ? 20 : 19,
      attribution: hasCarto ? '© CARTO, © OpenStreetMap contributors' : '© OpenStreetMap contributors' } },
    layers: [{ id: 'base', type: 'raster' as const, source: 'base' }],
  }), [hasCarto])
  const geometry = useMemo(() => ({
    type: 'FeatureCollection' as const, features: item.reference_rings.filter(ring => ring.length >= 3).map(ring => {
      const coords = ring.map(p => [p.lng, p.lat])
      return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[...coords, coords[0]]] } }
    }),
  }), [item.reference_rings])

  const frame = () => {
    if (bounds) mapRef.current?.fitBounds(bounds, { padding: 45, maxZoom: 19, duration: 0 })
  }
  useEffect(() => { if (loaded && bounds) mapRef.current?.fitBounds(bounds, { padding: 45, maxZoom: 19, duration: 0 }) }, [loaded, bounds])

  const planView = (
    <div className={`adm-align-paper${manual && !pendingPoint ? ' adm-align-turn' : ''}`}>
      <svg viewBox={`0 0 ${item.aspect ?? 1} 1`} role={manual ? 'button' : 'img'} tabIndex={manual ? 0 : undefined}
        aria-label={manual ? C.pickOnPlan : C.planPreview}
        onClick={manual ? e => {
          const point = e.currentTarget.createSVGPoint(); point.x = e.clientX; point.y = e.clientY
          const matrix = e.currentTarget.getScreenCTM()
          if (!matrix) return
          const local = point.matrixTransform(matrix.inverse())
          const p = { x: local.x / (item.aspect ?? 1), y: local.y }
          if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) { setCursor(p); onPlanPoint(p) }
        } : undefined}
        onKeyDown={manual ? e => {
          const delta = e.shiftKey ? .001 : .01
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPlanPoint(cursor); return }
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
          e.preventDefault()
          setCursor(p => ({ x: Math.max(0, Math.min(1, p.x + (e.key === 'ArrowRight' ? delta : e.key === 'ArrowLeft' ? -delta : 0))), y: Math.max(0, Math.min(1, p.y + (e.key === 'ArrowDown' ? delta : e.key === 'ArrowUp' ? -delta : 0))) }))
        } : undefined}>
        <image href={imageUrl} width={item.aspect ?? 1} height="1" preserveAspectRatio="none" />
        {manual && pairs.filter(p => p.kind !== 'auto').map((p, i) => <g key={i}><circle cx={p.plan.x * (item.aspect ?? 1)} cy={p.plan.y} r=".026" fill="white" stroke="#1f6feb" strokeWidth=".007" /><text x={p.plan.x * (item.aspect ?? 1)} y={p.plan.y + .011} textAnchor="middle" fontSize=".03" fontWeight="700" fill="#164d9b">{i + 1}</text></g>)}
        {/* the half-set point: a filled pin on the plan that waits for its partner on the map */}
        {manual && pendingPoint && <g><circle cx={pendingPoint.x * (item.aspect ?? 1)} cy={pendingPoint.y} r=".026" fill="#1f6feb" stroke="white" strokeWidth=".007" /><text x={pendingPoint.x * (item.aspect ?? 1)} y={pendingPoint.y + .011} textAnchor="middle" fontSize=".03" fontWeight="700" fill="white">{pairs.filter(p => p.kind !== 'auto').length + 1}</text></g>}
        {manual && !pendingPoint && <g className="adm-align-crosshair"><circle cx={cursor.x * (item.aspect ?? 1)} cy={cursor.y} r=".02" fill="none" stroke="#1f6feb" strokeWidth=".005" /><line x1={cursor.x * (item.aspect ?? 1) - .03} x2={cursor.x * (item.aspect ?? 1) + .03} y1={cursor.y} y2={cursor.y} stroke="#1f6feb" strokeWidth=".004" /><line x1={cursor.x * (item.aspect ?? 1)} x2={cursor.x * (item.aspect ?? 1)} y1={cursor.y - .03} y2={cursor.y + .03} stroke="#1f6feb" strokeWidth=".004" /></g>}
      </svg>
    </div>
  )

  return <div className={`adm-align-preview${manual ? ' manual' : ''}`}>
    {(manual || !corners) && planView}
    <div className={`adm-align-map${manual && pendingPoint ? ' adm-align-turn' : ''}`} aria-label={C.mapPreview}>
      <Map ref={mapRef} mapStyle={style} initialViewState={{ longitude: bounds ? (bounds[0][0] + bounds[1][0]) / 2 : 8.2275, latitude: bounds ? (bounds[0][1] + bounds[1][1]) / 2 : 46.8182, zoom: bounds ? 16 : 7 }}
        attributionControl={false} onLoad={() => setLoaded(true)} onError={() => setMapError(true)}
        onClick={e => { if (manual && pendingPoint) onMapPoint({ lng: e.lngLat.lng, lat: e.lngLat.lat }) }}
        cursor={manual && pendingPoint ? 'crosshair' : 'grab'}>
        <QuietAttributionControl /><NavigationControl position="top-right" />
        {!manual && corners && <Source id="admin-align-image" type="image" url={imageUrl} coordinates={corners}><Layer id="admin-align-image-layer" type="raster" paint={{ 'raster-opacity': opacity / 100, 'raster-fade-duration': 0 }} /></Source>}
        <Source id="admin-align-buildings" type="geojson" data={geometry}><Layer id="admin-align-buildings-layer" type="line" paint={{ 'line-color': '#1f6feb', 'line-width': 2 }} /></Source>
        {manual && pairs.filter(p => p.kind !== 'auto').map((p, i) => <Marker key={i} longitude={p.lngLat.lng} latitude={p.lngLat.lat}><span className="adm-align-point">{i + 1}</span></Marker>)}
      </Map>
      <div className="adm-align-map-tools"><button type="button" className="btn" onClick={frame} disabled={!bounds}>{C.frame}</button>
        {manual && pendingPoint && <button type="button" className="btn" onClick={() => { const c = mapRef.current?.getCenter(); if (c) onMapPoint({ lng: c.lng, lat: c.lat }) }}>{C.useMapCenter}</button>}
      </div>
      {manual && pendingPoint && <span className="adm-align-center" aria-hidden>+</span>}
      {manual && !item.reference_rings.some(r => r.length >= 3) && <p className="adm-align-map-error" role="status">{C.noOutlines}</p>}
      {mapError && <p className="adm-align-map-error" role="status">{C.mapLoadFailed}</p>}
      <span className="adm-align-legend">{fillTemplate(C.legend, { source: sourceLabel })}</span>
    </div>
  </div>
}
