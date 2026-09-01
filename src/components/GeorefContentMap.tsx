/** Non-symbol Modul annotations projected onto the Lage map.
 *
 * This is derived content. It deliberately does not enter MapView's editable
 * `entities`/`drawings` collections, so it cannot be logged, printed or synced as a duplicate —
 * the source remains the annotation on its Modul document. Since 29.08. the projections are no
 * longer pointer-dead, though: each one carries a hit target that opens an in-place,
 * source-backed panel («Gespiegelt von …»), and a whole-object drag that writes the ONE source
 * through the fit inversion (the same rule the symbol twins follow). Since round 8 (30.08.,
 * «full 1:1 equivalence, no exceptions») the SELECTED mirrored drawing also wears the map's
 * native vertex vocabulary — node pads, «+» midpoints, hold-to-delete, Verlängern — all
 * writing the one plan annotation. Only a line with an ANCHORED endpoint keeps its
 * whole-object drag off (translating its stored pts would fork against the plan's
 * re-resolution); its grips reshape it, detaching the grabbed endpoint.
 *
 * A mirrored Leitung keeps its whole FKS voice here too — arrowhead (the same registered
 * `draw-arrow` SDF icon the map's own lines use), Teilstück-Gabel, marker letters, end tag and
 * the Länge read-out — so «which hose is that» has one answer on both surfaces. Geometry that
 * was dragged clear of other symbols on the sheet (label / end-tag offsets, in board fractions)
 * is projected through the same fit as the line itself.
 */
