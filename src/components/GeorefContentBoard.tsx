/** Non-symbol Karte content projected onto a georeferenced Modul.
 *
 * Derived and below the sheet's own annotations: there is still exactly one editable source
 * object. Team chips, notes and shapes carry a hit target — tap opens the in-place
 * source-backed panel, a drag past the deadzone moves the one source marker on the Karte
 * (both through the generic `onOpenTeam`/`onMoveTeam` pair, which Whiteboard forwards for
 * every entity kind). Mirrored map DRAWINGS use the same source-backed grammar: tap opens their
 * editor, dragging the body moves the line, and selected vertex handles reshape the one Karte
 * drawing. Shared responder positions stay pointer-inert because a phone's GPS fix is nobody's
 * to move. Tactical symbols/live vehicles keep using
 * GeorefTwinsBoard because those twins already have selection, source-jump and drag semantics
 * of their own.
 *
 * A mirrored Leitung keeps its whole FKS voice — arrowhead, Teilstück-Gabel, marker letters,
 * end tag and distance read-out. The strokes come from WbInkLayer; the decorations are drawn
 * here in board px with the same helpers the sheet's own lines use (lib/lineStyle,
 * lib/lineDecor), because the ink SVG is stretched 1×1 and would distort them. Distances are
 * measured on the SOURCE geometry (geodesic, lib/geo) — the map already knows the truth, so a
 * mirrored line reads its Länge even on a sheet that was never calibrated.
 */
import { useRef, useState, type CSSProperties } from 'react'
import { Icon } from '../lib/icons'
import { Menu, Popover, PopoverClose } from '../lib/overlays'
import { LineMarker } from './LineMarker'
import { MenuPick } from './MenuPick'
import { LockChip } from './LockChip'
import type { GeorefFit } from '../lib/georef'
import { DRAG_DEADZONE_PX } from '../lib/useHoldToDrag'
import { contentTwinName, type BoardDrawingTwin, type BoardEntityTwin } from '../lib/georefTwins'
import { WbInkLayer, WbVertexHandles } from './WbControls'
import { ShapeGlyph, shapeAspect } from '../lib/shapes'
import { TacticalSymbol } from '../lib/symbolRender'
import { glyphFor } from '../lib/twinGlyph'
import { noteScale, noteWPx } from '../lib/notes'
import { TEAM_DOT_PX, TEAM_PILL_CAP_PX } from '../lib/mapView'
import { fmtArea, fmtDistance, hoseLengthHint, pathLengthM, polygonAreaM2 } from '../lib/geo'
import { EXTEND_STEP_PX, lerpPoint, lookbackPoint, markerGlyph, markerParamsAlong, markerSpacing } from '../lib/lineStyle'
import { EndTag, TeilstueckFork, hasLineDecor, lineLabel } from '../lib/lineDecor'
import { truppForLine, truppLineTone, truppTagText } from '../lib/truppLines'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import type { BoardAnno, Drawing, Entity, LngLat, Trupp } from '../types'
import s from './GeorefTwins.module.css'

