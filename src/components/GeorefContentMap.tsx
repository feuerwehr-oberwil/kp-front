/** Non-symbol Modul annotations projected onto the Lage map.
 *
 * This is display-only derived content. It deliberately does not enter MapView's editable
 * `entities`/`drawings` collections, so it cannot be selected, logged, printed or synced as a
 * duplicate. The source remains the annotation on its Modul document.
 *
 * A mirrored Leitung keeps its whole FKS voice here too — arrowhead (the same registered
 * `draw-arrow` SDF icon the map's own lines use), Teilstück-Gabel, marker letters, end tag and
 * the Länge read-out — so «which hose is that» has one answer on both surfaces. Geometry that
 * was dragged clear of other symbols on the sheet (label / end-tag offsets, in board fractions)
 * is projected through the same fit as the line itself.
 */
import { Fragment, type CSSProperties } from 'react'
import { Layer, Marker, Source } from 'react-map-gl/maplibre'
import type { MapContentTwin } from '../lib/georefTwins'
import { ShapeGlyph } from '../lib/shapes'
import { noteScale } from '../lib/notes'
import { worldPx } from '../lib/mapView'
import { fmtArea, fmtDistance, hoseLengthHint, pathLengthM, polygonAreaM2 } from '../lib/geo'
import { lerpPoint, markerParamsAlong } from '../lib/lineStyle'
import { EndTag, TeilstueckFork, hasLineDecor } from '../lib/lineDecor'
import { truppForLine, truppLineTone, truppTagText } from '../lib/truppLines'
import { appConfig } from '../config/appConfig'
import type { LngLat, Trupp } from '../types'
import s from './GeorefTwins.module.css'

const projectedPx = (a: LngLat, b: LngLat, zoom: number) => {
  const pa = worldPx(a, zoom), pb = worldPx(b, zoom)
  return Math.hypot(pb[0] - pa[0], pb[1] - pa[1])
}

const INERT: CSSProperties = { pointerEvents: 'none' }

