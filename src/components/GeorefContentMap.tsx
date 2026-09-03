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
 * The ink itself lives in ONE data-driven source with fixed layer ids, the way MapView carries
 * the map's own drawings — so the projections are picked through `interactiveLayerIds` over the
 * native's full 18 px hit band, wear its selection halo and its Atemschutz alarm outline, and a
 * LOCKED source goes click-through here exactly as it does on the surface that owns it.
 *
 * A mirrored Leitung keeps its whole FKS voice here too — arrowhead (the same registered
 * `draw-arrow` SDF icon the map's own lines use), Teilstück-Gabel, marker letters, end tag and
 * the Länge read-out — so «which hose is that» has one answer on both surfaces. Geometry that
 * was dragged clear of other symbols on the sheet (label / end-tag offsets, in board fractions)
 * is projected through the same fit as the line itself.
 */
import { Fragment, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { useNodeHold } from '../lib/nodeHold'
import { LineMarker } from './LineMarker'
import { NodeDeleteChip } from './NodeDeleteChip'
import { MARKER_Z } from '../lib/labelPass'
import { Layer, Marker, Source } from 'react-map-gl/maplibre'
import { useMapTwinDrag } from '../lib/mapTwinDrag'
import { LockChip } from './LockChip'
import { TwinTeamPill } from './TwinTeamPill'
import { contentTwinName, type MapContentTwin } from '../lib/georefTwins'
import { SHAPE_MAX_PX, ShapeGlyph, shapeAspect } from '../lib/shapes'
import { noteScale } from '../lib/notes'
import { worldPx, TEAM_DOT_PX, TEAM_PILL_CAP_PX } from '../lib/mapView'
import { fmtArea, fmtDistance, haversineM, hoseLengthHint, pathLengthM, polygonAreaM2 } from '../lib/geo'
import { DEFAULT_INK, EXTEND_STEP_PX, lerpPoint, markerParamsAlong, markerSpacing } from '../lib/lineStyle'
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

export function GeorefContentMap({ twins, zoom, bearing, trupps = [], truppSeverities, hiddenTrails, suppressedLabels, interactive = false, selectedKey = null, selectedKeys = [], onOpenTwin, onMoveTwin, onEditTwinAnno, onUnlockTwin, teamActions, onToggleTrail, project, unproject, setDragPan }: {
  twins: MapContentTwin[]
  zoom: number
  bearing: number
  /** the map's own per-team Spuren switch — one surface, one switch, mirrored trails included */
  hiddenTrails?: ReadonlySet<string>
  /** the map's ONE label pass (lib/labelPass), keyed `tdl:` / `ttag:` / `tteam:` + the twin key */
  suppressedLabels?: ReadonlySet<string>
  /** the Atemschutz board, so a mirrored Leitung's tag carries its Trupp and clock tone */
  trupps?: Trupp[]
  truppSeverities?: Record<string, 1 | 2>
  /** the map is at rest (no armed tool, no pairing) — only then may a projection answer a tap */
  interactive?: boolean
  /** the twin whose in-place panel is open — its hit target wears the selection halo */
  selectedKey?: string | null
  /** …and every mirrored member of a Mehrfach group, which lights up the same way (D-09) */
  selectedKeys?: string[]
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
  /** unlock a mirrored line/area/shape through its projection — the LockChip's only job, and the
   *  only door back into a locked object on this surface (MapView · lockChips) */
  onUnlockTwin?: (twin: MapContentTwin) => void
  /** The mirrored Truppmarker's context bar — the SAME bar the original wears on the Plan, and
   *  the same one a native Trupp wears here (TwinTeamPill · wb-pill-acts). Every action writes the
   *  ONE plan annotation; absent on a locked surface, where the read-only plaque takes over. */
  teamActions?: {
    rename: (twin: MapContentTwin, name: string) => void
    pick: (twin: MapContentTwin, truppId?: string) => void
    color: (twin: MapContentTwin, color: string | null) => void
    mark: (twin: MapContentTwin) => void
    clearTrail: (twin: MapContentTwin) => void
    remove: (twin: MapContentTwin) => void
    showTrupp: (truppId: string) => void
    toOriginal: (twin: MapContentTwin) => void
  }
  /** the map's own per-team Spuren switch (MapView state) — one surface, one switch */
  onToggleTrail?: (id: string) => void
  /** the live map transform + pan switch, for the drag above (same trio MapMarkers uses) */
  project?: (c: LngLat) => { x: number; y: number } | undefined
  unproject?: (p: { x: number; y: number }) => LngLat | undefined
  setDragPan?: (on: boolean) => void
}) {
  // still hold on a node pad = delete, movement cancels into the drag — the map's own grammar
  const vertexHold = useNodeHold()
  /** selected = the open panel's twin, or any mirrored member of a Mehrfach group */
  const isSelected = (key: string) => key === selectedKey || selectedKeys.includes(key)
  /** Shared tap/hold gesture for every hit target in this layer — the same one the symbol twins
   *  and the map's own markers run (lib/mapTwinDrag). */
  const { begin: beginGesture, canDrag } = useMapTwinDrag<MapContentTwin>({ project, unproject, setDragPan, onMove: onMoveTwin })
  const canDragAny = interactive && canDrag
  /** One tappable mark. The button replaces the inert span the layer used to render; keyboard
   *  «click» (detail 0) keeps the open, pointer taps go through the hold gesture's onTap.
   *
   *  ⚠️ Every INTERACTIVE Marker in this layer swallows the trailing native click
   *  (onClick · originalEvent.stopPropagation, the MapMarkers idiom). MapLibre listens for
   *  clicks NATIVELY on the map container — below React's delegated root — so a React-level
   *  stop can never reach it: the click bubbled to the map, onMapClick cleared the twin view
   *  in the same breath, and the panel the tap had just opened was gone before it ever painted
   *  («Trupp-Spiegel lässt sich nicht öffnen», 01.09.). */
  const tapTarget = (twin: MapContentTwin, anchor: LngLat, movable: boolean, className: string, children: ReactNode, style?: CSSProperties) => (
    <button type="button"
      className={`${s.contentTap} ${s.mapTap} ${className}`}
      style={{ ...style, ...(movable ? { touchAction: 'none', cursor: 'grab' } : null) }}
      title={fillTemplate(appConfig.copy.whiteboard.georef.twinFromPlan, { name: contentTwinName(twin.anno), plan: twin.planCode })}
      data-twin=""
      onClick={(ev) => { if (ev.detail === 0) onOpenTwin?.(twin) }}
      onPointerDown={(ev) => beginGesture(ev, twin, anchor, { movable, instant: isSelected(twin.key), onTap: onOpenTwin ? () => onOpenTwin(twin) : undefined })}>
      {/* ⚠️ NO selection halo here, and that is the native's own rule rather than a twin one
          (MapMarkers · `raised && kind !== 'note' && kind !== 'team' && kind !== 'shape'`). The
          three kinds this layer hit-targets are exactly those three: a Trupp says «selected» by
          becoming its context pill, a Notiz by its own selected chrome (`.twin-sel.note-pill` IS
          `.marker.sel .note-pill`), and a Form by its grips and the bar. A 104px blue ring around
          any of them was a second vocabulary the object beside it does not speak — the field saw
          it on a mirrored «Trupp 10» (02.09.). Mirrored INK is not affected: its selected paint
          comes from the GL layers below, exactly as the map's own Linie's does. */}
      {children}
    </button>
  )
  if (!twins.length) return null
  /**
   * The mirrored ink, as ONE data-driven collection — exactly how the map carries its own
   * drawings (MapView · drawFC).
   *
   * ⚠️ It used to be a Source per twin, with generated layer ids: those could never be named in
   * MapView's `interactiveLayerIds`, so the mirrored ink was pointer-dead over its whole length
   * and only the midpoint grip answered a tap. Fixed ids give the projections the native's own
   * 18 px hit band, its selection halo and its Atemschutz alarm outline (01.09.).
   */
  const inkFeats = twins
    .filter((t) => t.coords && (t.anno.kind === 'draw' || t.anno.kind === 'area' || t.anno.kind === 'circle'))
    .map((t) => {
      const a = t.anno
      // an Absperrkreis arrives as its projected ring (lib/georefTwins · mapContentTwins), so it
      // paints through the same closed-polygon path an area does
      const polygon = a.kind !== 'draw'
      // the tone that drives the alarm halo: '' unless a Trupp on this Leitung is fällig or
      // überfällig. Resolved here so the paint expression stays a plain lookup, as on the map.
      const lineTrupp = polygon ? undefined : truppForLine(a, trupps)
      const tone = lineTrupp ? truppLineTone(lineTrupp, truppSeverities?.[lineTrupp.id] ?? 0) : 'idle'
      return {
        type: 'Feature' as const,
        geometry: polygon
          ? { type: 'Polygon' as const, coordinates: [[...t.coords!, t.coords![0]]] }
          : { type: 'LineString' as const, coordinates: t.coords! },
        properties: {
          twinKey: t.key,
          color: a.color || appConfig.drawing.colors[0],
          // the MAP's own default weight, not the plan's 5/3: a projection paints like the ink
          // beside it on the surface it is drawn on (MapView · drawFC)
          width: a.width || 4,
          dashed: !!a.dashed,
          fillOpacity: a.fillOpacity ?? 0.14,
          // ⚠️ Schraffur is FKS meaning, not decoration («betroffene Fläche») — a hatched Fläche
          // that mirrored as an ordinary washed one said something else about the ground.
          hatch: !!a.hatch,
          truppTone: tone === 'warn' || tone === 'crit' ? tone : '',
          locked: !!a.locked,
        },
      }
    })
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
      {inkFeats.length > 0 && (
        <Source id="s-georef-content" type="geojson" data={{ type: 'FeatureCollection', features: inkFeats }}>
          {/* Atemschutz halo — the same soft outline in the same alarm tone the map's own
              Leitungen wear (MapView · l-draw-atemschutz). It is the loudest thing the Lage says
              about people being overdue, so it has to cross the mirror. */}
          <Layer id="l-georef-content-atemschutz" type="line" filter={['!=', ['get', 'truppTone'], ''] as never}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{
              'line-color': ['match', ['get', 'truppTone'], 'crit', appConfig.drawing.atemschutzTone.crit, appConfig.drawing.atemschutzTone.warn],
              'line-width': ['+', ['get', 'width'], 8],
              'line-opacity': 0.45,
            } as never} />
          <Layer id="l-georef-content-sel" type="line" filter={['in', ['get', 'twinKey'], ['literal', [selectedKey ?? '__none__', ...selectedKeys]]] as never}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': appConfig.drawing.selectColor, 'line-width': ['+', ['get', 'width'], 6], 'line-opacity': 0.5 } as never} />
          {/* fill and Schraffur are separate layers for the same reason the map's own are: a
              `fill-pattern` cannot be tinted, so there is one registered tile per draw colour
              (MapView · ensureArrow registers them on the map instance). */}
          <Layer id="l-georef-content-fill" type="fill" filter={['all', ['==', ['geometry-type'], 'Polygon'], ['!', ['get', 'hatch']]] as never}
            paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fillOpacity'] } as never} />
          <Layer id="l-georef-content-hatch" type="fill" filter={['all', ['==', ['geometry-type'], 'Polygon'], ['get', 'hatch']] as never}
            paint={{ 'fill-pattern': ['concat', 'hatch-', ['downcase', ['get', 'color']]] } as never} />
          {/* solid + dashed split: line-dasharray cannot be data-driven (MapView says the same) */}
          <Layer id="l-georef-content-line" type="line" filter={['!', ['get', 'dashed']] as never}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] } as never} />
          <Layer id="l-georef-content-line-dash" type="line" filter={['get', 'dashed'] as never}
            layout={{ 'line-cap': 'butt', 'line-join': 'round' }}
            paint={{ 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-dasharray': LINE_DASH_ML } as never} />
          {/* the native's fat transparent hit line over the WHOLE length, so a 40 m mirrored
              Leitung answers everywhere and not only at one dot (MapView · l-draw-hit) */}
          <Layer id="l-georef-content-hit" type="line" filter={['!=', ['geometry-type'], 'Polygon'] as never}
            paint={{ 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 } as never} />
        </Source>
      )}
      {arrowFeats.length > 0 && (
        <Source id="s-georef-content-arrows" type="geojson" data={{ type: 'FeatureCollection', features: arrowFeats }}>
          <Layer id="l-georef-content-arrows" type="symbol"
            layout={{ 'icon-image': ['get', 'icon'], 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-anchor': 'center', 'icon-size': 1.1 } as never}
            paint={{ 'icon-color': ['get', 'color'] } as never} />
        </Source>
      )}
      {twins.map((t, i) => {
        const a = t.anno
        if (t.coords && (a.kind === 'draw' || a.kind === 'area' || a.kind === 'circle')) {
          const polygon = a.kind !== 'draw'
          const color = a.color || appConfig.drawing.colors[0]
          // labels anchor where the SHEET says: midpoint/centroid in plan space plus the
          // operator's own nudge (labelDx/Dy, board fractions), projected through the fit
          const pts = a.pts ?? []
          const midPlan = pts[Math.floor((pts.length - 1) / 2)]
          const centroidPlan = pts.length
            ? [pts.reduce((sum, p) => sum + p[0], 0) / pts.length, pts.reduce((sum, p) => sum + p[1], 0) / pts.length]
            : null
          // a cordon's anchor is its stored CENTRE, not a centroid of the ring we synthesised
          const basePlan = a.kind === 'circle' ? (a.x != null && a.y != null ? [a.x, a.y] : null) : polygon ? centroidPlan : midPlan
          const labelCoord = basePlan
            ? (() => { const c = t.fit.toMap({ x: basePlan[0] + (a.labelDx ?? 0), y: basePlan[1] + (a.labelDy ?? 0) }); return [c.lng, c.lat] as LngLat })()
            : null
          const lines: string[] = []
          // an Absperrkreis states its radius, exactly as the Karte's own circles do (MapView ·
          // circleLabels) — measured off the projection, which is where its real metres live
          if (a.kind === 'circle' && t.coord) lines.push(fmtDistance(haversineM(t.coord, t.coords[0])))
          if (a.showDistance && !polygon) { const len = pathLengthM(t.coords); lines.push(`${fmtDistance(len)} · ${hoseLengthHint(len)}`) }
          if (a.showDistance && polygon && a.kind !== 'circle') lines.push(fmtArea(polygonAreaM2(t.coords)))
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
          // ⚠️ NO midpoint grip. It was the mirror's only move handle while the ink was
          // pointer-dead; the ink answers a tap over its whole length now, and moving belongs to
          // the surface's ONE selection bar — which the map's own Linie has no grip for either
          // (D-25, 01.09.). Extra furniture on every mirrored line is exactly what the native
          // does not have.
          const lockCoord = a.locked && basePlan && onUnlockTwin
            ? (() => { const c = t.fit.toMap({ x: basePlan[0], y: basePlan[1] }); return [c.lng, c.lat] as LngLat })()
            : null
          return <Fragment key={t.key}>
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
            {/* the click-through ink's only tap target — a short hold unlocks the ONE plan
                annotation, the same chip and the same gesture the map's own locked lines wear */}
            {lockCoord && (
              <Marker longitude={lockCoord[0]} latitude={lockCoord[1]} anchor="center" onClick={(ev) => ev.originalEvent.stopPropagation()}>
                <LockChip onUnlock={() => onUnlockTwin?.(t)} />
              </Marker>
            )}
            {/* ── the map's native vertex vocabulary on the SELECTED mirrored drawing (round 8:
                full 1:1) — draggable node pads with hold-to-delete, «+» midpoints, Verlängern.
                Every gesture writes the ONE plan annotation (onEditTwinAnno); grabbing an
                attached endpoint clears its attachment in the same patch. */}
            {interactive && onEditTwinAnno && !a.locked && selectedKey === t.key && pts.length >= 2 && (() => {
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
                      <Marker key={`ctins-${k}`} longitude={c.lng} latitude={c.lat} anchor="center" style={{ zIndex: MARKER_Z.selected }} onClick={(ev) => ev.originalEvent.stopPropagation()}>
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
                      <Marker key={`ctgrow-${ep}`} longitude={g.lng} latitude={g.lat} anchor="center" style={{ zIndex: MARKER_Z.selected }} onClick={(ev) => ev.originalEvent.stopPropagation()}>
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
                      <Marker key={`ctv-${i}`} longitude={c.lng} latitude={c.lat} anchor="center" style={{ zIndex: MARKER_Z.selected }} onClick={(ev) => ev.originalEvent.stopPropagation()} draggable
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
          const kind = a.shape ?? 'square'
          const edge = t.fit.toMap({ x: a.x + (a.sizeN ?? 0.1), y: a.y })
          // the MAP's own px band for a shape — floor 24, and the per-kind ceiling a native
          // stops at (lib/mapView · shapePx). A twin-only «12 and no ceiling» let a big mirrored
          // Rechteck keep growing past the size the object beside it is capped to.
          const px = Math.max(24, Math.min(SHAPE_MAX_PX[kind], projectedPx(t.coord, [edge.lng, edge.lat], zoom)))
          // a LOCKED shape is click-through, exactly like the map's own locked shape entity
          // (MapMarkers · lockedShape): no tap, no drag, and the centre LockChip is the way back
          const inert = !interactive || !onOpenTwin || a.locked
          // height follows the source's stretched box (BoardAnno.aspect — height per plan
          // WIDTH unit, same as the sheet renders it), so the mirror keeps its geometry.
          // ⚠️ The tappable one is NOT pointer-inert: the box carries the Form's shared hit pad
          // (03-map.css · .shape-glyph::before), and the pad of a dead element is dead too — a
          // mirrored Rotation would have been the middle of its own run and nothing else. The
          // press still lands on the button around it; this only lets the pad reach the finger.
          const glyph = (
            <span className={inert ? `${s.contentMap} shape-glyph` : 'shape-glyph'} style={{ display: 'block', width: px, height: px * shapeAspect(kind, a.aspect), transform: `rotate(${(a.rotation ?? 0) - t.fit.rotationDeg - bearing}deg)` }}>
              <ShapeGlyph kind={kind} color={a.color ?? DEFAULT_INK} stop={a.stop} aspect={a.aspect} carrier={a.carrier} reverse={a.reverse} strokeW={a.strokeW} boxPx={px} fillOpacity={a.fillOpacity} hatch={a.hatch} sharpCorners={a.sharpCorners} />
            </span>
          )
          if (inert) {
            return <Fragment key={t.key}>
              <Marker longitude={t.coord[0]} latitude={t.coord[1]} anchor="center" style={INERT}>{glyph}</Marker>
              {a.locked && onUnlockTwin && (
                <Marker longitude={t.coord[0]} latitude={t.coord[1]} anchor="center" onClick={(ev) => ev.originalEvent.stopPropagation()}>
                  <LockChip onUnlock={() => onUnlockTwin(t)} />
                </Marker>
              )}
            </Fragment>
          }
          return <Marker key={t.key} longitude={t.coord[0]} latitude={t.coord[1]} anchor="center" onClick={(ev) => ev.originalEvent.stopPropagation()}>
            {/* …and no body drag either: a Form is moved from the bar on this surface too */}
            {tapTarget(t, t.coord, false, '', glyph, { ['--hbox' as string]: `${Math.max(px, 56)}px` })}
          </Marker>
        }
        if (a.kind === 'text') {
          const edge = t.fit.toMap({ x: a.x + (a.wN ?? 0.18), y: a.y })
          const width = Math.max(72, projectedPx(t.coord, [edge.lng, edge.lat], zoom))
          const tinted = !a.notePlain && !!a.color
          const cls = `note-pill box${a.notePlain ? ' plain' : ''}${tinted ? ' tinted' : ''}${isSelected(t.key) ? ' twin-sel' : ''}`
          const style = {
            width, fontSize: 12 * noteScale(a.noteSize),
            ...(a.color ? (a.notePlain ? { color: a.color } : { '--note-tint': a.color }) : null),
          } as CSSProperties
          if (!interactive || !onOpenTwin) {
            return <Marker key={t.key} longitude={t.coord[0]} latitude={t.coord[1]} anchor="center" style={INERT}>
              <span className={`${s.contentMap} ${cls}`} style={style}>{a.text || appConfig.copy.whiteboard.text}</span>
            </Marker>
          }
          return <Marker key={t.key} longitude={t.coord[0]} latitude={t.coord[1]} anchor="center" onClick={(ev) => ev.originalEvent.stopPropagation()}>
            {tapTarget(t, t.coord, canDragAny, `${s.contentMap} ${cls}`, a.text || appConfig.copy.whiteboard.text, style)}
          </Marker>
        }
        if (a.kind === 'resource') {
          const teamCol = a.color || appConfig.drawing.teamColors[0]
          const trailShown = !hiddenTrails?.has(t.annoId)
          const trail = trailShown ? (a.trail ?? []).map((p) => {
            const c = t.fit.toMap({ x: p.x, y: p.y })
            return { coord: [c.lng, c.lat] as LngLat, t: p.t }
          }) : []
          const trailData = { type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: trail.map((p) => p.coord) }, properties: {} }
          // «raus» dims and strikes the chip on both native surfaces — a Trupp that is out
          // still reading as in is the one thing this marker must never say (safety)
          const isRaus = !!a.truppId && trupps.some((tr) => tr.id === a.truppId && tr.status === 'raus')
          const selected = selectedKey === t.key && !!teamActions
          const nameHidden = !!a.text && !!suppressedLabels?.has(`tteam:${t.key}`)
          const style = { '--team': teamCol } as CSSProperties
          const chip = <><i />{!nameHidden && <b>{a.text}</b>}</>
          return <Fragment key={t.key}>
            {trail.length >= 2 && <Source id={`s-georef-trail-${i}`} type="geojson" data={trailData}>
              <Layer id={`l-georef-trail-${i}`} type="line" paint={{ 'line-color': teamCol, 'line-width': 2, 'line-opacity': 0.85, 'line-dasharray': [2.5, 2.5] }} />
            </Source>}
            {/* the breadcrumbs themselves — the dot AND the recorded time at every marked
                position, exactly as the Karte's own trails read (MapMarkers · map-trail-dot).
                The path alone is a route; the times are the record. */}
            {trail.map((p, j) => (
              <Marker key={`tr-${j}`} longitude={p.coord[0]} latitude={p.coord[1]} anchor="center" style={INERT}>
                <div className="map-trail-dot">
                  <span className="wb-trail-mark" style={{ background: teamCol }} />
                  <i>{p.t}</i>
                </div>
              </Marker>
            ))}
            {/* ⚠️ A Trupp marker is a STRIP — [dot][gap][name] — anchored by its LEFT edge with
                half a dot taken back, so the DOT sits on the coordinate and the name merely hangs
                off it. Same anchor + offset the Karte's own Trupp markers use (MapMarkers), which
                is the whole point: on this surface a mirrored chip stands next to the original,
                and two anchorings side by side put them half a name's width apart. The selected
                pill takes its accent cap back instead, so selecting does not shift the point. */}
            {!interactive || !onOpenTwin ? (
              <Marker longitude={t.coord[0]} latitude={t.coord[1]} anchor="left" offset={[-TEAM_DOT_PX / 2, 0]} style={INERT}>
                <span className={`${s.contentMap} team-dot ${isRaus ? 'raus' : ''}`} style={style}>{chip}</span>
              </Marker>
            ) : !selected ? (
              <Marker longitude={t.coord[0]} latitude={t.coord[1]} anchor="left" offset={[-TEAM_DOT_PX / 2, 0]} onClick={(ev) => ev.originalEvent.stopPropagation()}>
                {tapTarget(t, t.coord, canDragAny, '', <span className={`team-dot ${isRaus ? 'raus' : ''}`}>{chip}</span>, style)}
              </Marker>
            ) : (
              <Marker longitude={t.coord[0]} latitude={t.coord[1]} anchor="left" offset={[-TEAM_PILL_CAP_PX, 0]}
                style={{ zIndex: MARKER_Z.selected }} onClick={(ev) => ev.originalEvent.stopPropagation()}>
                <TwinTeamPill
                  name={a.text ?? ''} time={a.t} color={teamCol} colorSet={a.color}
                  originalLabel={fillTemplate(appConfig.copy.contextPanel.showOnPlan, { plan: t.planCode })}
                  raus={isRaus} truppId={a.truppId} trailCount={a.trail?.length ?? 0} trailShown={trailShown}
                  trupps={trupps}
                  acts={{
                    rename: (name) => teamActions!.rename(t, name),
                    pick: (truppId) => teamActions!.pick(t, truppId),
                    color: (c) => teamActions!.color(t, c),
                    mark: () => teamActions!.mark(t),
                    clearTrail: () => teamActions!.clearTrail(t),
                    remove: () => teamActions!.remove(t),
                    showTrupp: teamActions!.showTrupp,
                    toOriginal: () => teamActions!.toOriginal(t),
                    toggleTrail: () => onToggleTrail?.(t.annoId),
                  }}
                  hit={(children) => tapTarget(t, t.coord!, canDragAny, '', children)} />
              </Marker>
            )}
          </Fragment>
        }
        return null
      })}
    </>
  )
}
