import { useEffect, useMemo, useRef, useState } from 'react'
import Map, { Source, Layer, NavigationControl, type MapRef } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import { QuietAttributionControl } from '../components/MapAttribution'
import { appConfig } from '../config/appConfig'
import { cartoRasterTiles } from '../lib/carto'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { alignmentBounds, alignmentCorners } from '../lib/planAlignmentReview'
import type { GeorefPair } from '../lib/georef'
import { fillTemplate } from '../lib/format'
import type { AlignmentItem } from './planAlignmentApi'

/** The exact PDF raster over its fit – the proposal as the field will see it. Aligning by hand
 *  is AlignmentPairing (the field's own pairing mode), not this view. */
export default function AlignmentPreview({ item, pairs, imageUrl, opacity }: {
  item: AlignmentItem
  pairs: GeorefPair[]
  imageUrl: string
  opacity: number
}) {
  const C = appConfig.copy.admin.alignment
  const sourceLabel = item.reference_source?.startsWith('OSM') ? 'OpenStreetMap' : item.reference_source ?? C.referenceUnknown
  const mapRef = useRef<MapRef>(null)
  const [loaded, setLoaded] = useState(false)
  const [mapError, setMapError] = useState(false)
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

  return <div className="adm-align-preview">
    <div className="adm-align-map" aria-label={C.mapPreview}>
      <Map ref={mapRef} mapStyle={style} initialViewState={{ longitude: bounds ? (bounds[0][0] + bounds[1][0]) / 2 : 8.2275, latitude: bounds ? (bounds[0][1] + bounds[1][1]) / 2 : 46.8182, zoom: bounds ? 16 : 7 }}
        attributionControl={false} onLoad={() => setLoaded(true)} onError={() => setMapError(true)} cursor="grab">
        <QuietAttributionControl /><NavigationControl position="top-right" />
        {corners && <Source id="admin-align-image" type="image" url={imageUrl} coordinates={corners}><Layer id="admin-align-image-layer" type="raster" paint={{ 'raster-opacity': opacity / 100, 'raster-fade-duration': 0 }} /></Source>}
        <Source id="admin-align-buildings" type="geojson" data={geometry}><Layer id="admin-align-buildings-layer" type="line" paint={{ 'line-color': '#1f6feb', 'line-width': 2 }} /></Source>
      </Map>
      <div className="adm-align-map-tools"><button type="button" className="btn" onClick={frame} disabled={!bounds}>{C.frame}</button></div>
      {mapError && <p className="adm-align-map-error" role="status">{C.mapLoadFailed}</p>}
      <span className="adm-align-legend">{fillTemplate(C.legend, { source: sourceLabel })}</span>
    </div>
  </div>
}
