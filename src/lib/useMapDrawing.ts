import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { getLinePreset, linePresetPatch } from './lineStyle'
import type { Doc } from './workspace'
import type { Drawing, LngLat, TimelineEvent } from '../types'

interface MapDrawingDeps {
  drawings: Drawing[]
  selectedDrawingId: string | null
  tacticalLocked: boolean
  tool: string
  setTool: (id: string) => void
  commit: (updater: (d: Doc) => Doc) => void
  setDocRaw: (updater: (d: Doc) => Doc) => void
  beginDrag: () => void
  endDrag: () => void
  emit: (op: string, payload?: Record<string, unknown>) => void
  log: (icon: string, text: string, kind?: TimelineEvent['kind'], audioUrl?: string, entityId?: string) => void
  setSelectedDrawingId: (id: string | null) => void
  setSelectedId: (id: string | null) => void
  setSelectedDrawIds: (ids: string[]) => void
  setSelectedEntityIds: (ids: string[]) => void
}

/**
 * The Lage-map drawing surface, lifted out of App's god-component. It owns the in-progress draft
 * (the line/area node taps), the line tool's freehand/nodes mode + sticky preset, the freehand
 * draw-style controls, and every Drawing CRUD + on-canvas edit (commit a draft, create a
 * line/circle, reshape/move/insert/delete vertices, drag a line's label, patch style, delete).
 *
 * It deliberately does NOT own the undoable doc (Drawings live there) nor the shared selection
 * state — both are threaded in via deps so the handlers stay byte-for-byte equivalent to their
 * former inline selves; the only change is where they live. Symbol/shape placement, measure and
 * the marquee/group handlers (which span entities too) remain in App.
 */
