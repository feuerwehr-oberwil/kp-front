/** Non-symbol Modul annotations projected onto the Lage map.
 *
 * This is derived content. It deliberately does not enter MapView's editable
 * `entities`/`drawings` collections, so it cannot be logged, printed or synced as a duplicate —
 * the source remains the annotation on its Modul document. Since 29.08. the projections are no
 * longer pointer-dead, though: each one carries a hit target that opens an in-place,
 * source-backed panel («Gespiegelt von …»), and a whole-object drag that writes the ONE source
 * through the fit inversion (the same rule the symbol twins follow). Vertex-level editing stays
 * with the source surface; an FKS Leitung and everything derived from it stays tap-only (its
 * geometry is anchored to symbols and to the hose ↔ Atemschutz linkage — see `isLeitung`).
 *
 * A mirrored Leitung keeps its whole FKS voice here too — arrowhead (the same registered
 * `draw-arrow` SDF icon the map's own lines use), Teilstück-Gabel, marker letters, end tag and
 * the Länge read-out — so «which hose is that» has one answer on both surfaces. Geometry that
 * was dragged clear of other symbols on the sheet (label / end-tag offsets, in board fractions)
 * is projected through the same fit as the line itself.
 */
import { Fragment, useRef, type CSSProperties, type ReactNode } from 'react'
import { Layer, Marker, Source } from 'react-map-gl/maplibre'
import { useHoldToDrag } from '../lib/useHoldToDrag'
import { contentTwinName, type MapContentTwin } from '../lib/georefTwins'
import { ShapeGlyph, shapeAspect } from '../lib/shapes'
import { noteScale } from '../lib/notes'
import { worldPx } from '../lib/mapView'
import { fmtArea, fmtDistance, hoseLengthHint, pathLengthM, polygonAreaM2 } from '../lib/geo'
import { lerpPoint, markerParamsAlong } from '../lib/lineStyle'
import { EndTag, TeilstueckFork } from '../lib/lineDecor'
import { truppForLine, truppLineTone, truppTagText } from '../lib/truppLines'
import { fillTemplate } from '../lib/format'
import { appConfig } from '../config/appConfig'
import type { BoardAnno, LngLat, Trupp } from '../types'
import s from './GeorefTwins.module.css'

const projectedPx = (a: LngLat, b: LngLat, zoom: number) => {
  const pa = worldPx(a, zoom), pb = worldPx(b, zoom)
  return Math.hypot(pb[0] - pa[0], pb[1] - pa[1])
}

const INERT: CSSProperties = { pointerEvents: 'none' }

/** An FKS Leitung (or a line already wired into the hose ↔ Atemschutz linkage / anchored to a
 *  symbol). Its projection answers a tap — «which hose is that» opens the panel — but never a
 *  whole-object drag: the endpoints are anchored, one Leitung is one Trupp, and a drag that
 *  silently tore either promise would be worse than no drag at all. */
const isLeitung = (a: BoardAnno) =>
  a.kind === 'draw' && (a.truppId != null || a.lineNo != null || !!a.content || !!a.startAttachment || !!a.endAttachment)

