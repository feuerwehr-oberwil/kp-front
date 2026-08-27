import type { BoardAnno, BoardPoint, BoardTool, NoteSize } from '../types'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { LINE_DASH_SVG } from '../lib/draw'
import { ToolDock } from './ToolDock'
import { useNodeHold } from '../lib/nodeHold'
import { vertexHandleIndices, EXTEND_STEP_PX } from '../lib/lineStyle'
import { NodeDeleteChip } from './NodeDeleteChip'

const COLORS = appConfig.drawing.colors
const TEAM_COLORS = appConfig.drawing.teamColors // distinct accent per team (cycled)

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
}

/**
 * The vector ink layer (single non-scaling-stroke SVG): committed freehand/line polylines, filled
 * areas, the in-progress draft, and team trails. When `onPickDraw` is given (pan mode), each shape
 * also gets a fat transparent hit surface so it can be tapped to select — the visible shape stays
 * non-interactive. (Line arrowheads + marker letters render OUTSIDE this layer, in board px, since
 * this SVG is stretched 1×1 and would distort them.)
 */
export function WbInkLayer({ annos, draft, draftFloor, draftClosed, color, width, dashed, hiddenTrails, mapY, selId, flashId, networkIds = [], onPickDraw, truppTones = {} }: InkProps) {
  const pointStr = (pts: BoardPoint[], floor: number | undefined) => pts.map((p) => `${p[0]},${mapY(p[2] ?? floor, p[1])}`).join(' ')
  return (
    <svg className="wb-ink-svg" viewBox="0 0 1 1" preserveAspectRatio="none">
      {/* filled areas (under the lines) */}
      {annos.filter((a) => a.kind === 'area' && a.pts && a.pts.length >= 3).map((a) => {
        const pts = pointStr(a.pts!, a.floor)
        return (
        <g key={a.id}>
          {selId === a.id && <polygon points={pts} fill="none" stroke="var(--blue)" strokeWidth={(a.width || 3) + 6} strokeOpacity={0.35} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
          <polygon points={pts} fill={a.color || COLORS[0]} fillOpacity={a.fillOpacity ?? 0.14}
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
          title={appConfig.copy.whiteboard.dragVertex} aria-label={appConfig.copy.whiteboard.dragVertex}
          style={{ left: 0, top: 0, transform: `translate(${x}px, ${y}px) translate(-50%, -50%)` }}
          onPointerDown={(e) => {
            vertexPress.press(`v${i}`, () => onDeleteVertex(i), pts.length > minPts).onPointerDown(e)
            onVertexDown(i, e)
          }}
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
  /** the in-progress node draft is committable (line ≥2 pts / area ≥3 pts) — gates the ✓ button */
  draftActive: boolean
  selResource: BoardAnno | undefined
  setTool: (t: BoardTool) => void
  setLineMode: (m: 'freehand' | 'nodes') => void
  setColor: (c: string) => void
  setWidth: (w: number) => void
  setDashed: (d: boolean) => void
  onFinish: () => void
  onCancelDraft: () => void
  recolorTeam: (c: string) => void
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
export function WbToolDocks({ tool, lineMode, color, width, dashed, draftActive, selResource, setTool, setLineMode, setColor, setWidth, setDashed, onFinish, onCancelDraft, recolorTeam, trailsShown, onToggleTrails, measMode, setMeasMode, measCount, onMeasClear, onMeasClose, noteDefaults, setNoteDefaults }: DocksProps) {
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
          [{ type: 'lineStyle', dashed, onChange: setDashed }],
          [{ type: 'info', text: appConfig.copy.whiteboard.dockHints.line }],
        ]} />
      )}

      {/* Fläche (node polygon) — ✓ finish + colour/width/style + info */}
      {tool === 'area' && (
        <ToolDock groups={[
          [{ type: 'close', onClick: closeDraft }],
          [{ type: 'go', disabled: !draftActive, onClick: onFinish }],
          [{ type: 'colors', value: color, onChange: setColor }],
          [{ type: 'widths', value: width, onChange: setWidth }],
          [{ type: 'lineStyle', dashed, onChange: setDashed }],
          [{ type: 'info', text: appConfig.copy.whiteboard.dockHints.area }],
        ]} />
      )}

      {/* Messen — close + Strecke/Fläche toggle + clear + info (identical to the Lage map dock) */}
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
          here silently wiped the recorded Truppverfolgung. */}
      {selResource && tool === 'pan' && (
        <ToolDock groups={[
          [{ type: 'colorGrid', value: selResource.color ?? '', onChange: recolorTeam, colors: TEAM_COLORS, title: appConfig.copy.whiteboard.teamColor }],
          [{ type: 'toggle', icon: trailsShown ? 'eye' : 'eyeoff', label: trailsShown ? appConfig.copy.whiteboard.trailsOff : appConfig.copy.whiteboard.trailsOn, on: trailsShown, disabled: !selResource.trail?.length, onClick: onToggleTrails }],
        ]} />
      )}
    </>
  )
}
