import type { BoardAnno, BoardPoint, BoardTool, NoteSize } from '../types'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { HatchDefs, LINE_DASH_SVG, hatchPatternId } from '../lib/draw'
import { ToolDock } from './ToolDock'
import { useNodeHold } from '../lib/nodeHold'
import { vertexHandleIndices, EXTEND_STEP_PX } from '../lib/lineStyle'
import { NodeDeleteChip } from './NodeDeleteChip'

const COLORS = appConfig.drawing.colors
/** id namespace for the ink layer's Schraffur — its patterns are scaled against the 1×1 sheet and
 *  must not be handed to the px-space defs beside them (lib/draw · hatchPatternId). */
const INK_HATCH_SPACE = 'sheet'

interface InkProps {
  annos: BoardAnno[]
  draft: BoardPoint[] | null
  draftFloor: number
  draftClosed?: boolean // area tool: preview the draft as a closed/filled polygon
  color: string
  width: number
  dashed: boolean
  /** per-team hidden trails (anno ids) — a team's trail renders unless its id is in here */
  hiddenTrails: ReadonlySet<string>
  mapY: (floor: number | undefined, ly: number) => number
  selId?: string | null
  /** «schau hier»: one anno outlined for a few seconds without being SELECTED (no handles, no
   *  editor sheet) — the plan twin of MapView's flashDrawingId. */
  flashId?: string | null
  networkIds?: string[]
  /** select/drag a stroke / area by tapping it (pan mode only); omitted ⇒ not hittable */
  onPickDraw?: (id: string, e: React.PointerEvent) => void
  /** anno id → Atemschutz alarm tone for the Leitung it draws ('warn' | 'crit'). Those lines get
   *  a soft outline in that tone — the plan twin of the Lage's l-draw-atemschutz layer. */
  truppTones?: Record<string, 'warn' | 'crit'>
  /** the sheet's size in CSS px. Only the Schraffur needs it: this SVG is a 1×1 sheet stretched
   *  over the page, and an SVG pattern is measured in THAT space (lib/draw · HatchDefs). */
  sW: number
  sH: number
}

/**
 * The vector ink layer (single non-scaling-stroke SVG): committed freehand/line polylines, filled
 * areas, the in-progress draft, and team trails. When `onPickDraw` is given (pan mode), each shape
 * also gets a fat transparent hit surface so it can be tapped to select — the visible shape stays
 * non-interactive. (Line arrowheads + marker letters render OUTSIDE this layer, in board px, since
 * this SVG is stretched 1×1 and would distort them.)
 */
