import type { BoardAnno, BoardPoint, BoardTool } from '../types'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { LINE_DASH_SVG } from '../lib/draw'
import { ToolDock } from './ToolDock'
import { useLongPress } from '../lib/useLongPress'

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
  showTrails: boolean
  mapY: (floor: number | undefined, ly: number) => number
  selId?: string | null
  networkIds?: string[]
  /** select/drag a stroke / area by tapping it (pan mode only); omitted ⇒ not hittable */
  onPickDraw?: (id: string, e: React.PointerEvent) => void
}

/**
 * The vector ink layer (single non-scaling-stroke SVG): committed freehand/line polylines, filled
 * areas, the in-progress draft, and team trails. When `onPickDraw` is given (pan mode), each shape
 * also gets a fat transparent hit surface so it can be tapped to select — the visible shape stays
 * non-interactive. (Line arrowheads + marker letters render OUTSIDE this layer, in board px, since
 * this SVG is stretched 1×1 and would distort them.)
 */
export function WbInkLayer({ annos, draft, draftFloor, draftClosed, color, width, dashed, showTrails, mapY, selId, networkIds = [], onPickDraw }: InkProps) {
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
          {networkIds.includes(a.id) && <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={(a.width || 5) + 9} strokeOpacity={selId === a.id ? 0.34 : 0.16} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
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
      {showTrails && annos.filter((a) => a.kind === 'resource' && (a.trail?.length ?? 0) > 1).map((a) => (
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
 * `pts`): a draggable grip per vertex (double-click or press-and-hold to delete — dblclick alone
 * is unreliable from an iOS double-tap) and a "+" at each segment midpoint to insert a node. The
 * closing edge is only offered for an area (`kind === 'area'`). Positions are board px (caller
 * passes sW/sH + the floor-stack y map).
 */
export function WbVertexHandles({ anno, sW, sH, mapY, onVertexDown, onInsert, onDeleteVertex }: {
  anno: BoardAnno
  sW: number
  sH: number
  mapY: (floor: number | undefined, ly: number) => number
  onVertexDown: (idx: number, e: React.PointerEvent) => void
  onInsert: (idx: number, e: React.PointerEvent) => void
  onDeleteVertex: (idx: number) => void
}) {
  // still hold = delete, movement cancels into the reshape drag (same pattern as the map)
  const vertexPress = useLongPress()
  const pts = anno.pts ?? []
  if (pts.length < 2) return null
  const closed = anno.kind === 'area'
  const sp = pts.map(([x, y, floor]) => [x * sW, mapY(floor ?? anno.floor, y) * sH] as const)
  const segs: number[] = [] // segment i runs from vertex i → i+1 (wraps to 0 for a closed area)
  for (let i = 0; i < sp.length - 1; i++) segs.push(i)
  if (closed && sp.length >= 3) segs.push(sp.length - 1)
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
      {sp.map(([x, y], i) => (
        <button key={`v-${i}`} className="wb-vertex" title={appConfig.copy.whiteboard.dragVertex} aria-label={appConfig.copy.whiteboard.dragVertex}
          style={{ left: 0, top: 0, transform: `translate(${x}px, ${y}px) translate(-50%, -50%)` }}
          onPointerDown={(e) => {
            if (pts.length > minPts) vertexPress.press(() => onDeleteVertex(i)).onPointerDown(e)
            onVertexDown(i, e)
          }}
          onDoubleClick={(e) => { e.stopPropagation(); if (pts.length > minPts) onDeleteVertex(i) }} />
      ))}
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
  /** global trail visibility (the rail's Spuren toggle) — the dock mirrors it per-team */
  trailsShown: boolean
  onToggleTrails: () => void
  /** Messen tool: line/area mode + clear/close, mirroring the Lage map's measure dock */
  measMode: 'line' | 'area'
  setMeasMode: (m: 'line' | 'area') => void
  measCount: number
  onMeasClear: () => void
  onMeasClose: () => void
}

/**
 * Right-edge tool option docks (Linie/Fläche style pickers / armed-tool hints / selected-team
 * recolour+clear-trail), each top-aligned to its rail button. Built from the SHARED `ToolDock`
 * renderer — same control vocabulary (and look) as the Lage map; the Linie tool carries the same
 * Freihand↔Punkte input toggle, and the line style (Freihand/Messpfeil/Rettungsachse) is chosen in
 * the post-draw editor, not here.
 */
export function WbToolDocks({ tool, lineMode, color, width, dashed, draftActive, selResource, setTool, setLineMode, setColor, setWidth, setDashed, onFinish, onCancelDraft, recolorTeam, trailsShown, onToggleTrails, measMode, setMeasMode, measCount, onMeasClear, onMeasClose }: DocksProps) {
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

      {/* text / team armed-tool — clean (×) cancel + info */}
      {(tool === 'text' || tool === 'resource') && (
        <ToolDock groups={[
          [{ type: 'close', onClick: () => setTool('pan') }],
          [{ type: 'info', text: tool === 'text' ? appConfig.copy.whiteboard.dockHints.text : appConfig.copy.whiteboard.dockHints.resource }],
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
