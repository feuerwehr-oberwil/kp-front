import { useState } from 'react'
import Map, { Marker, type MapLayerMouseEvent } from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { deploymentDefaultCenter } from '../lib/deploymentConfig'
import type { LngLat } from '../types'

// Self-contained location picker for the intake wizard: works with NO active incident
// (the workspace map doesn't exist yet on a fresh Einsatz). A single Carto raster base —
// the app's default street basemap — is enough to aim; tap or drag the pin to place.
const CARTO = ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png`)
const COUNTRY_CENTER: LngLat = [8.2275, 46.8182] // last-resort fallback: Switzerland centroid

const STYLE = {
  version: 8 as const,
  sources: { base: { type: 'raster' as const, tiles: CARTO, tileSize: 256, attribution: '© CARTO, © OpenStreetMap-Mitwirkende' } },
  layers: [{ id: 'base', type: 'raster' as const, source: 'base' }],
}

export function MapPicker({ initial, onCancel, onConfirm }: {
  /** current resolved coord, if any, to center on + preplace the pin ([lng, lat]) */
  initial: LngLat | null
  onCancel: () => void
  onConfirm: (c: LngLat) => void
}) {
  const [pt, setPt] = useState<LngLat | null>(initial)
  // No resolved coord yet → open on the station's own area (deployment centre), not a
  // country-wide view that drops the EL in the middle of nowhere.
  const station = deploymentDefaultCenter()
  const center = initial ?? station ?? COUNTRY_CENTER
  const mp = appConfig.copy.mapPicker
  return (
    <div className="mp-ovl" onClick={onCancel}>
      <div className="mp-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="mp-head">
          <span>{mp.title}</span>
          <button className="ip-x" onClick={onCancel} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
        </div>
        <div className="mp-map">
          <Map
            initialViewState={{ longitude: center[0], latitude: center[1], zoom: initial ? 16 : station ? 14.5 : 8 }}
            mapStyle={STYLE}
            cursor="crosshair"
            onClick={(e: MapLayerMouseEvent) => setPt([e.lngLat.lng, e.lngLat.lat])}
          >
            {pt && (
              <Marker longitude={pt[0]} latitude={pt[1]} anchor="bottom" draggable onDragEnd={(e) => setPt([e.lngLat.lng, e.lngLat.lat])}>
                <div className="mp-pin"><Icon id="flag" /></div>
              </Marker>
            )}
          </Map>
          {!pt && <div className="mp-hint">{mp.hint}</div>}
        </div>
        <div className="mp-act">
          <button className="ip-btn" onClick={onCancel}>{appConfig.copy.cancel}</button>
          <button className="ip-btn primary" disabled={!pt} onClick={() => pt && onConfirm(pt)}>
            <Icon id="flag" /> {mp.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}