export function WbInkLayer({ annos, draft, draftFloor, draftClosed, color, width, dashed, hiddenTrails, mapY, selId, flashId, networkIds = [], onPickDraw, truppTones = {}, sW, sH }: InkProps) {
  const pointStr = (pts: BoardPoint[], floor: number | undefined) => pts.map((p) => `${p[0]},${mapY(p[2] ?? floor, p[1])}`).join(' ')
  // …and the Schraffur's own tile, stated in px and undone by the sheet's stretch — see HatchDefs.
  const hatchId = (c: string) => hatchPatternId(c, INK_HATCH_SPACE)
  return (
    <svg className="wb-ink-svg" viewBox="0 0 1 1" preserveAspectRatio="none">
      <HatchDefs colors={COLORS} space={INK_HATCH_SPACE} unitScale={[1 / Math.max(1, sW), 1 / Math.max(1, sH)]} />
      {/* filled areas (under the lines) */}
      {annos.filter((a) => a.kind === 'area' && a.pts && a.pts.length >= 3).map((a) => {
        const pts = pointStr(a.pts!, a.floor)
        return (
        <g key={a.id}>
          {selId === a.id && <polygon points={pts} fill="none" stroke="var(--blue)" strokeWidth={(a.width || 3) + 6} strokeOpacity={0.35} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
          <polygon points={pts} fill={a.hatch ? `url(#${hatchId(a.color || COLORS[0])})` : (a.color || COLORS[0])}
            fillOpacity={a.hatch ? 1 : (a.fillOpacity ?? 0.14)}
            stroke={a.color || COLORS[0]} strokeWidth={a.width || 3} strokeDasharray={a.dashed ? LINE_DASH_SVG : undefined}
            strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {onPickDraw && <polygon points={pts} fill="transparent" stroke="transparent" strokeWidth={18}
            style={{ pointerEvents: 'all', cursor: 'grab' }} onPointerDown={(e) => onPickDraw(a.id, e)} />}
        </g>
        )
      })}
      {annos.filter((a) => a.kind === 'draw' && a.pts).map((a) => {
        const pts = pointStr(a.pts!, a.floor)
        return (
        <g key={a.id}>
          {truppTones[a.id] && (
            <polyline points={pts} fill="none" stroke={truppTones[a.id] === 'crit' ? 'var(--red)' : 'var(--amber)'}
              strokeWidth={(a.width || 5) + 8} strokeOpacity={0.45}
              strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          )}
          {networkIds.includes(a.id) && <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={(a.width || 5) + 9} strokeOpacity={selId === a.id ? 0.34 : 0.16} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
          {flashId === a.id && (
            <polyline points={pts} fill="none" stroke="var(--blue)" strokeWidth={(a.width || 5) + 14}
              strokeOpacity={0.3} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          )}
          {selId === a.id && (
            <polyline points={pts} fill="none" stroke="var(--blue)" strokeWidth={(a.width || 5) + 6}
              strokeOpacity={0.35} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          )}
          <polyline
            points={pts}
            fill="none" stroke={a.color || COLORS[0]} strokeWidth={a.width || 5}
            strokeDasharray={a.dashed ? LINE_DASH_SVG : undefined}
            strokeLinecap={a.dashed ? 'butt' : 'round'} strokeLinejoin="round" vectorEffect="non-scaling-stroke"
          />
          {onPickDraw && (
            <polyline points={pts} fill="none" stroke="transparent" strokeWidth={18}
              strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
              style={{ pointerEvents: 'stroke', cursor: 'grab' }}
              onPointerDown={(e) => onPickDraw(a.id, e)} />
          )}
        </g>
        )
      })}
      {draft && draft.length >= 2 && (
        draftClosed && draft.length >= 3
          ? <polygon points={pointStr(draft, draftFloor)} fill={color} fillOpacity={0.12} stroke={color} strokeWidth={width} strokeDasharray={dashed ? LINE_DASH_SVG : undefined} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          : <polyline points={pointStr(draft, draftFloor)} fill="none" stroke={color} strokeWidth={width} strokeDasharray={dashed ? LINE_DASH_SVG : undefined} strokeLinecap={dashed ? 'butt' : 'round'} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      )}
      {/* team trails — path through the explicitly RECORDED positions only
          (not the live pill); non-scaling stroke keeps the weight constant */}
      {annos.filter((a) => a.kind === 'resource' && (a.trail?.length ?? 0) > 1 && !hiddenTrails.has(a.id)).map((a) => (
        <polyline
          key={`trail-${a.id}`}
          points={(a.trail ?? []).map((p) => `${p.x},${mapY(p.floor ?? a.floor, p.y)}`).join(' ')}
          fill="none" stroke={a.color || COLORS[0]} strokeWidth={2} strokeDasharray="5 5"
          strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" opacity={0.85}
        />
      ))}
    </svg>
  )
}

interface CircleProps {
  annos: BoardAnno[]
  /** the Absperrkreis being dragged out right now (centre + radius, plan-normalized) */
  draft: { x: number; y: number; floor: number; r: number } | null
  /** board size in px — this layer works in PIXELS, unlike the 1×1 ink layer above */
  sW: number
  sH: number
  mapY: (floor: number | undefined, ly: number) => number
  color: string
  selId?: string | null
  flashId?: string | null
  /** select/drag a circle by tapping it (pan mode only); omitted ⇒ not hittable */
  onPickCircle?: (id: string, e: React.PointerEvent) => void
}

/**
 * Absperrkreise (Gefahrenradius) — the plan twin of the Karte's `circle` drawings.
 *
 * ⚠️ Its own SVG, in BOARD PIXELS, and deliberately not part of WbInkLayer: that one is stretched
 * 1×1 with `preserveAspectRatio="none"`, where a circle can only be drawn as an ellipse whose
 * radii have to be re-derived from the sheet's aspect on every render. A plan circle is round in
 * pixels — its stored `radiusN` is a fraction of the plan WIDTH (types · BoardAnno.radiusN) — so
 * one px-space layer says it once and says it exactly, hatch pattern included.
 *
 * Painted UNDER the ink layer on purpose: a Leitung drawn across a big cordon must win the tap,
 * the same ordering rule the Karte states (MapView · handleClick).
 */
export function WbCircleLayer({ annos, draft, sW, sH, mapY, color, selId, flashId, onPickCircle }: CircleProps) {
  const W = Math.max(1, sW), H = Math.max(1, sH)
  return (
    <svg className="wb-ink-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <HatchDefs colors={COLORS} />
      {annos.filter((a) => a.kind === 'circle' && (a.radiusN ?? 0) > 0).map((a) => {
        const cx = (a.x ?? 0) * sW, cy = mapY(a.floor, a.y ?? 0) * sH
        const r = Math.max(1, (a.radiusN ?? 0) * sW)
        const ink = a.color || appConfig.drawing.circleColor
        const w = a.width ?? appConfig.drawing.circleLineWidth
        return (
          <g key={a.id}>
            {flashId === a.id && <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--blue)" strokeWidth={w + 14} strokeOpacity={0.3} />}
            {selId === a.id && <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--blue)" strokeWidth={w + 6} strokeOpacity={0.35} />}
            <circle cx={cx} cy={cy} r={r}
              fill={a.hatch ? `url(#${hatchPatternId(ink)})` : ink}
              fillOpacity={a.hatch ? 1 : (a.fillOpacity ?? appConfig.drawing.circleFillOpacity)}
              stroke={ink} strokeWidth={w} strokeDasharray={a.dashed ? LINE_DASH_SVG : undefined} />
            {/* a LOCKED circle is click-through — its LockChip is the only door (Whiteboard) */}
            {onPickCircle && !a.locked && (
              <circle cx={cx} cy={cy} r={r} fill="transparent" stroke="transparent" strokeWidth={18}
                style={{ pointerEvents: 'all', cursor: 'grab' }} onPointerDown={(e) => onPickCircle(a.id, e)} />
            )}
          </g>
        )
      })}
      {draft && (
        <circle cx={draft.x * sW} cy={mapY(draft.floor, draft.y) * sH} r={Math.max(1, draft.r * sW)}
          fill={color} fillOpacity={appConfig.drawing.circleFillOpacity}
          stroke={color} strokeWidth={appConfig.drawing.circleLineWidth} strokeDasharray={LINE_DASH_SVG} />
      )}
    </svg>
  )
}

/**
 * The ONE grip an Absperrkreis has: on the ring at screen-right, dragging its radius — the
 * gesture that placed it, available again afterwards. It wears the sheet's own node-grip look
 * (`.wb-vertex`), because that is what it is: a point you drag.
 *
 * It lives here beside the vertex handles rather than inline on the board so the drag handlers
 * stay plain props (the render pass then touches no gesture ref of the Whiteboard's).
 */
export function WbCircleHandle({ anno, sW, sH, mapY, onRadiusDown, onMove, onUp }: {
  anno: BoardAnno
  sW: number
  sH: number
  mapY: (floor: number | undefined, ly: number) => number
  onRadiusDown: (e: React.PointerEvent) => void
  onMove: (e: React.PointerEvent) => void
  onUp: () => void
}) {
  if (anno.kind !== 'circle') return null
  const cx = (anno.x ?? 0) * sW, cy = mapY(anno.floor, anno.y ?? 0) * sH
  const r = Math.max(1, (anno.radiusN ?? 0) * sW)
  return (
    <button className="wb-vertex" title={appConfig.copy.whiteboard.dragRadius} aria-label={appConfig.copy.whiteboard.dragRadius} data-holdaction
      style={{ left: 0, top: 0, transform: `translate(${cx + r}px, ${cy}px) translate(-50%, -50%)` }}
      onPointerDown={onRadiusDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onClick={(e) => e.stopPropagation()} />
  )
}

/**
 * Vertex handles for the IN-PROGRESS Punkte draft (node-mode Linie / Fläche) — the same grips and
 * «+» midpoint inserts a FINISHED shape gets (WbVertexHandles below), so the shape being laid down
 * is already editable in place instead of only append-only until ✓ (decided 29.08.). Slimmer than
 * the finished-shape variant on purpose: a draft has no attachments, no Verlängern arrows (the
 * next tap IS how it grows) and no thinning (node drafts are a handful of deliberate taps).
 * Positions are board px; classes are the shared `.wb-vertex` / `.wb-vins`, which already sit
 * above the `.wb-ink` capture overlay (z 6/7 vs 5), so the grips stay tappable mid-tool.
 */
export function WbDraftHandles({ pts, closed, draftFloor, sW, sH, mapY, onVertexDown, onInsert, onDeleteVertex }: {
  pts: BoardPoint[]
  /** area draft: the ring closes visually at ≥3 pts, so the closing edge gets a «+» too */
  closed: boolean
  draftFloor: number
  sW: number
  sH: number
  mapY: (floor: number | undefined, ly: number) => number
  onVertexDown: (idx: number, e: React.PointerEvent) => void
  onInsert: (idx: number, e: React.PointerEvent) => void
  onDeleteVertex: (idx: number) => void
}) {
  // still hold = delete, movement cancels into the reshape drag — the same gesture (and chip) as
  // on a finished shape, so the draft never teaches a second vocabulary.
  const vertexPress = useNodeHold()
  if (!pts.length) return null
  const sp: [number, number][] = pts.map(([x, y, floor]) => [x * sW, mapY(floor ?? draftFloor, y) * sH])
  const segs: number[] = []
  for (let i = 0; i < sp.length - 1; i++) segs.push(i)
  if (closed && sp.length >= 3) segs.push(sp.length - 1)
  return (
    <>
      {segs.map((i) => {
        const a = sp[i], b = sp[(i + 1) % sp.length]
        return (
          <button key={`dins-${i}`} className="wb-vins" title={appConfig.copy.whiteboard.insertVertex} aria-label={appConfig.copy.whiteboard.insertVertex}
            style={{ left: 0, top: 0, transform: `translate(${(a[0] + b[0]) / 2}px, ${(a[1] + b[1]) / 2}px) translate(-50%, -50%)` }}
            onPointerDown={(e) => onInsert(i, e)}><Icon id="plus" /></button>
        )
      })}
      {sp.map(([x, y], i) => (
        <button key={`dv-${i}`} className={`wb-vertex ${vertexPress.armed?.key === `d${i}` ? 'doomed' : ''}`}
          title={appConfig.copy.whiteboard.dragVertex} aria-label={appConfig.copy.whiteboard.dragVertex} data-holdaction
          style={{ left: 0, top: 0, transform: `translate(${x}px, ${y}px) translate(-50%, -50%)` }}
          onPointerDown={(e) => {
            // deleting is allowed all the way down — a one-point draft deletes into no draft,
            // which is exactly what the ✕/Esc discard leaves too
            vertexPress.press(`d${i}`, () => onDeleteVertex(i), true).onPointerDown(e)
            onVertexDown(i, e)
          }}
          // …and the same right-click shorthand a finished shape's grips carry (A26)
          onContextMenu={(e) => { e.stopPropagation(); e.preventDefault(); onDeleteVertex(i) }}
        >{vertexPress.armed?.key === `d${i}` && <NodeDeleteChip progress={vertexPress.armed.progress} />}</button>
      ))}
    </>
  )
}

/**
 * On-canvas vertex editing for a selected line/area — ONE code path for both kinds (they're both
 * `pts`): a draggable grip per vertex (press-and-hold to delete) and a "+" at each segment midpoint
 * to insert a node. The closing edge is only offered for an area (`kind === 'area'`). Positions are
 * board px (caller passes sW/sH + the floor-stack y map).
 *
 * A dense freehand stroke shows a THINNED set of grips (lib/lineStyle · vertexHandleIndices) that
 * densifies as the plan is zoomed in — the same bargain the Lage map makes, since sW/sH already
 * carry the board zoom. The "+" handles only appear while EVERY node is shown: a midpoint between
 * two thinned grips is nowhere near the drawn path.
 */
export function WbVertexHandles({ anno, sW, sH, mapY, onVertexDown, onInsert, onDeleteVertex, onExtend }: {
  anno: BoardAnno
  sW: number
  sH: number
  mapY: (floor: number | undefined, ly: number) => number
  onVertexDown: (idx: number, e: React.PointerEvent) => void
  onInsert: (idx: number, e: React.PointerEvent) => void
  onDeleteVertex: (idx: number) => void
  /** grow the line past an open end — appends a point there and hands the drag over to it */
  onExtend?: (end: 'start' | 'end', e: React.PointerEvent) => void
}) {
  // still hold = delete, movement cancels into the reshape drag — the SAME gesture and the same
  // chip the map uses (lib/nodeHold · NodeDeleteChip); the two surfaces share the feel, not the
  // renderer.
  //
  // ⚠️ Every grip below carries `data-holdaction` (01.09.). These are <button>s, where the Lage's
  // are plain <div>s, and the app-wide hold-tooltip (lib/holdTooltip) only looks at buttons — so
  // on the plan it popped «Punkt ziehen» at 350 ms INSIDE the 825 ms hold-to-delete and swallowed
  // the release, which is the one gesture that must survive. The attribute opts them out at the
  // source and keeps the button's keyboard/aria access, which the map's div never had.
  const vertexPress = useNodeHold()
  const pts = anno.pts ?? []
  if (pts.length < 2) return null
  const closed = anno.kind === 'area'
  const sp: [number, number][] = pts.map(([x, y, floor]) => [x * sW, mapY(floor ?? anno.floor, y) * sH])
  const gripIdx = vertexHandleIndices(sp)
  const allShown = gripIdx.length === sp.length
  const segs: number[] = [] // segment i runs from vertex i → i+1 (wraps to 0 for a closed area)
  if (allShown) {
    for (let i = 0; i < sp.length - 1; i++) segs.push(i)
    if (closed && sp.length >= 3) segs.push(sp.length - 1)
  }
  const minPts = closed ? 3 : 2
  /** ONE answer to «may this node go», read by both ways of asking: the hold (which simply never
   *  arms below the floor — a shape's minimum is a thing not to offer, not a thing to explain
   *  mid-gesture) and the right-click below. `deleteVertex` upstream enforces it again, together
   *  with the read-only gate that already keeps these handles off a locked sheet. */
  const canDeleteNode = pts.length > minPts
  return (
    <>
      {segs.map((i) => {
        const a = sp[i], b = sp[(i + 1) % sp.length]
        return (
          <button key={`ins-${i}`} className="wb-vins" title={appConfig.copy.whiteboard.insertVertex} aria-label={appConfig.copy.whiteboard.insertVertex}
            style={{ left: 0, top: 0, transform: `translate(${(a[0] + b[0]) / 2}px, ${(a[1] + b[1]) / 2}px) translate(-50%, -50%)` }}
            onPointerDown={(e) => onInsert(i, e)}><Icon id="plus" /></button>
        )
      })}
      {/* ── Verlängern ──────────────────────────────────────────────────────────────────────
          The arrow tip past each open end, exactly as on the Lage: pressing it appends one point
          right there — one fixed step further out — and the same press keeps dragging that point,
          so a tap alone already grew the line. A Fläche has no end to grow from. */}
      {!closed && onExtend && (['start', 'end'] as const).map((ep) => {
        const i = ep === 'start' ? 0 : sp.length - 1
        const nb = ep === 'start' ? sp[1] : sp[sp.length - 2]
        const p0 = sp[i]
        const dx = p0[0] - nb[0], dy = p0[1] - nb[1], len = Math.hypot(dx, dy) || 1
        const gx = p0[0] + (dx / len) * EXTEND_STEP_PX, gy = p0[1] + (dy / len) * EXTEND_STEP_PX
        const deg = (Math.atan2(dy, dx) * 180) / Math.PI
        return (
          <button key={`grow-${ep}`} className="draw-grow wb-grow" title={appConfig.copy.measure.extendLine} aria-label={appConfig.copy.measure.extendLine}
            style={{ left: 0, top: 0, transform: `translate(${gx}px, ${gy}px) translate(-50%, -50%)`, ['--grow-deg' as string]: `${deg}deg` }}
            onPointerDown={(e) => onExtend(ep, e)}><Icon id="arrow" /></button>
        )
      })}
      {/* ⚠️ No double-tap delete any more (19.08.). It was the one gesture the map never had, iOS
          does not deliver `dblclick` reliably anyway, and on a dense line a stray second tap
          removed a node with no way to see it coming. The hold is the whole story now. */}
      {gripIdx.map((i) => {
        const [x, y] = sp[i]
        return (
        <button key={`v-${i}`} className={`wb-vertex ${vertexPress.armed?.key === `v${i}` ? 'doomed' : ''}`}
          title={appConfig.copy.whiteboard.dragVertex} aria-label={appConfig.copy.whiteboard.dragVertex} data-holdaction
          style={{ left: 0, top: 0, transform: `translate(${x}px, ${y}px) translate(-50%, -50%)` }}
          onPointerDown={(e) => {
            vertexPress.press(`v${i}`, () => onDeleteVertex(i), canDeleteNode).onPointerDown(e)
            onVertexDown(i, e)
          }}
          // A26 · the desktop shorthand for the same hold, as on the Karte (MapView · the node
          // pads). The mouse has a second button and a right-click on a node means one thing;
          // making it wait out 825 ms is a touch gesture charged to a hand that isn't touching.
          // Same `canDeleteNode`, so the shape's floor is never offered and then refused.
          onContextMenu={(e) => { e.stopPropagation(); e.preventDefault(); if (canDeleteNode) onDeleteVertex(i) }}
        >{vertexPress.armed?.key === `v${i}` && <NodeDeleteChip progress={vertexPress.armed.progress} />}</button>
        )
      })}
    </>
  )
}

interface DocksProps {
  tool: BoardTool
  lineMode: 'freehand' | 'nodes'
  color: string
  width: number
  dashed: boolean
  marker: string
  setMarker: (m: string) => void
  /** the in-progress node draft is committable (line ≥2 pts / area ≥3 pts) — gates the ✓ button */
  draftActive: boolean
  selResource: BoardAnno | undefined
  setTool: (t: BoardTool) => void
  setLineMode: (m: 'freehand' | 'nodes') => void
  setColor: (c: string) => void
  setWidth: (w: number) => void
  setDashed: (d: boolean) => void
  areaMode: 'nodes' | 'freehand'
  setAreaMode: (m: 'nodes' | 'freehand') => void
  onFinish: () => void
  onCancelDraft: () => void
  /** the selected chip belongs to a REGISTERED Trupp — its colour is edited on the Trupp form */
  resourceBound?: boolean
  /** the SELECTED team's trail visibility — the dock eye toggles just that team */
  trailsShown: boolean
  onToggleTrails: () => void
  /** Messen tool: line/area mode + clear/close, mirroring the Lage map's measure dock */
  measMode: 'line' | 'area'
  setMeasMode: (m: 'line' | 'area') => void
  measCount: number
  onMeasClear: () => void
  onMeasClose: () => void
  /** Defaults for the NEXT note, set while the Notiz tool is armed. They live here — before a
   *  note exists — rather than during editing on purpose: a dock button tapped mid-edit blurs
   *  the note's textarea, which commits and unmounts the dock under the finger reaching for it.
   *  Once a note is placed, the same settings live in its detail panel. */
  noteDefaults: { size: NoteSize; plain: boolean; color: string }
  setNoteDefaults: (patch: Partial<{ size: NoteSize; plain: boolean; color: string }>) => void
}

/**
 * Right-edge tool option docks (Linie/Fläche style pickers / armed-tool hints / selected-team
 * recolour+clear-trail), each top-aligned to its rail button. Built from the SHARED `ToolDock`
 * renderer — same control vocabulary (and look) as the Lage map; the Linie tool carries the same
 * Freihand↔Punkte input toggle, and the line style (Freihand/Messpfeil/Rettungsachse) is chosen in
 * the post-draw editor, not here.
 */
export function WbToolDocks({ tool, lineMode, areaMode, setAreaMode, color, width, dashed, marker, setMarker, draftActive, selResource, resourceBound = false, setTool, setLineMode, setColor, setWidth, setDashed, onFinish, onCancelDraft, trailsShown, onToggleTrails, measMode, setMeasMode, measCount, onMeasClear, onMeasClose, noteDefaults, setNoteDefaults }: DocksProps) {
  // Read copy per render: the deployment locale is resolved after modules are imported.
  const NOTES = appConfig.copy.notes
  const closeDraft = () => { onCancelDraft(); setTool('pan') }
  return (
    <>
      {/* Linie — Freihand (drag) ↔ Punkte (tap, ✓ to finish) + colour/width/style; identical to map */}
      {tool === 'line' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: closeDraft }],
          [
            { type: 'toggle', icon: 'pen', label: appConfig.copy.drawingEditor.modeFreehand, on: lineMode === 'freehand', onClick: () => { setLineMode('freehand'); onCancelDraft() } },
            { type: 'toggle', icon: 'polygon', label: appConfig.copy.drawingEditor.modeNodes, on: lineMode === 'nodes', onClick: () => setLineMode('nodes') },
            ...(lineMode === 'nodes' ? [{ type: 'go' as const, disabled: !draftActive, onClick: onFinish }] : []),
          ],
          [{ type: 'colors', value: color, onChange: setColor }],
          [{ type: 'widths', value: width, onChange: setWidth }],
          [{ type: 'lineStyle', dashed, onChange: setDashed, marker, onMarker: setMarker }],
          [{ type: 'info', text: appConfig.copy.whiteboard.dockHints.line }],
        ]} />
      )}

      {/* Fläche — Freihand ODER Knoten, then colour/width/style + info. Same two-mode group as
          the Linie dock above it, because it is the same question: tap the corners, or draw it. */}
      {tool === 'area' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: closeDraft }],
          [
            { type: 'toggle', icon: 'pen', label: appConfig.copy.drawingEditor.modeFreehand, on: areaMode === 'freehand', onClick: () => { setAreaMode('freehand'); onCancelDraft() } },
            { type: 'toggle', icon: 'polygon', label: appConfig.copy.drawingEditor.modeNodes, on: areaMode === 'nodes', onClick: () => setAreaMode('nodes') },
            ...(areaMode === 'nodes' ? [{ type: 'go' as const, disabled: !draftActive, onClick: onFinish }] : []),
          ],
          [{ type: 'colors', value: color, onChange: setColor }],
          [{ type: 'widths', value: width, onChange: setWidth }],
          [{ type: 'lineStyle', dashed, onChange: setDashed }],
          [{ type: 'info', text: appConfig.copy.whiteboard.dockHints.area }],
        ]} />
      )}

      {/* Messen — close + Strecke/Fläche toggle + clear + info (identical to the Lage map dock).
          Removed 29.08., restored 02.09.: see usePlanMeasure's header. */}
      {tool === 'measure' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: onMeasClose }],
          [
            { type: 'toggle', icon: 'measure', label: appConfig.copy.measure.modeLine, on: measMode === 'line', onClick: () => setMeasMode('line') },
            { type: 'toggle', icon: 'area', label: appConfig.copy.measure.modeArea, on: measMode === 'area', onClick: () => setMeasMode('area') },
          ],
          [{ type: 'action', icon: 'trash', label: appConfig.copy.measure.clear, disabled: !measCount, onClick: onMeasClear }],
          [{ type: 'info', text: appConfig.copy.whiteboard.dockHints.measure }],
        ]} />
      )}

      {/* Absperrkreis — drag centre → edge. Cancel + hint and nothing else, exactly like the
          Karte's circle dock (IncidentWorkspace): a cordon is placed in the hazard colour and
          then adjusted — radius, colour and fill — in its own editor. */}
      {tool === 'circle' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => setTool('pan') }],
          [{ type: 'info', text: appConfig.copy.whiteboard.dockHints.circle }],
        ]} />
      )}

      {/* Notiz armed — the quick actions for the note about to be placed. Safe here (nothing has
          focus yet); after placement they live in the note's detail panel instead. */}
      {tool === 'text' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => setTool('pan') }],
          // glyph, not a word: «Klartext» stretched the whole dock column wide. A bare T reads
          // as text without its paper; the word stays as the tooltip.
          [{ type: 'toggle', icon: 'type', label: NOTES.lookPlain, on: noteDefaults.plain, onClick: () => setNoteDefaults({ plain: !noteDefaults.plain }) }],
          [
            { type: 'toggle', text: 'S', label: NOTES.sizeS, on: noteDefaults.size === 's', onClick: () => setNoteDefaults({ size: 's' }) },
            { type: 'toggle', text: 'M', label: NOTES.sizeM, on: noteDefaults.size === 'm', onClick: () => setNoteDefaults({ size: 'm' }) },
            { type: 'toggle', text: 'L', label: NOTES.sizeL, on: noteDefaults.size === 'l', onClick: () => setNoteDefaults({ size: 'l' }) },
          ],
          [{ type: 'colors', value: noteDefaults.color, onChange: (c) => setNoteDefaults({ color: c }) }],
          [{ type: 'info', text: appConfig.copy.whiteboard.dockHints.text }],
        ]} />
      )}

      {/* team armed-tool — clean (×) cancel + info */}
      {tool === 'resource' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => setTool('pan') }],
          [{ type: 'info', text: appConfig.copy.whiteboard.dockHints.resource }],
        ]} />
      )}

      {/* Mehrfach (lasso/marquee) armed-tool — cancel + info, mirroring the map's lasso dock */}
      {tool === 'lasso' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => setTool('pan') }],
          [{ type: 'info', text: appConfig.copy.dockHints.lasso }],
        ]} />
      )}

      {/* selected team — recolour (grid, since the palette is now larger) + trail visibility.
          Trail CLEARING moved behind the pill bar's lock button (confirmed) — a one-tap ✕
          here silently wiped the recorded Truppverfolgung.
          ⚠️ No colour grid on a chip bound to a REGISTERED Trupp: its colour is the Trupp's
          identity and is edited on the Trupp's own form — a second palette here said the same
          thing twice and buried the trail toggle behind ten swatches. */}
      {selResource && tool === 'pan' && (
        <ToolDock groups={[
          [{ type: 'toggle', icon: trailsShown ? 'eye' : 'eyeoff', label: trailsShown ? appConfig.copy.whiteboard.trailsOff : appConfig.copy.whiteboard.trailsOn, on: trailsShown, disabled: !selResource.trail?.length, onClick: onToggleTrails }],
        ]} />
      )}
    </>
  )
}
