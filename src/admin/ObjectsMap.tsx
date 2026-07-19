import { useCallback, useEffect, useRef, useState } from 'react'
import Map, { Marker, NavigationControl, type MapRef } from 'react-map-gl/maplibre'
import { QuietAttributionControl } from '../components/MapAttribution'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'

// Standalone object-locations map for the admin Objektpläne page. Lazy-loaded so MapLibre
// only ships to whoever opens this page. A single Carto raster base (the app's default
// street basemap) is enough to orient; markers are the hinterlegte Objekte. Selecting one
// (marker tap, list-row click, or hover) flies to it and lifts the pin with a name label;
// a "Alle zeigen" control reframes every object.

export interface MapObj { id: string; name: string; lat: number; lng: number }

const CARTO = ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png`)
const FALLBACK: [number, number] = [8.2275, 46.8182] // Switzerland centroid

const STYLE = {
  version: 8 as const,
  sources: { base: { type: 'raster' as const, tiles: CARTO, tileSize: 256, attribution: '© CARTO, © OpenStreetMap-Mitwirkende' } },
  layers: [{ id: 'base', type: 'raster' as const, source: 'base' }],
}

export default function ObjectsMap({ objects, selectedId, onSelect, hoveredId, onHover }: {
  objects: MapObj[]
  selectedId: string | null
  onSelect: (id: string) => void
  // Hover is lifted to the parent so a list-row hover lights its pin and vice-versa.
  hoveredId: string | null
  onHover: (id: string | null) => void
}) {
  const mapRef = useRef<MapRef | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Frame all objects: a single point gets a close zoom, several get a padded fit.
  const fit = useCallback((duration = 0) => {
    const m = mapRef.current
    if (!m || objects.length === 0) return
    if (objects.length === 1) {
      m.flyTo({ center: [objects[0].lng, objects[0].lat], zoom: 15, duration, essential: true })
      return
    }
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
    for (const o of objects) {
      minLng = Math.min(minLng, o.lng); maxLng = Math.max(maxLng, o.lng)
      minLat = Math.min(minLat, o.lat); maxLat = Math.max(maxLat, o.lat)
    }
    m.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 64, duration, maxZoom: 16, essential: true })
  }, [objects])

  useEffect(() => { if (loaded) fit() }, [loaded, fit])

  // Fly to the selected object — keep the current zoom if the operator is already close in,
  // otherwise pull in to street level. A gentle curve reads as "focus", not "teleport".
  useEffect(() => {
    if (!loaded || !selectedId) return
    const o = objects.find((x) => x.id === selectedId)
    if (!o) return
    const z = Math.max(mapRef.current?.getZoom() ?? 0, 16)
    mapRef.current?.flyTo({ center: [o.lng, o.lat], zoom: z, duration: 650, curve: 1.2, essential: true })
  }, [selectedId, loaded, objects])

  const start = objects[0] ?? { lng: FALLBACK[0], lat: FALLBACK[1] }
  const C = appConfig.copy.admin.objectsMap

  return (
    <Map
      ref={mapRef}
      initialViewState={{ longitude: start.lng, latitude: start.lat, zoom: 13 }}
      mapStyle={STYLE}
      style={{ width: '100%', height: '100%' }}
      attributionControl={false}
      onLoad={() => setLoaded(true)}
    >
      <QuietAttributionControl />
      <NavigationControl position="top-right" showCompass={false} />

      {objects.length > 1 && (
        <button
          type="button"
          className="adm-obj-fit"
          onClick={() => fit(600)}
          title={C.showAllTitle}
        >
          <Icon id="layers" />
          {C.showAll}
        </button>
      )}

      {objects.map((o) => {
        const on = selectedId === o.id
        const hot = hoveredId === o.id
        return (
          <Marker
            key={o.id}
            longitude={o.lng}
            latitude={o.lat}
            anchor="bottom"
            // selected pin draws above the rest
            style={{ zIndex: on ? 3 : hot ? 2 : 1 }}
            onClick={() => onSelect(o.id)}
          >
            <span
              className={`adm-obj-marker${on ? ' sel' : ''}${hot ? ' hot' : ''}`}
              onMouseEnter={() => onHover(o.id)}
              onMouseLeave={() => onHover(null)}
            >
              {(on || hot) && <span className="adm-obj-marker-label">{o.name}</span>}
              <button type="button" className="adm-obj-pin" title={o.name} aria-label={o.name}>
                <Icon id="flag" />
              </button>
            </span>
          </Marker>
        )
      })}
    </Map>
  )
}