export function GeorefContentBoard({ entities, drawings, fit, planAspect, sW, sH, byName, trupps = [], truppSeverities, interactive = false, selectedDrawingId, onOpenTeam, onMoveTeam, onOpenDrawing, onDrawingCoords, onDrawingDetach, onUnlockDrawing, onUnlockEntity, selectedTeamId, onSelectTeam, teamActions, hiddenTrails, onToggleTrail }: {
  entities: BoardEntityTwin[]
  drawings: BoardDrawingTwin[]
  fit: GeorefFit
  /** width / height of the fitted sheet; turns ground metres into plan-width fractions */
  planAspect: number
  sW: number
  sH: number
  byName: Record<string, string>
  /** the Atemschutz board, so a mirrored Leitung's tag carries its Trupp and clock tone */
  trupps?: Trupp[]
  truppSeverities?: Record<string, 1 | 2>
  /** the sheet is at rest (pan tool, no pairing) — only then may a projection answer a tap */
  interactive?: boolean
  selectedDrawingId?: string | null
  /** Tap on a mirrored team chip, note or shape: open its in-place source-backed panel (the
   *  workspace decides — a team chip used to jump surfaces, which read as a bug). The name is
   *  historic: Whiteboard wires it as `onTwinJump`, generic over every entity kind. */
  onOpenTeam?: (entity: Entity) => void
  /** Drag a mirrored team chip / note / shape to move its one source marker — the point handed
   *  back is in the SHEET's normalized space, folded through the fit by the Whiteboard exactly
   *  like a symbol twin's drag. Direct drag past the shared deadzone, no selection first: that
   *  is how this sheet's OWN chips move (chipDown), and the mirror keeps the surface's grammar.
   *  Without it a drag on the chip simply panned the board — «cannot be moved». */
  onMoveTeam?: (entity: Entity, pt: { x: number; y: number }, phase: 'start' | 'move' | 'end') => void
  /** Tap a mirrored map drawing: open the source-backed drawing editor on this sheet. */
  onOpenDrawing?: (drawing: Drawing) => void
  /** Whole-line and vertex drags write WGS84 coordinates to the one map-owned drawing. */
  onDrawingCoords?: (drawingId: string, coords: LngLat[], phase: 'start' | 'move' | 'end') => void
  /** clear one endpoint's attachment — grabbing an attached endpoint's grip detaches it first
   *  (the magnet machinery lives on the Karte; dragging the stored coord would fork the mirror) */
  onDrawingDetach?: (drawingId: string, endpoint: 'start' | 'end') => void
  /** Unlock a mirrored Karte line/area (its LockChip's only job). A locked source is
   *  click-through on BOTH surfaces — the lock is a property of the object, not of the sheet it
   *  happens to be drawn on — so the chip is the only door back in here too. */
  onUnlockDrawing?: (drawingId: string) => void
  /** …the same for a mirrored Karte Form (Entity.locked). */
  onUnlockEntity?: (entityId: string) => void
  /** the selected mirrored Truppmarker (Whiteboard holds it beside its other twin selections,
   *  so the shared outside-tap dismissal closes it like everything else) */
  selectedTeamId?: string | null
  onSelectTeam?: (id: string) => void
  /** The mirrored Truppmarker's context bar — the SAME bar the original wears on the Karte
   *  (twin equivalence, round 7: the big panel «looked rather ugly» and stacked wrong). Every
   *  action writes the ONE map entity; absent on a locked surface (tap then opens the
   *  read-only plaque via onOpenTeam instead). */
  teamActions?: {
    rename: (id: string, name: string) => void
    pick: (id: string, truppId?: string) => void
    color: (e: Entity, color: string | null) => void
    mark: (id: string) => void
    clearTrail: (id: string) => void
    remove: (id: string) => void
    showTrupp: (truppId: string) => void
    toOriginal: (e: Entity) => void
  }
  /** the BOARD's own per-team trail visibility — one surface, one switch (Whiteboard state) */
  hiddenTrails?: ReadonlySet<string>
  onToggleTrail?: (id: string) => void
}) {
  /** The live gesture on a mirrored point mark (team chip, note, shape). `base` is where the
   *  mark STOOD at the press — the twin follows its source mid-drag, so the cumulative delta
   *  must be added to a FIXED point (GeorefTwinsBoard carries the same warning). One ref: only
   *  one mark is ever dragged at a time. */
  const chipDrag = useRef<{ pid: number; x: number; y: number; base: { x: number; y: number }; entity: Entity; moved: boolean } | null>(null)
  // inline rename on the selected team pill (the bar's pen) — same grammar as the sheet's own chip
  const [renamingTeamId, setRenamingTeamId] = useState<string | null>(null)
  /** The shared tap/drag handlers of every interactive point mark in this layer — one grammar
   *  for the chip, the note and the shape, matching the sheet's own chipDown (deadzone first,
   *  a tap is never a nudge). */
  const pointHandlers = (entity: Entity, base: { x: number; y: number }, movable: boolean, jump?: () => void) => ({
    onPointerDown: (ev: React.PointerEvent<HTMLButtonElement>) => {
      // the sheet must not ALSO start a pan under the held mark
      ev.stopPropagation()
      // tracked even when tap-only, so the release can tell a tap from a slipped drag
      ev.currentTarget.setPointerCapture?.(ev.pointerId)
      chipDrag.current = { pid: ev.pointerId, x: ev.clientX, y: ev.clientY, base, entity, moved: false }
    },
    onPointerMove: (ev: React.PointerEvent) => {
      const d = chipDrag.current
      if (!movable || !d || d.pid !== ev.pointerId) return
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y
      // the shared deadzone every chip drag uses — a tap must never nudge the source
      if (!d.moved) {
        if (Math.hypot(dx, dy) < DRAG_DEADZONE_PX) return
        d.moved = true
        onMoveTeam!(d.entity, d.base, 'start')
      }
      onMoveTeam!(d.entity, {
        x: Math.max(0, Math.min(1, d.base.x + dx / sW)),
        y: Math.max(0, Math.min(1, d.base.y + dy / sH)),
      }, 'move')
    },
    onPointerUp: (ev: React.PointerEvent) => {
      const d = chipDrag.current
      if (!d || d.pid !== ev.pointerId) return
      chipDrag.current = null
      if (d.moved) {
        onMoveTeam!(d.entity, {
          x: Math.max(0, Math.min(1, d.base.x + (ev.clientX - d.x) / sW)),
          y: Math.max(0, Math.min(1, d.base.y + (ev.clientY - d.y) / sH)),
        }, 'end')
      } else if (jump) jump()
    },
    onPointerCancel: () => { const d = chipDrag.current; chipDrag.current = null; if (d?.moved) onMoveTeam!(d.entity, d.base, 'end') },
  })
  const drawingDrag = useRef<{
    pid: number; x: number; y: number; drawing: Drawing; moved: boolean; last: LngLat[]
  } | null>(null)
  /** An endpoint attached to a symbol is pinned there and re-resolves on the Karte — its stored
   *  coord must never be dragged from here, or the two surfaces fork (moveLineBody parity). */
  const pinnedVertex = (drawing: Drawing, i: number) =>
    (i === 0 && !!drawing.startAttachment) || (i === drawing.coords.length - 1 && !!drawing.endAttachment)
  const movedDrawingCoords = (drawing: Drawing, dx: number, dy: number): LngLat[] => {
    const pts = drawing.coords.map(([lng, lat]) => fit.toPlan({ lng, lat }))
    const movable = pts.filter((_, i) => !pinnedVertex(drawing, i))
    const minX = Math.min(...movable.map((p) => p.x)), maxX = Math.max(...movable.map((p) => p.x))
    const minY = Math.min(...movable.map((p) => p.y)), maxY = Math.max(...movable.map((p) => p.y))
    // ⚠️ A drawing whose bbox OVERHANGS the sheet (a hose line running past the Modul is
    // normal — twins are kept on mere overlap) has no in-sheet position at all: the clamp
    // bounds invert, and clamping through them would teleport the real Lage line by half a
    // sheet. Freeze that axis instead — the line still moves along the other one.
    const loX = -minX, hiX = 1 - maxX, loY = -minY, hiY = 1 - maxY
    const ddx = loX > hiX ? 0 : Math.max(loX, Math.min(hiX, dx / sW))
    const ddy = loY > hiY ? 0 : Math.max(loY, Math.min(hiY, dy / sH))
    return drawing.coords.map((c, i) => {
      if (pinnedVertex(drawing, i)) return c
      const m = fit.toMap({ x: pts[i].x + ddx, y: pts[i].y + ddy })
      return [m.lng, m.lat]
    })
  }
  const drawingHandlers = (drawing: Drawing) => ({
    onPointerDown: (ev: React.PointerEvent<SVGElement>) => {
      ev.stopPropagation()
      ev.currentTarget.setPointerCapture?.(ev.pointerId)
      drawingDrag.current = { pid: ev.pointerId, x: ev.clientX, y: ev.clientY, drawing, moved: false, last: drawing.coords }
    },
    onPointerMove: (ev: React.PointerEvent<SVGElement>) => {
      const d = drawingDrag.current
      if (!onDrawingCoords || !d || d.pid !== ev.pointerId) return
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y
      if (!d.moved) {
        if (Math.hypot(dx, dy) < DRAG_DEADZONE_PX) return
        d.moved = true
        onDrawingCoords(d.drawing.id, d.drawing.coords, 'start')
      }
      d.last = movedDrawingCoords(d.drawing, dx, dy)
      onDrawingCoords(d.drawing.id, d.last, 'move')
    },
    onPointerUp: (ev: React.PointerEvent<SVGElement>) => {
      const d = drawingDrag.current
      if (!d || d.pid !== ev.pointerId) return
      drawingDrag.current = null
      if (d.moved) onDrawingCoords?.(d.drawing.id, d.last, 'end')
      else onOpenDrawing?.(d.drawing)
    },
    onPointerCancel: () => {
      const d = drawingDrag.current
      drawingDrag.current = null
      if (d?.moved) onDrawingCoords?.(d.drawing.id, d.last, 'end')
    },
  })
  /** One live vertex gesture on a mirrored drawing — drag a node, insert-then-drag on a «+»,
   *  extend-then-drag on a grow arrow. Self-contained (capture + element listeners), because
   *  WbVertexHandles only hands over the pointerdown: the native surface routes moves through
   *  its stage, but this layer streams straight to the one map source (onDrawingCoords).
   *  `immediate` marks insert/extend: the gesture already changed the geometry, so it streams
   *  from the first event and a plain release still commits the new node (native grammar). */
  const beginVertexGesture = (drawing: Drawing, coords: LngLat[], index: number, e: React.PointerEvent, immediate: boolean) => {
    if (!onDrawingCoords) return
    e.stopPropagation(); e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture?.(e.pointerId)
    const pid = e.pointerId
    const st = { x: e.clientX, y: e.clientY, moved: immediate, last: coords }
    const src = coords[index]
    const p0 = fit.toPlan({ lng: src[0], lat: src[1] })
    // grabbing an ATTACHED endpoint detaches it (once, on the first real movement): the magnet
    // lives on the Karte, and dragging the stored coord while the attachment re-resolves there
    // would fork the two surfaces. A plain tap never detaches.
    const endpoint = drawing.kind === 'line' && index === 0 && drawing.startAttachment ? 'start' as const
      : drawing.kind === 'line' && index === coords.length - 1 && drawing.endAttachment ? 'end' as const : null
    let detached = false
    const begin = () => {
      if (endpoint && !detached) { detached = true; onDrawingDetach?.(drawing.id, endpoint) }
      onDrawingCoords(drawing.id, drawing.coords, 'start')
    }
    if (immediate) { begin(); onDrawingCoords(drawing.id, coords, 'move') }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return
      if (!st.moved) {
        if (Math.hypot(ev.clientX - st.x, ev.clientY - st.y) < DRAG_DEADZONE_PX) return
        st.moved = true
        begin()
      }
      const c = fit.toMap({
        x: Math.max(0, Math.min(1, p0.x + (ev.clientX - st.x) / sW)),
        y: Math.max(0, Math.min(1, p0.y + (ev.clientY - st.y) / sH)),
      })
      st.last = coords.map((q, i) => (i === index ? [c.lng, c.lat] as LngLat : q))
      onDrawingCoords(drawing.id, st.last, 'move')
    }
    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', finish)
      el.removeEventListener('pointercancel', finish)
      if (st.moved) onDrawingCoords(drawing.id, st.last, 'end')
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', finish)
    el.addEventListener('pointercancel', finish)
  }
  /** The native surface's full vertex vocabulary (WbVertexHandles) on a mirrored drawing —
   *  grips, «+» midpoints, hold-to-delete, Verlängern arrows. 1:1, doctrine 30.08. round 8. */
  const twinVertexProps = (drawing: Drawing) => ({
    onVertexDown: (idx: number, e: React.PointerEvent) => beginVertexGesture(drawing, drawing.coords, idx, e, false),
    onInsert: (segIdx: number, e: React.PointerEvent) => {
      const n = drawing.coords.length
      const a = drawing.coords[segIdx], b = drawing.coords[(segIdx + 1) % n]
      const coords = [...drawing.coords]
      coords.splice(segIdx + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
      beginVertexGesture(drawing, coords, segIdx + 1, e, true)
    },
    onDeleteVertex: (idx: number) => {
      if (!onDrawingCoords || drawing.coords.length <= (drawing.kind === 'area' ? 3 : 2)) return
      onDrawingCoords(drawing.id, drawing.coords, 'start')
      onDrawingCoords(drawing.id, drawing.coords.filter((_, i) => i !== idx), 'end')
    },
    onExtend: (ep: 'start' | 'end', e: React.PointerEvent) => {
      const pts = drawing.coords.map(([lng, lat]) => fit.toPlan({ lng, lat }))
      const i = ep === 'start' ? 0 : pts.length - 1
      const nb = ep === 'start' ? pts[1] : pts[pts.length - 2]
      const dx = (pts[i].x - nb.x) * sW, dy = (pts[i].y - nb.y) * sH
      const len = Math.hypot(dx, dy) || 1
      const g = fit.toMap({ x: pts[i].x + (dx / len) * EXTEND_STEP_PX / sW, y: pts[i].y + (dy / len) * EXTEND_STEP_PX / sH })
      const coords: LngLat[] = ep === 'start' ? [[g.lng, g.lat], ...drawing.coords] : [...drawing.coords, [g.lng, g.lat]]
      beginVertexGesture(drawing, coords, ep === 'start' ? 0 : coords.length - 1, e, true)
    },
  })
  if (!sW || !sH || (!entities.length && !drawings.length)) return null

  const trailAnnos: BoardAnno[] = entities.flatMap(({ entity }) => {
    if (entity.kind !== 'team' || (entity.trail?.length ?? 0) < 2 || hiddenTrails?.has(entity.id)) return []
    return [{
      id: `twin-trail-${entity.id}`, kind: 'resource', color: entity.color,
      trail: entity.trail!.map(({ coord, t }) => {
        const p = fit.toPlan({ lng: coord[0], lat: coord[1] })
        return { x: p.x, y: p.y, t }
      }),
    }]
  })
  const ink = [...drawings.map((d) => d.anno), ...trailAnnos]
  /** anno id → Atemschutz alarm tone, so a mirrored Leitung wears the SAME halo the sheet's own
   *  Leitungen wear (WbControls · truppTones). It is the loudest thing either surface says about
   *  people being overdue; the end tag alone did not carry it across (01.09.). */
  const truppTones = Object.fromEntries(drawings.flatMap(({ anno }) => {
    const tr = anno.kind === 'draw' ? truppForLine(anno, trupps) : undefined
    const tone = tr ? truppLineTone(tr, truppSeverities?.[tr.id] ?? 0) : 'idle'
    return tone === 'warn' || tone === 'crit' ? [[anno.id, tone] as const] : []
  }))
  // PlanScale/georef units are aspect-corrected: one normalized sheet width is ar·mPerU metres.
  const planWidthM = Math.max(0.001, fit.scaleMPerU * planAspect)

  return (
    // not aria-hidden any more: the mirrored team chips answer a tap (onOpenTeam)
    <div className={s.contentBoard}>
      <WbInkLayer annos={ink} draft={null} draftFloor={0} color="#1f6feb" width={5} dashed={false}
        hiddenTrails={new Set()} mapY={(_floor, y) => y} truppTones={truppTones} />
      {interactive && (onOpenDrawing || onDrawingCoords) && (
        <svg className={s.drawingHits} width={sW} height={sH} viewBox={`0 0 ${sW} ${sH}`} aria-hidden={false}>
          {drawings.map(({ key, anno, drawing }) => {
            const pts = (anno.pts ?? []).map(([x, y]) => `${x * sW},${y * sH}`).join(' ')
            // a LOCKED source has no hit surface at all — its ink is click-through here exactly
            // as it is on the Karte, and the LockChip below is the only tap target it keeps
            if (!pts || drawing.locked) return null
            const common = {
              role: 'button', tabIndex: 0, 'aria-label': lineLabel(drawing),
              className: s.drawingHit,
              onKeyDown: (ev: React.KeyboardEvent<SVGElement>) => {
                if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onOpenDrawing?.(drawing) }
              },
              ...drawingHandlers(drawing),
            }
            return drawing.kind === 'area' || drawing.kind === 'circle'
              ? <polygon key={key} {...common} points={pts} fill="transparent" stroke="transparent" strokeWidth={22} />
              : <polyline key={key} {...common} points={pts} fill="none" stroke="transparent" strokeWidth={22} />
          })}
        </svg>
      )}
      {/* the SELECTED mirrored drawing wears the sheet's full native vertex vocabulary —
          the same WbVertexHandles the sheet's own lines use (grips, «+» midpoints,
          hold-to-delete, Verlängern), every gesture writing the one map source. Attached
          endpoints keep their grips: grabbing one detaches (beginVertexGesture). */}
      {interactive && onDrawingCoords && drawings.flatMap((t) => {
        if (t.drawing.id !== selectedDrawingId || t.drawing.kind === 'circle' || t.drawing.locked) return []
        return [<WbVertexHandles key={`vh-${t.key}`} anno={t.anno} sW={sW} sH={sH}
          mapY={(_f, y) => y} {...twinVertexProps(t.drawing)} />]
      })}
      {/* unlock chip on every locked mirrored line/area/Form — the click-through ink's only tap
          target, a SHORT HOLD to unlock, at the same anchor the sheet's own locked annotations
          use (Whiteboard · wb-lock-anchor): an area at its centroid, a line at its middle vertex,
          a Form at its centre. Absent where editing is locked anyway. */}
      {interactive && (onUnlockDrawing || onUnlockEntity) && [
        ...(onUnlockDrawing ? drawings.filter(({ drawing }) => drawing.locked).flatMap(({ key, anno, drawing }) => {
          const pts = anno.pts ?? []
          if (!pts.length) return []
          const at = anno.kind === 'area'
            ? [pts.reduce((sum, q) => sum + q[0], 0) / pts.length, pts.reduce((sum, q) => sum + q[1], 0) / pts.length]
            : pts[Math.floor((pts.length - 1) / 2)]
          return [<span key={`lk-${key}`} className="wb-lock-anchor" style={{ left: at[0] * sW, top: at[1] * sH }}>
            <LockChip onUnlock={() => onUnlockDrawing(drawing.id)} />
          </span>]
        }) : []),
        ...(onUnlockEntity ? entities.filter(({ entity }) => entity.kind === 'shape' && entity.locked).map(({ key, entity, pt }) => (
          <span key={`lk-${key}`} className="wb-lock-anchor" style={{ left: pt.x * sW, top: pt.y * sH }}>
            <LockChip onUnlock={() => onUnlockEntity(entity.id)} />
          </span>
        )) : []),
      ]}
      {/* line/area decorations — the same feature set the sheet's own annotations render
          (Whiteboard's decor pass), minus every drag affordance: this layer is a projection. */}
      {drawings.flatMap(({ key, anno, drawing }) => {
        if (!anno.pts?.length) return []
        const bpx = anno.pts.map(([x, y]) => [x * sW, y * sH] as [number, number])
        const color = anno.color || '#1f6feb'
        const isArea = anno.kind === 'area'
        const out: React.ReactNode[] = []

        // labels: Länge/Fläche from the source geometry + the free text, at midpoint/centroid
        const anchor = isArea
          ? [bpx.reduce((sum, p) => sum + p[0], 0) / bpx.length, bpx.reduce((sum, p) => sum + p[1], 0) / bpx.length]
          : bpx[Math.floor((bpx.length - 1) / 2)]
        const lines: string[] = []
        if (anno.showDistance && !isArea) {
          const len = pathLengthM(drawing.coords)
          lines.push(`${fmtDistance(len)} · ${hoseLengthHint(len)}`)
        }
        if (anno.showDistance && isArea && drawing.kind !== 'circle') lines.push(fmtArea(polygonAreaM2(drawing.coords)))
        if (anno.label) lines.push(anno.label)
        if (lines.length) {
          out.push(<span key={`label-${key}`} className={`wb-line-label${isArea ? ' wb-area-label' : ''}`}
            style={{ left: 0, top: 0, transform: `translate(${anchor[0] + (anno.labelDx ?? 0) * sW}px, ${anchor[1] + (anno.labelDy ?? 0) * sH}px) translate(-50%, ${isArea ? '-50%' : '-100%'})` }}>
            {lines.map((t, j) => <div key={j}>{t}</div>)}
          </span>)
        }
        // an Absperrkreis states its radius at the ring's top edge, exactly as the map does
        if (drawing.kind === 'circle' && (drawing.radiusM ?? 0) > 0) {
          const top = bpx.reduce((best, p) => (p[1] < best[1] ? p : best), bpx[0])
          out.push(<span key={`radius-${key}`} className="wb-line-label"
            style={{ left: 0, top: 0, transform: `translate(${top[0]}px, ${top[1]}px) translate(-50%, -100%)` }}>
            {fmtDistance(drawing.radiusM!)}
          </span>)
        }
        if (isArea || bpx.length < 2 || !(anno.arrow || anno.marker || hasLineDecor(anno))) return out

        // arrowhead at the tip, sized to the line weight — same maths as the sheet's own pass
        const end = bpx[bpx.length - 1]
        const ahw = Math.max(7, (anno.width ?? 5) * 1.7)
        const ahl = ahw * 2.1
        const ref = lookbackPoint(bpx, Math.max(ahl, 16))
        const dxr = end[0] - ref[0], dyr = end[1] - ref[1]
        const dlen = Math.hypot(dxr, dyr) || 1
        const ang = Math.atan2(dyr, dxr) * 180 / Math.PI
        if (anno.arrow) {
          const fwd = (anno.width ?? 5) * 0.6 + 6
          const tip: [number, number] = [end[0] + (dxr / dlen) * fwd, end[1] + (dyr / dlen) * fwd]
          out.push(<svg key={`arrow-${key}`} className="wb-arrowhead" width="80" height="80" viewBox="-40 -40 80 80" aria-hidden
            style={{ left: 0, top: 0, color, transform: `translate(${tip[0]}px, ${tip[1]}px) translate(-50%, -50%)` }}>
            <path transform={`rotate(${ang})`} d={`M0,0 L${-ahl},${-ahw} L${-ahl},${ahw} Z`} fill="currentColor" />
            {anno.arrowStop && <path transform={`rotate(${ang})`} d={`M4,${-ahw * 1.3} L4,${ahw * 1.3}`} stroke="currentColor" strokeWidth={Math.max(3, (anno.width ?? 5) * 0.9)} strokeLinecap="round" fill="none" />}
          </svg>)
        }
        if (anno.teilstueck) {
          out.push(<span key={`fork-${key}`} className="wb-line-deco" style={{ transform: `translate(${end[0]}px, ${end[1]}px) translate(-50%, -50%)` }}>
            <TeilstueckFork angleDeg={ang} color={color} width={anno.width ?? 5} />
          </span>)
        }
        const lineTrupp = truppForLine(anno, trupps)
        if (anno.content || anno.lineNo != null || anno.floorTag != null || lineTrupp) {
          const pe = bpx[bpx.length - 1]
          const pp = bpx[bpx.length - 2] ?? pe
          const ax = pp[0] + (pe[0] - pp[0]) * 0.72 + (anno.endDx ?? 0) * sW
          const ay = pp[1] + (pe[1] - pp[1]) * 0.72 + (anno.endDy ?? -0.02) * sH
          out.push(<span key={`tag-${key}`} className="wb-line-deco" style={{ transform: `translate(${ax}px, ${ay}px) translate(-50%, -50%)` }}>
            <EndTag
              lineNo={anno.lineNo} content={anno.content} floorTag={anno.floorTag}
              trupp={lineTrupp ? truppTagText(lineTrupp) : undefined}
              tone={lineTrupp ? truppLineTone(lineTrupp, truppSeverities?.[lineTrupp.id] ?? 0) : 'idle'}
              color={color}
            />
          </span>)
        }
        if (anno.marker) {
          // identical to the native Plan line (Whiteboard): the twin doctrine says a projection
          // paints exactly like the object beside it, chain glyphs included
          const mps = markerParamsAlong(bpx, markerSpacing(anno.marker))
            .map(({ seg, t, deg }) => ({ at: lerpPoint(bpx[seg], bpx[seg + 1], t), deg }))
          const pts = mps.length ? mps : [{ at: anchor, deg: 0 }]
          for (const [i, mp] of pts.entries()) {
            out.push(<span key={`mk-${key}-${i}`} className={markerGlyph(anno.marker) ? 'wb-line-glyph' : 'wb-line-marker'}
              style={{ left: 0, top: 0, color, transform: `translate(${mp.at[0]}px, ${mp.at[1]}px) translate(-50%, -50%)` }}>
              <LineMarker marker={anno.marker} color={color} deg={mp.deg} className="wb-line-mk" />
            </span>)
          }
        }
        return out
      })}
      {entities.map(({ key, entity, pt }) => {
        const pos: CSSProperties = { left: pt.x * sW, top: pt.y * sH }
        const jump = interactive && onOpenTeam ? () => onOpenTeam(entity) : undefined
        const movable = interactive && !!onMoveTeam
        const tappable = !!jump || movable
        const grabStyle = movable ? { touchAction: 'none' as const, cursor: 'grab' } : null
        const title = fillTemplate(appConfig.copy.whiteboard.georef.twinFromMap, { name: contentTwinName(entity) })
        if (entity.kind === 'shape') {
          const px = Math.max(12, ((entity.sizeM ?? 40) / planWidthM) * sW)
          // sizeM is the WIDTH; the height follows the source's stretched box (Entity.aspect)
          const kind = entity.shape ?? 'square'
          const style = { ...pos, width: px, height: px * shapeAspect(kind, entity.aspect), transform: `translate(-50%, -50%) rotate(${(entity.rotation ?? 0) + fit.rotationDeg}deg)` }
          const glyph = <ShapeGlyph kind={kind} color={entity.color ?? '#1f6feb'} stop={entity.stop} aspect={entity.aspect} carrier={entity.carrier} reverse={entity.reverse} strokeW={entity.strokeW} boxPx={px} fillOpacity={entity.fillOpacity} hatch={entity.hatch} sharpCorners={entity.sharpCorners} />
          // a LOCKED Form is click-through, exactly as it is on the Karte (MapMarkers ·
          // lockedShape) — the LockChip above is the only door back in
          if (!tappable || entity.locked) {
            return <div key={key} className={`${s.contentPoint} shape-glyph`} style={style}>{glyph}</div>
          }
          return <button key={key} type="button" className={`${s.contentPoint} ${s.contentTap} shape-glyph`}
            style={{ ...style, ...grabStyle }} title={title} data-twin=""
            {...pointHandlers(entity, pt, movable, jump)}>{glyph}</button>
        }
        if (entity.kind === 'note') {
          const tinted = !entity.notePlain && !!entity.color
          const cls = `note-pill box${entity.notePlain ? ' plain' : ''}${tinted ? ' tinted' : ''}`
          const style = {
            ...pos, width: noteWPx(entity.noteW), fontSize: 12 * noteScale(entity.noteSize),
            transform: 'translate(-50%, -50%)',
            ...(entity.color ? (entity.notePlain ? { color: entity.color } : { '--note-tint': entity.color }) : null),
          } as CSSProperties
          const text = entity.label || appConfig.copy.whiteboard.text
          if (!tappable) return <span key={key} className={`${s.contentPoint} ${cls}`} style={style}>{text}</span>
          return <button key={key} type="button" className={`${s.contentPoint} ${s.contentTap} ${cls}`}
            style={{ ...style, ...grabStyle }} title={title} data-twin=""
            {...pointHandlers(entity, pt, movable, jump)}>{text}</button>
        }
        if (entity.kind === 'team') {
          const teamCol = entity.color || appConfig.drawing.teamColors[0]
          const isRaus = !!entity.truppId && trupps.some((t) => t.id === entity.truppId && t.status === 'raus')
          const selected = interactive && !!teamActions && selectedTeamId === entity.id
          // ⚠️ A Trupp marker is a STRIP — [dot][gap][name] — so the whole strip centred put half
          // the NAME's width between the dot and the point it states. Anchored by its LEFT edge
          // with half a dot taken back, the dot sits ON the point and the name hangs off it; the
          // selected pill takes its accent cap back instead, so selecting doesn't shift it. Exactly
          // the geometry the Karte original uses (MapMarkers · Marker anchor="left" + offset) —
          // twins must state the same point the same way, or a transferred Trupp visibly jumps.
          const teamStyle = (pill: boolean) => ({
            ...pos,
            transform: `translate(${pill ? -TEAM_PILL_CAP_PX : -TEAM_DOT_PX / 2}px, -50%)`,
            '--team': teamCol,
          } as CSSProperties)
          // unlocked: the tap SELECTS (the original's grammar — pill + bar appear); locked:
          // fall through to the read-only plaque the workspace opens (onOpenTeam)
          const teamJump = teamActions && onSelectTeam ? () => onSelectTeam(entity.id) : jump
          if (!tappable) {
            return <span key={key} className={`${s.contentPoint} team-dot ${isRaus ? 'raus' : ''}`} style={teamStyle(false)}>
              <i /><b>{entity.label}</b>
            </span>
          }
          if (!selected) {
            // ⚠️ The button is a transparent HIT SHELL and the chip lives in an inner span with
            // the native class, exactly like the original's markup. Putting `team-dot` on the
            // button itself made the button the flex container — Safari lays a <button>'s
            // children out in an anonymous inner box, so align/stretch misplaced the pieces
            // (the round-9 field screenshot: cap floating beside the pill).
            return (
              <button key={key} type="button"
                className={`${s.contentPoint} ${s.contentTap}`}
                style={{ ...teamStyle(false), ...grabStyle }}
                title={title}
                data-twin=""
                {...pointHandlers(entity, pt, movable, teamJump)}
              >
                <span className={`team-dot ${isRaus ? 'raus' : ''}`}><i /><b>{entity.label}</b></span>
              </button>
            )
          }
          // Selected: the SAME pill + context bar the original wears on the Karte (twin
          // equivalence) — cap, name (inline rename for a loose marker), timestamp, and the
          // identical action row, plus one twin-only door: «Auf Karte zeigen».
          const acts = teamActions!
          const trailCount = entity.trail?.length ?? 0
          const boundAlive = !!entity.truppId && trupps.some((t) => t.id === entity.truppId && !t.removedAt)
          return (
            <span key={key} className={s.contentPoint} style={teamStyle(true)} data-twin="">
              {/* hit shell again (see the resting dot above): the pill span carries the native
                  class untouched, so its flex row, padding and background can never lose a
                  cascade or button-quirk fight */}
              <button type="button" className={s.contentTap}
                style={grabStyle ?? undefined} title={title}
                {...pointHandlers(entity, pt, movable)}>
                <span className={`wb-resource-pill ${isRaus ? 'raus' : ''}`} style={{ '--team': teamCol } as CSSProperties}>
                  <span className="wb-resource-cap" />
                  <span className="wb-resource-body">
                    <span className="wb-resource-name">
                      {renamingTeamId === entity.id
                        ? <input className="wb-resource-input" autoFocus defaultValue={entity.label ?? ''}
                            onPointerDown={(ev) => ev.stopPropagation()}
                            onBlur={(ev) => { acts.rename(entity.id, ev.target.value); setRenamingTeamId(null) }}
                            onKeyDown={(ev) => {
                              if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur()
                              if (ev.key === 'Escape') { ev.stopPropagation(); setRenamingTeamId(null) }
                            }} />
                        : <b>{entity.label}</b>}
                      {isRaus && <span className="wb-resource-raus">{appConfig.copy.atemschutz.status.raus}</span>}
                    </span>
                    {entity.t && <i className="wb-resource-time">{entity.t}</i>}
                  </span>
                </span>
              </button>
              <div className="wb-pill-acts" onPointerDown={(ev) => ev.stopPropagation()}>
                {!entity.truppId && (
                  <button className="wb-pa" title={appConfig.copy.edit} aria-label={appConfig.copy.edit}
                    onClick={() => setRenamingTeamId(entity.id)}><Icon id="pen" /></button>
                )}
                {entity.truppId && (
                  <button className="wb-pa wb-pa-show" title={appConfig.copy.whiteboard.showTrupp} aria-label={appConfig.copy.whiteboard.showTrupp}
                    onClick={() => acts.showTrupp(entity.truppId!)}><Icon id="warn" /></button>
                )}
                {(!!entity.truppId || trupps.some((t) => !t.removedAt && t.status !== 'raus')) && (
                  <Menu
                    popupClassName="de-menu-pop"
                    itemClassName={() => 'de-menu-item'}
                    trigger={
                      <button className="wb-pa" title={appConfig.copy.atemschutz.markerLabel} aria-label={appConfig.copy.atemschutz.markerLabel}>
                        <Icon id="people" />
                      </button>
                    }
                    items={[
                      { label: <MenuPick label={appConfig.copy.atemschutz.markerNone} on={!entity.truppId} />, onClick: () => acts.pick(entity.id, undefined) },
                      ...trupps.filter((t) => !t.removedAt && (t.status !== 'raus' || t.id === entity.truppId)).map((t) => ({
                        label: <MenuPick label={t.name} on={t.id === entity.truppId} />,
                        onClick: () => acts.pick(entity.id, t.id),
                      })),
                    ]}
                  />
                )}
                {!boundAlive && (
                  <Popover
                    ariaLabel={appConfig.copy.atemschutz.colorLabel}
                    popupClassName="wb-pa-colors"
                    trigger={
                      <button className="wb-pa" title={appConfig.copy.atemschutz.colorLabel} aria-label={appConfig.copy.atemschutz.colorLabel}>
                        <span className="wb-pa-swatch" style={{ background: entity.color || 'transparent' }} />
                      </button>
                    }
                  >
                    <PopoverClose className={`ctx-team-auto${entity.color ? '' : ' on'}`} onClick={() => acts.color(entity, null)}>
                      {appConfig.copy.atemschutz.colorAuto}
                    </PopoverClose>
                    {appConfig.drawing.teamColors.map((c) => (
                      <PopoverClose key={c} className={`dh-color${entity.color === c ? ' on' : ''}`} onClick={() => acts.color(entity, c)}>
                        <span style={{ background: c }} />
                      </PopoverClose>
                    ))}
                  </Popover>
                )}
                <button className="wb-pa wb-pa-mark" title={appConfig.copy.whiteboard.markPosition} aria-label={appConfig.copy.whiteboard.markPosition}
                  onClick={() => acts.mark(entity.id)}><Icon id="flag" /></button>
                {trailCount > 0 && onToggleTrail && (() => {
                  const shown = !hiddenTrails?.has(entity.id)
                  return (
                    <button className="wb-pa" title={shown ? appConfig.copy.whiteboard.trailsOff : appConfig.copy.whiteboard.trailsOn}
                      aria-label={appConfig.copy.whiteboard.trails} aria-pressed={shown} onClick={() => onToggleTrail(entity.id)}>
                      <Icon id={shown ? 'eye' : 'eyeoff'} />
                    </button>
                  )
                })()}
                {/* the twin's one extra door: pan the Karte to the original */}
                <button className="wb-pa" title={appConfig.copy.contextPanel.showOnMap} aria-label={appConfig.copy.contextPanel.showOnMap}
                  onClick={() => acts.toOriginal(entity)}><Icon id="external" /></button>
                {trailCount > 0
                  ? <button className="wb-pa wb-pa-del-off" title={appConfig.copy.whiteboard.deleteLocked} aria-label={appConfig.copy.whiteboard.deleteLocked}
                      onClick={() => acts.clearTrail(entity.id)}><Icon id="trash" /></button>
                  : <button className="wb-pa wb-pa-del" title={appConfig.copy.delete} aria-label={appConfig.copy.delete}
                      onClick={() => acts.remove(entity.id)}><Icon id="trash" /></button>}
              </div>
            </span>
          )
        }
        // Shared responder positions are live map facts, not tactical symbols. Preserve their
        // own ringed-initials SVG so a projected phone fix cannot be mistaken for a placed unit.
        // Deliberately NOT tappable/draggable: a GPS fix is somebody's self-report — there is
        // nothing an operator may honestly move or edit through it.
        if (entity.kind === 'person') {
          return <span key={key} className={s.contentPoint} style={{ ...pos, width: 28, height: 28, transform: 'translate(-50%, -50%)' }}>
            <TacticalSymbol svg={glyphFor(entity, byName)} sizePx={28} rotation={0} caption={entity.label} />
          </span>
        }
        return null
      })}
    </div>
  )
}
