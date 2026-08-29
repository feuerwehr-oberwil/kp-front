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
import { useRef, type CSSProperties } from 'react'
import type { GeorefFit } from '../lib/georef'
import { DRAG_DEADZONE_PX } from '../lib/useHoldToDrag'
import { contentTwinName, type BoardDrawingTwin, type BoardEntityTwin } from '../lib/georefTwins'
import { WbInkLayer } from './WbControls'
import { ShapeGlyph, shapeAspect } from '../lib/shapes'
import { TacticalSymbol } from '../lib/symbolRender'
import { glyphFor } from '../lib/twinGlyph'
import { noteScale, noteWPx } from '../lib/notes'
import { fmtArea, fmtDistance, hoseLengthHint, pathLengthM, polygonAreaM2 } from '../lib/geo'
import { lerpPoint, lookbackPoint, markerParamsAlong } from '../lib/lineStyle'
import { EndTag, TeilstueckFork, hasLineDecor, lineLabel } from '../lib/lineDecor'
import { truppForLine, truppLineTone, truppTagText } from '../lib/truppLines'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import type { BoardAnno, Drawing, Entity, LngLat, Trupp } from '../types'
import s from './GeorefTwins.module.css'

export function GeorefContentBoard({ entities, drawings, fit, planAspect, sW, sH, byName, trupps = [], truppSeverities, interactive = false, selectedDrawingId, onOpenTeam, onMoveTeam, onOpenDrawing, onDrawingCoords }: {
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
}) {
  /** The live gesture on a mirrored point mark (team chip, note, shape). `base` is where the
   *  mark STOOD at the press — the twin follows its source mid-drag, so the cumulative delta
   *  must be added to a FIXED point (GeorefTwinsBoard carries the same warning). One ref: only
   *  one mark is ever dragged at a time. */
  const chipDrag = useRef<{ pid: number; x: number; y: number; base: { x: number; y: number }; entity: Entity; moved: boolean } | null>(null)
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
  const vertexDrag = useRef<{ pid: number; x: number; y: number; drawing: Drawing; index: number; moved: boolean; last: LngLat[] } | null>(null)
  const vertexHandlers = (drawing: Drawing, index: number) => ({
    onPointerDown: (ev: React.PointerEvent<HTMLButtonElement>) => {
      ev.stopPropagation(); ev.preventDefault()
      ev.currentTarget.setPointerCapture?.(ev.pointerId)
      vertexDrag.current = { pid: ev.pointerId, x: ev.clientX, y: ev.clientY, drawing, index, moved: false, last: drawing.coords }
    },
    onPointerMove: (ev: React.PointerEvent<HTMLButtonElement>) => {
      const d = vertexDrag.current
      if (!onDrawingCoords || !d || d.pid !== ev.pointerId) return
      if (!d.moved) {
        if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < DRAG_DEADZONE_PX) return
        d.moved = true
        onDrawingCoords(d.drawing.id, d.drawing.coords, 'start')
      }
      const source = d.drawing.coords[d.index]
      const p = fit.toPlan({ lng: source[0], lat: source[1] })
      const c = fit.toMap({
        x: Math.max(0, Math.min(1, p.x + (ev.clientX - d.x) / sW)),
        y: Math.max(0, Math.min(1, p.y + (ev.clientY - d.y) / sH)),
      })
      d.last = d.drawing.coords.map((q, i) => i === d.index ? [c.lng, c.lat] : q)
      onDrawingCoords(d.drawing.id, d.last, 'move')
    },
    onPointerUp: (ev: React.PointerEvent<HTMLButtonElement>) => {
      const d = vertexDrag.current
      if (!d || d.pid !== ev.pointerId) return
      vertexDrag.current = null
      if (d.moved) onDrawingCoords?.(d.drawing.id, d.last, 'end')
    },
    onPointerCancel: () => {
      const d = vertexDrag.current
      vertexDrag.current = null
      if (d?.moved) onDrawingCoords?.(d.drawing.id, d.last, 'end')
    },
  })
  if (!sW || !sH || (!entities.length && !drawings.length)) return null

  const trailAnnos: BoardAnno[] = entities.flatMap(({ entity }) => {
    if (entity.kind !== 'team' || (entity.trail?.length ?? 0) < 2) return []
    return [{
      id: `twin-trail-${entity.id}`, kind: 'resource', color: entity.color,
      trail: entity.trail!.map(({ coord, t }) => {
        const p = fit.toPlan({ lng: coord[0], lat: coord[1] })
        return { x: p.x, y: p.y, t }
      }),
    }]
  })
  const ink = [...drawings.map((d) => d.anno), ...trailAnnos]
  // PlanScale/georef units are aspect-corrected: one normalized sheet width is ar·mPerU metres.
  const planWidthM = Math.max(0.001, fit.scaleMPerU * planAspect)

  return (
    // not aria-hidden any more: the mirrored team chips answer a tap (onOpenTeam)
    <div className={s.contentBoard}>
      <WbInkLayer annos={ink} draft={null} draftFloor={0} color="#1f6feb" width={5} dashed={false}
        hiddenTrails={new Set()} mapY={(_floor, y) => y} />
      {interactive && (onOpenDrawing || onDrawingCoords) && (
        <svg className={s.drawingHits} width={sW} height={sH} viewBox={`0 0 ${sW} ${sH}`} aria-hidden={false}>
          {drawings.map(({ key, anno, drawing }) => {
            const pts = (anno.pts ?? []).map(([x, y]) => `${x * sW},${y * sH}`).join(' ')
            if (!pts) return null
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
      {interactive && onDrawingCoords && drawings.flatMap(({ drawing }) => {
        if (drawing.id !== selectedDrawingId || drawing.kind === 'circle') return []
        return drawing.coords.map(([lng, lat], index) => {
          // no handle on an attached endpoint: it is pinned to its Karte target — detach there
          if (pinnedVertex(drawing, index)) return null
          const p = fit.toPlan({ lng, lat })
          return <button key={`${drawing.id}:${index}`} type="button" className={s.contentVertex}
            data-testid={`twin-vertex-${index}`} aria-label={`${lineLabel(drawing)} · ${index + 1}`}
            style={{ left: p.x * sW, top: p.y * sH }} {...vertexHandlers(drawing, index)} />
        })
      })}
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
          const mps = markerParamsAlong(bpx).map(({ seg, t }) => lerpPoint(bpx[seg], bpx[seg + 1], t))
          for (const [i, mp] of (mps.length ? mps : [anchor]).entries()) {
            out.push(<span key={`mk-${key}-${i}`} className="wb-line-marker"
              style={{ left: 0, top: 0, color, transform: `translate(${mp[0]}px, ${mp[1]}px) translate(-50%, -50%)` }}>{anno.marker}</span>)
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
          const glyph = <ShapeGlyph kind={kind} color={entity.color ?? '#1f6feb'} stop={entity.stop} />
          if (!tappable) {
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
          const style = { ...pos, transform: 'translate(-50%, -50%)', '--team': entity.color || appConfig.drawing.teamColors[0] } as CSSProperties
          if (!tappable) {
            return <span key={key} className={`${s.contentPoint} team-dot`} style={style}>
              <i /><b>{entity.label}</b>
            </span>
          }
          return (
            <button key={key} type="button"
              className={`${s.contentPoint} ${s.contentTap} team-dot`}
              style={{ ...style, ...grabStyle }}
              title={title}
              data-twin=""
              {...pointHandlers(entity, pt, movable, jump)}
            >
              <i /><b>{entity.label}</b>
            </button>
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