export function GeorefContentMap({ twins, zoom, bearing, trupps = [], truppSeverities }: {
  twins: MapContentTwin[]
  zoom: number
  bearing: number
  /** the Atemschutz board, so a mirrored Leitung's tag carries its Trupp and clock tone */
  trupps?: Trupp[]
  truppSeverities?: Record<string, 1 | 2>
}) {
  if (!twins.length) return null
  // Arrowheads ride the map's own registered SDF icon in ONE symbol layer, exactly like the
  // Lage's lines — geographic bearing from the final segment, dimmed to the projection tone.
  const arrowFeats = twins
    .filter((t) => t.coords && t.anno.kind === 'draw' && t.anno.arrow && t.coords.length >= 2)
    .map((t) => {
      const n = t.coords!.length
      const [aLng, aLat] = t.coords![n - 2]
      const [bLng, bLat] = t.coords![n - 1]
      const cosL = Math.cos((bLat * Math.PI) / 180) || 1e-6
      const dx = (bLng - aLng) * cosL, dy = bLat - aLat
      const arrowBearing = (Math.atan2(dx, dy) * 180) / Math.PI
      return {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: t.coords![n - 1] },
        properties: { color: t.anno.color || appConfig.drawing.colors[0], bearing: arrowBearing },
      }
    })
  return (
    <>
      {arrowFeats.length > 0 && (
        <Source id="s-georef-content-arrows" type="geojson" data={{ type: 'FeatureCollection', features: arrowFeats }}>
          <Layer id="l-georef-content-arrows" type="symbol"
            layout={{ 'icon-image': 'draw-arrow', 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-anchor': 'center', 'icon-size': 1.1 } as never}
            paint={{ 'icon-color': ['get', 'color'], 'icon-opacity': 0.72 } as never} />
        </Source>
      )}
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
          // labels anchor where the SHEET says: midpoint/centroid in plan space plus the
          // operator's own nudge (labelDx/Dy, board fractions), projected through the fit
          const pts = a.pts ?? []
          const midPlan = pts[Math.floor((pts.length - 1) / 2)]
          const centroidPlan = pts.length
            ? [pts.reduce((sum, p) => sum + p[0], 0) / pts.length, pts.reduce((sum, p) => sum + p[1], 0) / pts.length]
            : null
          const basePlan = polygon ? centroidPlan : midPlan
          const labelCoord = basePlan
            ? (() => { const c = t.fit.toMap({ x: basePlan[0] + (a.labelDx ?? 0), y: basePlan[1] + (a.labelDy ?? 0) }); return [c.lng, c.lat] as LngLat })()
            : null
          const lines: string[] = []
          if (a.showDistance && !polygon) { const len = pathLengthM(t.coords); lines.push(`${fmtDistance(len)} · ${hoseLengthHint(len)}`) }
          if (a.showDistance && polygon) lines.push(fmtArea(polygonAreaM2(t.coords)))
          if (a.label) lines.push(a.label)
          // screen angle of the final segment, for the arrow-adjacent fork (glyph rotation is
          // screen-aligned in a DOM marker, so the live map bearing comes off the ground angle)
          const px = t.coords.map((c) => worldPx(c, zoom))
          const pe = px[px.length - 1], pr = px[px.length - 2] ?? pe
          const ang = (Math.atan2(pe[1] - pr[1], pe[0] - pr[0]) * 180) / Math.PI - bearing
          const end = t.coords[t.coords.length - 1]
          const lineTrupp = !polygon ? truppForLine(a, trupps) : undefined
          const showTag = !polygon && (a.content || a.lineNo != null || a.floorTag != null || lineTrupp)
          const tagCoord = showTag && pts.length >= 2
            ? (() => {
              const p2 = pts[pts.length - 2], p1 = pts[pts.length - 1]
              const bx = p2[0] + (p1[0] - p2[0]) * 0.72 + (a.endDx ?? 0)
              const by = p2[1] + (p1[1] - p2[1]) * 0.72 + (a.endDy ?? -0.02)
              const c = t.fit.toMap({ x: bx, y: by })
              return [c.lng, c.lat] as LngLat
            })()
            : null
          const markerCoords: LngLat[] = !polygon && a.marker && t.coords.length >= 2
            ? (() => {
              const out = markerParamsAlong(px).map(({ seg, t: f }) => lerpPoint(t.coords![seg], t.coords![seg + 1], f) as LngLat)
              return out.length ? out : [t.coords![Math.floor((t.coords!.length - 1) / 2)]]
            })()
            : []
          return <Fragment key={t.key}>
            <Source id={`s-${id}`} type="geojson" data={data}>
              {polygon && <Layer id={`f-${id}`} type="fill" paint={{ 'fill-color': color, 'fill-opacity': a.fillOpacity ?? 0.14 }} />}
              <Layer id={`l-${id}`} type="line" paint={{ 'line-color': color, 'line-width': a.width ?? (polygon ? 3 : 5), 'line-opacity': 0.72, ...(a.dashed ? { 'line-dasharray': [2, 1.5] } : {}) }}
                layout={{ 'line-cap': a.dashed ? 'butt' : 'round', 'line-join': 'round' }} />
            </Source>
            {a.teilstueck && !polygon && (
              <Marker longitude={end[0]} latitude={end[1]} anchor="center" style={INERT}>
                <span className={s.contentMap}><TeilstueckFork angleDeg={ang} color={color} width={a.width ?? 5} /></span>
              </Marker>
            )}
            {tagCoord && (
              <Marker longitude={tagCoord[0]} latitude={tagCoord[1]} anchor="center" style={INERT}>
                <span className={s.contentMap}>
                  <EndTag
                    lineNo={a.lineNo} content={a.content} floorTag={a.floorTag}
                    trupp={lineTrupp ? truppTagText(lineTrupp) : undefined}
                    tone={lineTrupp ? truppLineTone(lineTrupp, truppSeverities?.[lineTrupp.id] ?? 0) : 'idle'}
                    color={color}
                  />
                </span>
              </Marker>
            )}
            {markerCoords.map((c, j) => (
              <Marker key={`mk-${j}`} longitude={c[0]} latitude={c[1]} anchor="center" style={INERT}>
                <span className={s.contentMap}><span className="draw-marker" style={{ color }}>{a.marker}</span></span>
              </Marker>
            ))}
            {lines.length > 0 && labelCoord && (
              <Marker longitude={labelCoord[0]} latitude={labelCoord[1]} anchor="bottom" offset={[0, -6]} style={INERT}>
                <span className={`${s.contentMap} measure-label draw-label`}>
                  {lines.map((l, j) => <div key={j}>{l}</div>)}
                </span>
              </Marker>
            )}
          </Fragment>
        }
        if (!t.coord || a.x == null || a.y == null) return null
        if (a.kind === 'shape') {
          const edge = t.fit.toMap({ x: a.x + (a.sizeN ?? 0.1), y: a.y })
          const px = Math.max(12, projectedPx(t.coord, [edge.lng, edge.lat], zoom))
          return <Marker key={t.key} longitude={t.coord[0]} latitude={t.coord[1]} anchor="center" style={INERT}>
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
          return <Marker key={t.key} longitude={t.coord[0]} latitude={t.coord[1]} anchor="center" style={INERT}>
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
            <Marker longitude={t.coord[0]} latitude={t.coord[1]} anchor="center" style={INERT}>
              <span className={`${s.contentMap} team-dot`} style={{ '--team': a.color || appConfig.drawing.teamColors[0] } as CSSProperties}><i /><b>{a.text}</b></span>
            </Marker>
          </Fragment>
        }
        return null
      })}
    </>
  )
}