export function useMapDrawing(deps: MapDrawingDeps) {
  const {
    drawings, selectedDrawingId, tacticalLocked, tool, setTool,
    commit, setDocRaw, beginDrag, endDrag, emit, log,
    setSelectedDrawingId, setSelectedId, setSelectedDrawIds, setSelectedEntityIds,
  } = deps

  const [draft, setDraft] = useState<LngLat[]>([])
  const [drawColor, setDrawColor] = useState<string>(appConfig.drawing.defaultColor)
  const [drawWidth, setDrawWidth] = useState(4)
  const [drawDashed, setDrawDashed] = useState(false)
  const [linePreset, setLinePreset] = useState<string>('freihand')
  const [lineMode, setLineMode] = useState<'freehand' | 'nodes'>('freehand')

  const commitDraft = () => {
    // node-mode line: ≥2 tapped vertices → a line (createLine drops into Select itself)
    if (tool === 'line') {
      if (draft.length >= 2) { const coords = draft; setDraft([]); createLine(coords); return }
      setDraft([]); return
    }
    if (draft.length >= 3) {
      const coords = draft; const id = `d${Date.now()}`
      // carry the dock's colour/width/dash so the area-tool style controls actually apply
      // (parity with the line tool + the Plan area tool); still fully editable in the DrawEditor.
      const drawing: Drawing = { id, kind: 'area', coords, color: drawColor, width: drawWidth, dashed: drawDashed }
      commit((d) => ({ ...d, drawings: [...d.drawings, drawing] }))
      log('area', appConfig.copy.log.areaDrawn, 'symbol'); emit('draw.add', { id, kind: 'area', drawing })
      // drop into Select with the new area active so its reshape/move/rotate handles are
      // immediately usable (mirrors symbol/shape placement). Staying in 'area' would keep
      // draftKind set, which suppresses the edit handles → the area looks uneditable.
      setDraft([]); setTool('select'); setSelectedDrawingId(id); setSelectedDrawIds([]); setSelectedEntityIds([]); setSelectedId(null)
      return
    }
    setDraft([])
  }
  // annotated-polyline presets: tools that draw like a freehand line but seed the new
  // arrow/marker/distance fields. The fields stay fully editable in the DrawEditor.
  // create a line from a finished path (freehand stroke OR node-tapped draft), applying the
  // sticky line preset. EVERY finished line one-shots to Select with the new line active, so
  // its detail editor opens right away for post-draw tweaks — no extra click needed.
  const createLine = (coords: LngLat[]) => {
    const id = `d${Date.now()}`
    const preset = getLinePreset(linePreset)
    const styled = preset.id !== 'freihand'
    // styled presets (Messpfeil/Rettungsachse) carry their own colour/dash; Freihand uses the
    // freehand dock controls. A new line inherits the last-used preset (post-pick + sticky).
    const drawing: Drawing = styled
      ? { id, kind: 'line', coords, color: drawColor, width: drawWidth, ...preset.defaults }
      : { id, kind: 'line', coords, color: drawColor, width: drawWidth, dashed: drawDashed }
    commit((d) => ({ ...d, drawings: [...d.drawings, drawing] }))
    log('pen', appConfig.copy.log.drawingCreated, 'symbol'); emit('draw.add', { id, kind: 'line', drawing })
    setTool('select'); setSelectedDrawingId(id); setSelectedDrawIds([]); setSelectedEntityIds([]); setSelectedId(null)
  }
  const onFreehand = (coords: LngLat[]) => createLine(coords)
  // Absperrkreis / Gefahrenradius: a dragged circle becomes a real (undoable, synced,
  // journaled) circle Drawing — centre in coords[0], radius in metres. Drops into Select
  // with the new circle active so its radius is tweakable in the DrawEditor right away.
  const createCircle = (center: LngLat, radiusM: number) => {
    const id = `d${Date.now()}`
    const drawing: Drawing = { id, kind: 'circle', coords: [center], radiusM, color: appConfig.drawing.circleColor, dashed: true, width: appConfig.drawing.circleLineWidth, fillOpacity: appConfig.drawing.circleFillOpacity }
    commit((d) => ({ ...d, drawings: [...d.drawings, drawing] }))
    log('circle', appConfig.copy.log.circleDrawn, 'symbol'); emit('draw.add', { id, kind: 'circle', drawing })
    setTool('select'); setSelectedDrawingId(id); setSelectedDrawIds([]); setSelectedEntityIds([]); setSelectedId(null)
  }
  // apply a line preset to the selected drawing + remember it for the next new line
  const applyLinePreset = (presetId: string) => {
    setLinePreset(presetId)
    patchDrawing(linePresetPatch(presetId)) // SAME bundle the Plan editor applies (lib/lineStyle)
  }

  const selectedDrawing = drawings.find((d) => d.id === selectedDrawingId) ?? null
  const patchDrawing = (patch: Partial<Drawing>) => { emit('draw.edit', { id: selectedDrawingId, patch }); commit((d) => ({ ...d, drawings: d.drawings.map((dr) => (dr.id === selectedDrawingId ? { ...dr, ...patch } : dr)) })) }
  // patch a specific drawing by id (e.g. unlock from the on-map lock chip, where the locked
  // shape isn't the selected one)
  const patchDrawingById = (id: string, patch: Partial<Drawing>) => { emit('draw.edit', { id, patch }); commit((d) => ({ ...d, drawings: d.drawings.map((dr) => (dr.id === id ? { ...dr, ...patch } : dr)) })) }

  // --- direct manipulation of a selected drawing (move body / reshape vertices / delete) ---
  // The move handle and vertex handles both stream new coords continuously, so the whole
  // gesture folds into ONE undo step: 'start' snapshots, 'move' updates silently, 'end' commits.
  const editDrawingCoords = (id: string, coords: LngLat[], phase: 'start' | 'move' | 'end') => {
    if (tacticalLocked) return
    if (phase === 'start') { beginDrag(); return }
    setDocRaw((d) => ({ ...d, drawings: d.drawings.map((dr) => (dr.id === id ? { ...dr, coords } : dr)) }))
    if (phase === 'end') {
      endDrag()
      emit('draw.edit', { id, patch: { coords } })
    }
  }
  // drag a line's distance/text label to a georeferenced anchor (WGS84 [lng,lat]) — stays pinned
  // to the ground at any zoom/bearing; folds into one undo step like editDrawingCoords
  // ('start' snapshots, 'move' streams, 'end' commits).
  const moveLabel = (id: string, at: LngLat | null, phase: 'start' | 'move' | 'end', which: 'label' | 'end' = 'label') => {
    if (tacticalLocked) return
    if (phase === 'start') { beginDrag(); return }
    if (!at) return
    const patch = which === 'end' ? { endLabelAt: at } : { labelAt: at }
    setDocRaw((d) => ({ ...d, drawings: d.drawings.map((dr) => (dr.id === id ? { ...dr, ...patch } : dr)) }))
    if (phase === 'end') { endDrag(); emit('draw.edit', { id, patch }) }
  }
  // insert/delete a vertex are discrete edits → one commit (one undo step) each
  const insertDrawingVertex = (id: string, index: number, c: LngLat) => {
    if (tacticalLocked) return
    const dr = drawings.find((x) => x.id === id); if (!dr) return
    const coords = [...dr.coords]; coords.splice(index, 0, c)
    emit('draw.edit', { id, patch: { coords } }); commit((d) => ({ ...d, drawings: d.drawings.map((x) => (x.id === id ? { ...x, coords } : x)) }))
  }
  const deleteDrawingVertex = (id: string, index: number) => {
    if (tacticalLocked) return
    const dr = drawings.find((x) => x.id === id); if (!dr) return
    if (dr.coords.length <= (dr.kind === 'area' ? 3 : 2)) return // keep a drawable shape
    const coords = dr.coords.filter((_, j) => j !== index)
    emit('draw.edit', { id, patch: { coords } }); commit((d) => ({ ...d, drawings: d.drawings.map((x) => (x.id === id ? { ...x, coords } : x)) }))
  }
  const deleteDrawing = (id: string) => {
    if (tacticalLocked) return
    commit((d) => ({ ...d, drawings: d.drawings.filter((dr) => dr.id !== id) }))
    if (selectedDrawingId === id) setSelectedDrawingId(null)
    log('close', appConfig.copy.log.drawingDeleted)
  }

  // ✓ enabled when the draft is committable: an area needs ≥3 points, a node-mode line ≥2
  const draftActive = (tool === 'area' && draft.length >= 3) || (tool === 'line' && lineMode === 'nodes' && draft.length >= 2)
  // node-mode line taps seed the draft (like the area/measure tools), so the freehand gesture is off
  const lineNodes = tool === 'line' && lineMode === 'nodes'

  return {
    draft, setDraft,
    drawColor, setDrawColor, drawWidth, setDrawWidth, drawDashed, setDrawDashed,
    linePreset, setLinePreset, lineMode, setLineMode,
    draftActive, lineNodes, selectedDrawing,
    commitDraft, createLine, onFreehand, createCircle, applyLinePreset, patchDrawing, patchDrawingById,
    editDrawingCoords, moveLabel, insertDrawingVertex, deleteDrawingVertex, deleteDrawing,
  }
}
