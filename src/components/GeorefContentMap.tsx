/** Non-symbol Modul annotations projected onto the Lage map.
 *
 * This is display-only derived content. It deliberately does not enter MapView's editable
 * `entities`/`drawings` collections, so it cannot be selected, logged, printed or synced as a
 * duplicate. The source remains the annotation on its Modul document.
 */
import { Fragment, type CSSProperties } from 'react'
import { Layer, Marker, Source } from 'react-map-gl/maplibre'
import type { MapContentTwin } from '../lib/georefTwins'
import { ShapeGlyph } from '../lib/shapes'
import { noteScale } from '../lib/notes'
import { worldPx } from '../lib/mapView'
import { appConfig } from '../config/appConfig'
import type { LngLat } from '../types'
import s from './GeorefTwins.module.css'

const projectedPx = (a: LngLat, b: LngLat, zoom: number) => {
  const pa = worldPx(a, zoom), pb = worldPx(b, zoom)
  return Math.hypot(pb[0] - pa[0], pb[1] - pa[1])
}

export function GeorefContentMap({ twins, zoom, bearing }: {
  twins: MapContentTwin[]
  zoom: number
  bearing: number
}) {
  if (!twins.length) return null
  return (
    <>
      {twins.map((t, i) => {
        const a = t.anno
        if (t.coords && (a.kind === 'draw' || a.kind === 'area')) {
          const polygon = a.kind === 'area'
          const geometry = polygon
            ? { type: 'Polygon' as const, coordinates: [[...t.coords, t.coords[0]]] }
            : { type: 'LineString' as const, coordinates: t.coords }
          const data = { type: 'Feature' as const, geometry, properties: {} }
          const color = a.color || appConfig.drawing.colors[0]
          const id = `georef-content-${i}`
          const mid = t.coords[Math.floor((t.coords.length - 1) / 2)]
          return <Fragment key={t.key}>
            <Source id={`s-${id}`} type="geojson" data={data}>
              {polygon && <Layer id={`f-${id}`} type="fill" paint={{ 'fill-color': color, 'fill-opacity': a.fillOpacity ?? 0.14 }} />}
              <Layer id={`l-${id}`} type="line" paint={{ 'line-color': color, 'line-width': a.width ?? (polygon ? 3 : 5), 'line-opacity': 0.72, ...(a.dashed ? { 'line-dasharray': [2, 1.5] } : {}) }}
                layout={{ 'line-cap': a.dashed ? 'butt' : 'round', 'line-join': 'round' }} />
            </Source>
            {a.label && mid && <Marker longitude={mid[0]} latitude={mid[1]} anchor="bottom" offset={[0, -6]} style={{ pointerEvents: 'none' }}>
              <span className={`${s.contentMap} wb-line-label`}>{a.label}</span>
            </Marker>}
          </Fragment>
        }
        if (!t.coord || a.x == null || a.y == null) return null
        const common = { pointerEvents: 'none' } as CSSProperties
        if (a.kind === 'shape') {
          const edge = t.fit.toMap({ x: a.x + (a.sizeN ?? 0.1), y: a.y })
          const px = Math.max(12, projectedPx(t.coord, [edge.lng, edge.lat], zoom))
          return <Marker key={t.key} longitude={t.coord[0]} latitude={t.coord[1]} anchor="center" style={common}>
            <span className={`${s.contentMap} shape-glyph`} style={{ display: 'block', width: px, height: px, transform: `rotate(${(a.rotation ?? 0) - t.fit.rotationDeg - bearing}deg)` }}>
              <ShapeGlyph kind={a.shape ?? 'square'} color={a.color ?? '#1f6feb'} />
            </span>
          </Marker>
        }
        if (a.kind === 'text') {
          const edge = t.fit.toMap({ x: a.x + (a.wN ?? 0.18), y: a.y })
          const width = Math.max(72, projectedPx(t.coord, [edge.lng, edge.lat], zoom))
          const tinted = !a.notePlain && !!a.color
          const cls = `note-pill box${a.notePlain ? ' plain' : ''}${tinted ? ' tinted' : ''}`
          const style = {
            width, fontSize: 12 * noteScale(a.noteSize),
            ...(a.color ? (a.notePlain ? { color: a.color } : { '--note-tint': a.color }) : null),
          } as CSSProperties
          return <Marker key={t.key} longitude={t.coord[0]} latitude={t.coord[1]} anchor="center" style={common}>
            <span className={`${s.contentMap} ${cls}`} style={style}>{a.text || appConfig.copy.whiteboard.text}</span>
          </Marker>
        }
        if (a.kind === 'resource') {
          const trail = (a.trail ?? []).map((p) => {
            const c = t.fit.toMap({ x: p.x, y: p.y })
            return [c.lng, c.lat] as LngLat
          })
          const trailData = { type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: trail }, properties: {} }
          return <Fragment key={t.key}>
            {trail.length >= 2 && <Source id={`s-georef-trail-${i}`} type="geojson" data={trailData}>
              <Layer id={`l-georef-trail-${i}`} type="line" paint={{ 'line-color': a.color || appConfig.drawing.teamColors[0], 'line-width': 2, 'line-opacity': 0.7, 'line-dasharray': [2, 2] }} />
            </Source>}
            <Marker longitude={t.coord[0]} latitude={t.coord[1]} anchor="center" style={common}>
              <span className={`${s.contentMap} team-dot`} style={{ '--team': a.color || appConfig.drawing.teamColors[0] } as CSSProperties}><i /><b>{a.text}</b></span>
            </Marker>
          </Fragment>
        }
        return null
      })}
    </>
  )
}