import { Fragment, useRef, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { useNodeHold } from '../lib/nodeHold'
import { LineMarker } from './LineMarker'
import { NodeDeleteChip } from './NodeDeleteChip'
import { MARKER_Z } from '../lib/labelPass'
import { Layer, Marker, Source } from 'react-map-gl/maplibre'
import { useHoldToDrag } from '../lib/useHoldToDrag'
import { contentTwinName, type MapContentTwin } from '../lib/georefTwins'
import { ShapeGlyph, shapeAspect } from '../lib/shapes'
import { noteScale } from '../lib/notes'
import { worldPx, TEAM_DOT_PX } from '../lib/mapView'
import { fmtArea, fmtDistance, hoseLengthHint, pathLengthM, polygonAreaM2 } from '../lib/geo'
import { EXTEND_STEP_PX, lerpPoint, markerParamsAlong, markerSpacing } from '../lib/lineStyle'
import { EndTag, TeilstueckFork } from '../lib/lineDecor'
import { truppForLine, truppLineTone, truppTagText } from '../lib/truppLines'
import { fillTemplate } from '../lib/format'
import { appConfig } from '../config/appConfig'
import { LINE_DASH_ML } from '../lib/draw'
import type { BoardAnno, LngLat, Trupp } from '../types'
import s from './GeorefTwins.module.css'

const projectedPx = (a: LngLat, b: LngLat, zoom: number) => {
  const pa = worldPx(a, zoom), pb = worldPx(b, zoom)
  return Math.hypot(pb[0] - pa[0], pb[1] - pa[1])
}

const INERT: CSSProperties = { pointerEvents: 'none' }

export function GeorefContentMap({ twins, zoom, bearing, trupps = [], truppSeverities, interactive = false, selectedKey = null, onOpenTwin, onMoveTwin, onEditTwinAnno, project, unproject, setDragPan }: {
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
  /** vertex-level edits of the SELECTED mirrored drawing — pts (plan space) and, when an
   *  anchored endpoint is grabbed, the attachment clear, patched onto the one source anno */
  onEditTwinAnno?: (twin: MapContentTwin, patch: Partial<BoardAnno>, phase: 'live' | 'commit') => void
  /** the live map transform + pan switch, for the drag above (same trio MapMarkers uses) */
  project?: (c: LngLat) => { x: number; y: number } | undefined
  unproject?: (p: { x: number; y: number }) => LngLat | undefined
  setDragPan?: (on: boolean) => void
}) {
  const hold = useHoldToDrag()
  // still hold on a node pad = delete, movement cancels into the drag — the map's own grammar
  const vertexHold = useNodeHold()
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
  // Lage's lines — geographic bearing from the final segment.
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
            paint={{ 'icon-color': ['get', 'color'] } as never} />
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
          const markerCoords: { coord: LngLat; deg: number }[] = !polygon && a.marker && t.coords.length >= 2
            ? (() => {
              const out = markerParamsAlong(px, markerSpacing(a.marker))
                .map(({ seg, t: f, deg }) => ({ coord: lerpPoint(t.coords![seg], t.coords![seg + 1], f) as LngLat, deg }))
              const mid = t.coords![Math.floor((t.coords!.length - 1) / 2)]
              return out.length ? out : [{ coord: mid, deg: 0 }]
            })()
            : []
          // The path's one hit target: a grip at its midpoint/centroid (before the label's
          // nudge, so it sits ON the geometry). Tap opens the panel; drag moves the whole
          // object. (The old isLeitung tap-only guard fell to round 8's full equivalence —
          // only ANCHORED endpoints still block the whole-drag, see the gate below.)
          const gripCoord = interactive && !!onOpenTwin && basePlan
            ? (() => { const c = t.fit.toMap({ x: basePlan[0], y: basePlan[1] }); return [c.lng, c.lat] as LngLat })()
            : null
          return <Fragment key={t.key}>
            <Source id={`s-${id}`} type="geojson" data={data}>
              {polygon && <Layer id={`f-${id}`} type="fill" paint={{ 'fill-color': color, 'fill-opacity': a.fillOpacity ?? 0.14 }} />}
              <Layer id={`l-${id}`} type="line" paint={{ 'line-color': color, 'line-width': a.width ?? (polygon ? 3 : 5), ...(a.dashed ? { 'line-dasharray': LINE_DASH_ML } : {}) }}
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
            {markerCoords.map((m, j) => (
              <Marker key={`mk-${j}`} longitude={m.coord[0]} latitude={m.coord[1]} anchor="center" style={INERT}>
                <span className={s.contentMap}><LineMarker marker={a.marker!} color={color} deg={m.deg} /></span>
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
                {/* whole-object drag only while NO endpoint is anchored: translating an attached
                    line's stored pts while the plan re-resolves the endpoint would fork the
                    mirror. An anchored line reshapes via its vertex grips below (detach-on-grab). */}
                {tapTarget(t, gripCoord, canDragAny && !a.startAttachment && !a.endAttachment, s.grip, <i style={{ color }} aria-hidden />)}
              </Marker>
            )}
            {/* ── the map's native vertex vocabulary on the SELECTED mirrored drawing (round 8:
                full 1:1) — draggable node pads with hold-to-delete, «+» midpoints, Verlängern.
                Every gesture writes the ONE plan annotation (onEditTwinAnno); grabbing an
                attached endpoint clears its attachment in the same patch. */}
            {interactive && onEditTwinAnno && selectedKey === t.key && pts.length >= 2 && (() => {
              const minPts = polygon ? 3 : 2
              const clearFor = (idx: number): Partial<BoardAnno> =>
                !polygon && idx === 0 && a.startAttachment ? { startAttachment: undefined }
                : !polygon && idx === pts.length - 1 && a.endAttachment ? { endAttachment: undefined } : {}
              const writePts = (next: typeof pts, phase: 'live' | 'commit', extra: Partial<BoardAnno> = {}) =>
                onEditTwinAnno(t, { pts: next, ...extra }, phase)
              const segs = Array.from({ length: polygon ? pts.length : pts.length - 1 }, (_, k) => k)
              return (
                <Fragment>
                  {segs.map((k) => {
                    const p1 = pts[k], p2 = pts[(k + 1) % pts.length]
                    const midPlan: [number, number] = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]
                    const c = t.fit.toMap({ x: midPlan[0], y: midPlan[1] })
                    return (
                      <Marker key={`ctins-${k}`} longitude={c.lng} latitude={c.lat} anchor="center" style={{ zIndex: MARKER_Z.selected }}>
                        <button type="button" className="measure-insert" title={appConfig.copy.measure.insertPoint} aria-label={appConfig.copy.measure.insertPoint}
                          onPointerDown={(ev) => {
                            ev.stopPropagation(); ev.preventDefault()
                            writePts([...pts.slice(0, k + 1), midPlan, ...pts.slice(k + 1)], 'commit')
                          }}><Icon id="plus" /></button>
                      </Marker>
                    )
                  })}
                  {!polygon && pts.length >= 2 && (['start', 'end'] as const).map((ep) => {
                    const i0 = ep === 'start' ? 0 : pts.length - 1
                    const nb = ep === 'start' ? pts[1] : pts[pts.length - 2]
                    const p0 = pts[i0]
                    const dxp = p0[0] - nb[0], dyp = p0[1] - nb[1]
                    const planLen = Math.hypot(dxp, dyp) || 1e-9
                    const segA = t.fit.toMap({ x: nb[0], y: nb[1] }), segB = t.fit.toMap({ x: p0[0], y: p0[1] })
                    const screenLen = projectedPx([segA.lng, segA.lat], [segB.lng, segB.lat], zoom) || 1
                    const step = (EXTEND_STEP_PX * planLen) / screenLen / planLen
                    const gPlan: [number, number] = [p0[0] + dxp * step, p0[1] + dyp * step]
                    const g = t.fit.toMap({ x: gPlan[0], y: gPlan[1] })
                    const deg = (Math.atan2(worldPx([g.lng, g.lat], zoom)[1] - worldPx([segB.lng, segB.lat], zoom)[1], worldPx([g.lng, g.lat], zoom)[0] - worldPx([segB.lng, segB.lat], zoom)[0]) * 180) / Math.PI - bearing
                    return (
                      <Marker key={`ctgrow-${ep}`} longitude={g.lng} latitude={g.lat} anchor="center" style={{ zIndex: MARKER_Z.selected }}>
                        <button type="button" className="draw-grow" title={appConfig.copy.measure.extendLine} aria-label={appConfig.copy.measure.extendLine}
                          style={{ ['--grow-deg' as string]: `${deg}deg` }}
                          onPointerDown={(ev) => {
                            ev.stopPropagation(); ev.preventDefault()
                            writePts(ep === 'start' ? [gPlan, ...pts] : [...pts, gPlan], 'commit')
                          }}><Icon id="arrow" /></button>
                      </Marker>
                    )
                  })}
                  {pts.map((p, i) => {
                    const c = t.fit.toMap({ x: p[0], y: p[1] })
                    return (
                      <Marker key={`ctv-${i}`} longitude={c.lng} latitude={c.lat} anchor="center" style={{ zIndex: MARKER_Z.selected }} draggable
                        onDragStart={() => setDragPan?.(false)}
                        onDrag={(e) => {
                          vertexHold.cancel()
                          const pp = t.fit.toPlan({ lng: e.lngLat.lng, lat: e.lngLat.lat })
                          writePts(pts.map((q, j) => (j === i ? [pp.x, pp.y] as typeof q : q)), 'live', clearFor(i))
                        }}
                        onDragEnd={(e) => {
                          setDragPan?.(true)
                          const pp = t.fit.toPlan({ lng: e.lngLat.lng, lat: e.lngLat.lat })
                          writePts(pts.map((q, j) => (j === i ? [pp.x, pp.y] as typeof q : q)), 'commit', clearFor(i))
                        }}>
                        <div className={`draw-handle ${vertexHold.armed?.key === `ct:${t.key}:${i}` ? 'doomed' : ''}`}
                          title={appConfig.copy.measure.deleteNode}
                          {...vertexHold.press(`ct:${t.key}:${i}`, () => {
                            if (pts.length <= minPts) return
                            writePts(pts.filter((_, j) => j !== i), 'commit')
                          }, pts.length > minPts)}
                        >{vertexHold.armed?.key === `ct:${t.key}:${i}` && <NodeDeleteChip progress={vertexHold.armed.progress} />}</div>
                      </Marker>
                    )
                  })}
                </Fragment>
              )
            })()}
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
              <ShapeGlyph kind={kind} color={a.color ?? '#1f6feb'} stop={a.stop} aspect={a.aspect} carrier={a.carrier} />
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
              <Layer id={`l-georef-trail-${i}`} type="line" paint={{ 'line-color': a.color || appConfig.drawing.teamColors[0], 'line-width': 2, 'line-opacity': 0.85, 'line-dasharray': [2.5, 2.5] }} />
            </Source>}
            {/* ⚠️ A Trupp marker is a STRIP — [dot][gap][name] — anchored by its LEFT edge with
                half a dot taken back, so the DOT sits on the coordinate and the name merely hangs
                off it. Same anchor + offset the Karte's own Trupp markers use (MapMarkers), which
                is the whole point: on this surface a mirrored chip stands next to the original,
                and two anchorings side by side put them half a name's width apart. */}
            {!interactive || !onOpenTwin ? (
              <Marker longitude={t.coord[0]} latitude={t.coord[1]} anchor="left" offset={[-TEAM_DOT_PX / 2, 0]} style={INERT}>
                <span className={`${s.contentMap} team-dot`} style={style}>{chip}</span>
              </Marker>
            ) : (
              <Marker longitude={t.coord[0]} latitude={t.coord[1]} anchor="left" offset={[-TEAM_DOT_PX / 2, 0]}>
                {tapTarget(t, t.coord, canDragAny, '', <span className="team-dot">{chip}</span>, style)}
              </Marker>
            )}
          </Fragment>
        }
        return null
      })}
    </>
  )
}