export function GeorefContentMap({ twins, zoom, bearing, trupps = [], truppSeverities, interactive = false, selectedKey = null, onOpenTwin, onMoveTwin, project, unproject, setDragPan }: {
  twins: MapContentTwin[]
  zoom: number
  bearing: number
  /** the Atemschutz board, so a mirrored Leitung's tag carries its Trupp and clock tone */
  trupps?: Trupp[]
  truppSeverities?: Record<string, 1 | 2>
  /** the map is at rest (no armed tool, no pairing) — only then may a projection answer a tap */
  interactive?: boolean
  /** the twin whose in-place panel is open — its hit target wears the selection halo */
  selectedKey?: string | null
  /** tap on any mirrored object: open its in-place, source-backed panel on THIS surface */
  onOpenTwin?: (twin: MapContentTwin) => void
  /** Drag a projection to move its one source annotation on the Modul — the ground coordinate
   *  is folded back through the twin's fit by the caller (per kind: a point writes x/y, a
   *  line/area translates every vertex). Same gesture grammar as the map's own team markers
   *  (useHoldToDrag): mouse press-drags at once, touch holds still first, a tap stays a tap. */
  onMoveTwin?: (twin: MapContentTwin, coord: LngLat, phase: 'start' | 'move' | 'end') => void
  /** the live map transform + pan switch, for the drag above (same trio MapMarkers uses) */
  project?: (c: LngLat) => { x: number; y: number } | undefined
  unproject?: (p: { x: number; y: number }) => LngLat | undefined
  setDragPan?: (on: boolean) => void
}) {
  const hold = useHoldToDrag()
  /** the live drag — re-anchored from the LAST written coord on every move, so a map transform
   *  change under the finger cannot teleport the mark (MapMarkers does the same). One ref for
   *  the whole layer: only one projection is ever dragged at a time. */
  const drag = useRef<{ lx: number; ly: number; last: LngLat } | null>(null)
  const canDragAny = interactive && !!onMoveTwin && !!project && !!unproject
  /** Shared tap/hold gesture for every hit target in this layer. `anchor` is the ground point
   *  the drag writes through (the mark itself, or a path's grip). */
  const beginGesture = (ev: React.PointerEvent, twin: MapContentTwin, anchor: LngLat, movable: boolean) => {
    ev.stopPropagation()
    hold.begin({ clientX: ev.clientX, clientY: ev.clientY, pointerId: ev.pointerId, isPrimary: ev.isPrimary }, {
      onTap: onOpenTwin ? () => onOpenTwin(twin) : undefined,
      onHoldStart: () => {
        setDragPan?.(false)
        drag.current = { lx: ev.clientX, ly: ev.clientY, last: anchor }
        onMoveTwin?.(twin, anchor, 'start')
      },
      onDragMove: (mx, my) => {
        const st = drag.current
        if (!st) return
        const base = project!(st.last)
        if (!base) return
        const nc = unproject!({ x: base.x + (mx - st.lx), y: base.y + (my - st.ly) })
        if (!nc) return
        st.lx = mx; st.ly = my; st.last = nc
        onMoveTwin?.(twin, nc, 'move')
      },
      onDragEnd: () => {
        const st = drag.current
        drag.current = null
        setDragPan?.(true)
        if (st) onMoveTwin?.(twin, st.last, 'end')
      },
    }, { mode: ev.pointerType === 'mouse' ? 'mouse' : 'touch', canDrag: movable })
  }
  /** One tappable mark. The button replaces the inert span the layer used to render; keyboard
   *  «click» (detail 0) keeps the open, pointer taps go through the hold gesture's onTap. */
  const tapTarget = (twin: MapContentTwin, anchor: LngLat, movable: boolean, className: string, children: ReactNode, style?: CSSProperties) => (
    <button type="button"
      className={`${s.contentTap} ${s.mapTap} ${className}`}
      style={{ ...style, ...(movable ? { touchAction: 'none', cursor: 'grab' } : null) }}
      title={fillTemplate(appConfig.copy.whiteboard.georef.twinFromPlan, { name: contentTwinName(twin.anno), plan: twin.planCode })}
      data-twin=""
      onClick={(ev) => { if (ev.detail === 0) onOpenTwin?.(twin) }}
      onPointerDown={(ev) => beginGesture(ev, twin, anchor, movable)}>
      {selectedKey === twin.key && <span className="sel-halo" aria-hidden />}
      {children}
    </button>
  )
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
        properties: { color: t.anno.color || appConfig.drawing.colors[0], bearing: arrowBearing, icon: t.anno.arrowStop ? 'draw-arrow-stop' : 'draw-arrow' },
      }
    })
  return (
    <>
      {arrowFeats.length > 0 && (
        <Source id="s-georef-content-arrows" type="geojson" data={{ type: 'FeatureCollection', features: arrowFeats }}>
          <Layer id="l-georef-content-arrows" type="symbol"
            layout={{ 'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-anchor': 'center', 'icon-size': 1.1 } as never}
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
          // The path's one hit target: a grip at its midpoint/centroid (before the label's
          // nudge, so it sits ON the geometry). Tap opens the panel; drag moves the whole
          // object — except a Leitung, whose anchored geometry stays tap-only (isLeitung).
          const gripCoord = interactive && !!onOpenTwin && basePlan
            ? (() => { const c = t.fit.toMap({ x: basePlan[0], y: basePlan[1] }); return [c.lng, c.lat] as LngLat })()
            : null
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
            {gripCoord && (
              <Marker longitude={gripCoord[0]} latitude={gripCoord[1]} anchor="center">
                {tapTarget(t, gripCoord, canDragAny && !isLeitung(a), s.grip, <i style={{ color }} aria-hidden />)}
              </Marker>
            )}
          </Fragment>
        }
        if (!t.coord || a.x == null || a.y == null) return null
        if (a.kind === 'shape') {
          const edge = t.fit.toMap({ x: a.x + (a.sizeN ?? 0.1), y: a.y })
          const px = Math.max(12, projectedPx(t.coord, [edge.lng, edge.lat], zoom))
          // height follows the source's stretched box (BoardAnno.aspect — height per plan
          // WIDTH unit, same as the sheet renders it), so the mirror keeps its geometry
          const kind = a.shape ?? 'square'
          const glyph = (
            <span className={`${s.contentMap} shape-glyph`} style={{ display: 'block', width: px, height: px * shapeAspect(kind, a.aspect), transform: `rotate(${(a.rotation ?? 0) - t.fit.rotationDeg - bearing}deg)` }}>
              <ShapeGlyph kind={kind} color={a.color ?? '#1f6feb'} stop={a.stop} />
            </span>
          )
          if (!interactive || !onOpenTwin) {
            return <Marker key={t.key} longitude={t.coord[0]} latitude={t.coord[1]} anchor="center" style={INERT}>{glyph}</Marker>
          }
          return <Marker key={t.key} longitude={t.coord[0]} latitude={t.coord[1]} anchor="center">
            {tapTarget(t, t.coord, canDragAny, '', glyph)}
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
          if (!interactive || !onOpenTwin) {
            return <Marker key={t.key} longitude={t.coord[0]} latitude={t.coord[1]} anchor="center" style={INERT}>
              <span className={`${s.contentMap} ${cls}`} style={style}>{a.text || appConfig.copy.whiteboard.text}</span>
            </Marker>
          }
          return <Marker key={t.key} longitude={t.coord[0]} latitude={t.coord[1]} anchor="center">
            {tapTarget(t, t.coord, canDragAny, `${s.contentMap} ${cls}`, a.text || appConfig.copy.whiteboard.text, style)}
          </Marker>
        }
        if (a.kind === 'resource') {
          const trail = (a.trail ?? []).map((p) => {
            const c = t.fit.toMap({ x: p.x, y: p.y })
            return [c.lng, c.lat] as LngLat
          })
          const trailData = { type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: trail }, properties: {} }
          const style = { '--team': a.color || appConfig.drawing.teamColors[0] } as CSSProperties
          const chip = <><i /><b>{a.text}</b></>
          return <Fragment key={t.key}>
            {trail.length >= 2 && <Source id={`s-georef-trail-${i}`} type="geojson" data={trailData}>
              <Layer id={`l-georef-trail-${i}`} type="line" paint={{ 'line-color': a.color || appConfig.drawing.teamColors[0], 'line-width': 2, 'line-opacity': 0.7, 'line-dasharray': [2, 2] }} />
            </Source>}
            {!interactive || !onOpenTwin ? (
              <Marker longitude={t.coord[0]} latitude={t.coord[1]} anchor="center" style={INERT}>
                <span className={`${s.contentMap} team-dot`} style={style}>{chip}</span>
              </Marker>
            ) : (
              <Marker longitude={t.coord[0]} latitude={t.coord[1]} anchor="center">
                {tapTarget(t, t.coord, canDragAny, `${s.contentMap} team-dot`, chip, style)}
              </Marker>
            )}
          </Fragment>
        }
        return null
      })}
    </>
  )
}
