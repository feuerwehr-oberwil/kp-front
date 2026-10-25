// The create tools on the Plan's ink overlay: Linie (Freihand or Punkte), Fläche, Absperrkreis,
// Notiz, Symbol, Form (the Rotation's two taps), Trupp, Maßstab and Messen. Freehand draws on the
// drag itself; every other tool places on a genuine TAP, so a drag pans the board and a second
// finger pinches it, as on the Lage map. Lifted out of the Whiteboard (sweep A.1, 25.10.2026);
// what a draft becomes is components/usePlanDraft's, the Rotation's claim ring is useWbRotor's.
// Lage ↔ Plan parity: docs/tactical-objects.md.

import { useRef } from 'react'
import type React from 'react'
import type { BoardAnno, BoardPoint, BoardTool, NoteSize, ShapeKind, Trupp } from '../types'
import type { SymbolsApi } from '../lib/useSymbols'
import { appConfig } from '../config/appConfig'
import { newId } from '../lib/ids'
import { fillTemplate, formatSymbolName, formatTime } from '../lib/format'
import { serverNow } from '../lib/serverClock'
import { DRAG_DEADZONE_PX } from '../lib/useHoldToDrag'
import { rdpIndices, isTapStroke, FREEHAND_SIMPLIFY_PX } from '../lib/lineStyle'
import { minPoints } from '../lib/vertexOps'
import { nextTeamName } from '../lib/placedTrupps'
import { seedSymbolProps } from '../lib/symbols'
import { SHAPE_DEFS, SHAPE_MIN_N, SHAPE_TWO_POINT, rotationBox, type rotationBoundsN } from '../lib/shapes'
import { autoNoteWN, noteScale } from '../lib/notes'
import { floorLabel } from '../lib/whiteboard'
import type { useBoardView } from './useBoardView'
import type { usePlanDraft } from './usePlanDraft'
import type { usePlanMeasure } from './usePlanMeasure'
import type { useWbRotor } from './useWbRotor'
import type { PlanLogExtra } from './Whiteboard'

const TEAM_COLORS = appConfig.drawing.teamColors // distinct accent per team (cycled)

/** A placement press on the ink overlay, deferred to pointer-up: where it went down, the pan it
 *  offsets from, and whether it has travelled (then it is a pan, not a tap). */
export type InkTap = { x: number; y: number; px: number; py: number; moved: boolean }

type BoardView = ReturnType<typeof useBoardView>

interface Args {
  tool: BoardTool
  setTool: (tool: BoardTool) => void
  /** what the symbol / Form tool places next, and the place-lock (lib/useTacticalSelection · usePlacement) */
  pending: string | null
  setPending: (name: string | null) => void
  pendingShape: ShapeKind | null
  setPendingShape: (kind: ShapeKind | null) => void
  placeLock: boolean
  setPaletteOpen: (open: boolean) => void
  readOnly: boolean
  /** the Gebäude floor stack: a press lands on the storey under it */
  stack: boolean
  toNorm: (clientX: number, clientY: number) => [number, number] | null
  floorAt: (y: number) => number
  localY: (y: number, floor: number) => number
  mapY: (floor: number | undefined, ly: number) => number
  sW: number
  sH: number
  scale: number
  posRef: BoardView['posRef']
  scaleRef: BoardView['scaleRef']
  applyView: BoardView['applyView']
  zoomTo: BoardView['zoomTo']
  canvasRef: React.RefObject<HTMLDivElement | null>
  boardRef: React.RefObject<HTMLDivElement | null>
  /** the placement press in flight — the Whiteboard's, because the rotor's claim ring reads it too */
  inkTapRef: React.MutableRefObject<InkTap | null>
  /** the hooks this one drives: the draft in the hand, the Rotation's claim ring, Maßstab/Messen */
  planDraft: ReturnType<typeof usePlanDraft>
  rotor: ReturnType<typeof useWbRotor>
  measure: ReturnType<typeof usePlanMeasure>
  /** a two-point Form (Rotation) is armed, and its first point once it is laid */
  rotPlacing: boolean
  rotStart: BoardPoint | null
  setRotStart: (p: BoardPoint | null) => void
  /** the Rotation's run bounds in plan-width fractions (lib/shapes · rotationBoundsN) */
  rotN: ReturnType<typeof rotationBoundsN>
  /** the style the next Notiz carries, and its base font size (Whiteboard · txtBase) */
  noteDefaults: { size: NoteSize; plain: boolean; color: string }
  txtBase: number
  setNotePanelId: (id: string | null) => void
  setNotePlacedId: (id: string | null) => void
  sym: SymbolsApi
  onRecent: (name: string) => void
  annos: BoardAnno[]
  trupps: Trupp[]
  placedTeamNames?: () => (string | undefined)[]
  onLinkTrupp?: (annoId: string, truppId: string) => void
  /** a Trupp chip waits for the picker: where it was tapped */
  setTruppPick: (at: { x: number; y: number; floor: number } | null) => void
  add: (a: BoardAnno) => void
  log: (icon: string, text: string, extra?: PlanLogExtra) => void
  setSelId: (id: string | null) => void
  /** Freihand's double tap zooms (useBoardGestures · tapZoomPress) */
  tapZoomPress: (e: React.PointerEvent) => void
}

/** The ink overlay's pointer handlers and the placement they make; see the file header. */
export function usePlanCreate({
  tool, setTool, pending, setPending, pendingShape, setPendingShape, placeLock, setPaletteOpen, readOnly, stack,
  toNorm, floorAt, localY, mapY, sW, sH, scale, posRef, scaleRef, applyView, zoomTo, canvasRef, boardRef, inkTapRef,
  planDraft, rotor, measure, rotPlacing, rotStart, setRotStart, rotN, noteDefaults, txtBase, setNotePanelId, setNotePlacedId,
  sym, onRecent, annos, trupps, placedTeamNames, onLinkTrupp, setTruppPick, add, log, setSelId, tapZoomPress,
}: Args) {
  const {
    draft, setDraft, circleDraft, setCircleDraft, draftAttachmentsRef, draftFloorRef, inking, noding, lineMode, areaMode,
    updatePlanDraftMagnet, finishPlanDraftMagnet, addLine, addArea, addCircle,
  } = planDraft
  const { claimRotTarget, clearRotMagnet, rotMagnetRef, rotPanPaused: rotPanPausedRef } = rotor
  const { calNodes, setCalNodes, setCalPrompt, setRefMInput, lastRefM, calibrated, measPath, setMeasPath, setMeasLine, setMeasArea } = measure
  // two-finger pinch tracking ON the create-tool ink overlay, so the user can pinch-zoom the
  // plan WITHOUT leaving the active draw/measure tool (the overlay otherwise swallows pointers)
  const inkPtrs = useRef<Map<number, { x: number; y: number }>>(new Map())
  const inkPinch = useRef<number | null>(null)
  const inkPinchPts = () => {
    const [a, b] = [...inkPtrs.current.values()]
    if (!a || !b) return null
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
  }

  // --- create-tool interactions (on the ink overlay) ---
  // every created anno carries its storey (floor) and tile-local coords; on a
  // single-sheet doc that's floor 0 and coords == board-normalized.
  const inkDown = (e: React.PointerEvent) => {
    inkPtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (inkPtrs.current.size >= 2) {
      // a second finger means "pinch-zoom", not "place another point": abort an in-progress
      // freehand stroke (node/area drafts keep their tapped vertices) and start the pinch
      e.stopPropagation()
      // an aborted stroke leaves no line, so it may leave no attachment either — the start one
      // armed on pointerdown would otherwise ride along into the next line (see inkUp)
      if (inking) { setDraft(null); if (tool === 'line') { finishPlanDraftMagnet(); draftAttachmentsRef.current = {} } }
      setCircleDraft(null) // two fingers navigate — no cordon is laid by a pinch
      inkTapRef.current = null // a second finger → pinch-zoom, not a node tap
      inkPinch.current = inkPinchPts()?.dist ?? null
      return
    }
    // Freihand's taps mean nothing, so a double tap on the ink zooms (useBoardGestures ·
    // tapZoomPress); its drag stays the stroke
    if (inking) tapZoomPress(e)
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    e.stopPropagation() // placement owns this pointer — don't let the stage ALSO start a board pan
    const floor = stack ? floorAt(n[1]) : 0
    const x = n[0], y = localY(n[1], floor)
    if (tool === 'line') {
      const atStart = !draft?.length
      if (atStart) draftAttachmentsRef.current = {}
      else draftAttachmentsRef.current = { ...draftAttachmentsRef.current, endAttachment: undefined }
      updatePlanDraftMagnet([x, y, floor], 'start', atStart)
    }
    if (tool === 'circle') {
      // Absperrkreis: press = the centre, drag = the radius, exactly the Karte's grammar
      // (useMapCanvasGestures · circle). The ring shows at its default radius the instant the
      // finger lands — «etwas ist hier, zieh es auf» — instead of a zero-size point, and a
      // release without a drag commits that default rather than nothing.
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      draftFloorRef.current = floor
      setCircleDraft({ x, y, floor, r: appConfig.drawing.circleInitialRadiusN })
      return
    }
    if (inking) {
      // Freehand is the one create gesture that IS the drag — the stroke follows the finger,
      // so it can't double as a pan. Every OTHER create tool places on a single tap (placeNode/inkUp).
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      draftFloorRef.current = floor
      setDraft([[x, y, floor]])
      return
    }
    // All tap-to-place tools — Maßstab, node-draw (Linie/Fläche), Text, Symbol, Trupp —
    // mirror the Lage map: a DRAG pans the board, only a genuine tap drops/places. Defer to
    // pointer-up so a pan never leaves a stray node/symbol/chip behind; capture so the drag tracks
    // past the overlay edge.
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    inkTapRef.current = { x: e.clientX, y: e.clientY, px: posRef.current.x, py: posRef.current.y, moved: false }
    // …and a two-point shape's tap may claim a symbol: press, hold until the ring closes, let go
    if (rotPlacing) claimRotTarget({ x: e.clientX, y: e.clientY })
  }
  // create a resource chip — linked to a tracked Trupp when one is picked, else a generic team
  const placeTeamChip = (x: number, y: number, floor: number, trupp?: Trupp) => {
    const teams = annos.filter((a) => a.kind === 'resource').length
    const id = newId('r')
    // generic chips are numbered from the ONE counter of the Einsatz — every surface's chips
    // and every registered Trupp — so a second «Trupp 1» cannot appear anywhere (placedTeamNames)
    const name = trupp ? trupp.name : nextTeamName([
      ...annos.filter((a) => a.kind === 'resource').map((a) => a.text),
      ...(placedTeamNames?.() ?? []),
    ], trupps)
    const color = TEAM_COLORS[teams % TEAM_COLORS.length]
    add({ id, kind: 'resource', x, y, floor, text: name, t: formatTime(new Date(serverNow())), color, trail: [], truppId: trupp?.id })
    if (trupp) onLinkTrupp?.(id, trupp.id)
    // the row already states a place («auf Plan gesetzt»); on a floor stack that place is a
    // storey, so it is named (18.09.2026 — same rule as useTruppActions · placeTruppOnPlan)
    setSelId(id); log('flag', fillTemplate(appConfig.copy.whiteboard.placeTeam, { name }) + (stack ? ` · ${floorLabel(floor)}` : ''), { annoId: id, x, y, floor })
  }
  // deferred placement for the node tools: run on a genuine tap (pointer-up without a pan). Mirrors
  // the bodies the Lage map runs on click — Maßstab nodes, node-draw vertices, Text, Symbol,
  // Trupp. Freehand is the exception (it draws on the drag itself), so it never routes through here.
  const placeNode = (e: React.PointerEvent) => {
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    let floor = stack ? floorAt(n[1]) : 0
    let x = n[0], y = localY(n[1], floor)
    // a two-point shape's tap lands ON the symbol whose ring closed under it, not beside it
    if (rotPlacing) {
      const claimed = rotMagnetRef.current?.armed ? rotMagnetRef.current : null
      clearRotMagnet()
      if (claimed) { x = claimed.x; y = claimed.y; floor = claimed.floor }
    }
    if (tool === 'scale') {
      // Maßstab: tap the TWO endpoints of the printed scale bar; the second tap opens the
      // metre-entry popover. Coords stay board-normalized (converted to measure space on confirm).
      const next: [number, number][] = [...calNodes, n]
      if (next.length >= 2) { setCalNodes([]); setCalPrompt({ a: next[0], b: next[1] }); setRefMInput(String(lastRefM)) }
      else setCalNodes(next)
      return
    }
    if (tool === 'measure') {
      // Messen: each tap drops a measurement node (mirrors the Lage map's measure tool). But on an
      // UNCALIBRATED plan the first segment IS the calibration — the two reference taps open the
      // metre popover directly, so the user never has to find a separate Maßstab step first.
      // …but calibration is a WRITE (it persists to the workspace and the station default), so a
      // locked surface just can't measure until someone with edit rights has set the scale — the
      // panel says exactly that instead of offering a button that would fail.
      if (!calibrated) {
        if (readOnly) return
        const next: [number, number][] = [...measPath, n]
        if (next.length >= 2) { setCalPrompt({ a: next[0], b: next[1] }); setRefMInput(String(lastRefM)); setMeasLine([]); setMeasArea([]) }
        else setMeasPath(() => next)
        return
      }
      setMeasPath((p) => [...p, n])
      return
    }
    if (noding) {
      // node-based Linie / Fläche: each tap drops a vertex; ✓ («Fertig») closes the shape, never a
      // double tap (UX sweep M4, owner 20./21.10.2026: a double tap is a map function, and while a
      // tool is armed the tool owns every tap). A quick second tap lands on the grip the first one
      // just laid, so it adds no corner. Lines retain the floor below each pointer; areas stay on
      // the first floor.
      if (!draft) draftFloorRef.current = floor
      const pointFloor = tool === 'line' ? floor : draftFloorRef.current
      const ly = localY(n[1], pointFloor)
      setDraft((d) => (d ? [...d, [n[0], ly, pointFloor]] : [[n[0], ly, pointFloor]]))
      return
    }
    if (tool === 'text') {
      const id = newId('t')
      // carries whatever was chosen in the armed dock; the 'm'/off/no-colour defaults stay
      // ABSENT rather than written out, so an untouched note is byte-identical to a legacy one
      add({
        id, kind: 'text', x, y, floor, text: '',
        // a fresh note follows what gets typed into it (lib/notes · autoNoteWN); dragging the
        // width grip later ends that and the dragged width stands
        wN: autoNoteWN('', txtBase * scale * noteScale(noteDefaults.size), sW), noteAutoW: true,
        noteSize: noteDefaults.size === 'm' ? undefined : noteDefaults.size,
        notePlain: noteDefaults.plain || undefined,
        color: noteDefaults.color || undefined,
      })
      // Straight into typing — in the detail sheet, with the caret already in its text field
      // (05.09., in lockstep with the Karte: IncidentWorkspace's note placement). The on-canvas
      // inline editor is still the desktop double-tap.
      setSelId(id); setNotePanelId(id); setNotePlacedId(id); setTool('pan'); log('type', appConfig.copy.whiteboard.placeText, { annoId: id, x, y, floor })
      return
    }
    if (tool === 'symbol') {
      if (!pending) { setPaletteOpen(true); return }
      const id = newId('s'); const s = pending
      // shared seeding (label / subtitle / fields) — identical to the Lage placement
      // path, so a plan symbol now carries the same editable structure as a map one
      add({ id, kind: 'symbol', x, y, floor, ...seedSymbolProps(s, sym.symbols) })
      onRecent(s); log('hex', fillTemplate(appConfig.copy.whiteboard.placeSymbol, { name: formatSymbolName(s) }), { annoId: id, x, y, floor })
      // unlocked: place once, then drop to pan with the new symbol selected so its
      // editor + rotor are immediately usable. locked: stay armed (no selection) to
      // drop several in a row. Same one-at-a-time / lock model as the Lage map.
      if (placeLock) setSelId(null)
      else { setPending(null); setTool('pan'); setSelId(id) }
      return
    }
    if (tool === 'shape') {
      if (!pendingShape) { setPaletteOpen(true); return }
      const id = newId('sh'); const k = pendingShape
      const def = SHAPE_DEFS[k]
      const name = appConfig.copy.shapes.names[k] ?? appConfig.copy.shapes.kindLabel
      // same defaults + naming as the Lage placement path; size is normalized to the plan width
      let geom: Pick<BoardAnno, 'x' | 'y' | 'floor' | 'rotation' | 'sizeN' | 'aspect'> =
        { x, y, floor, sizeN: def.defaultSizeN, rotation: 0 }
      // ── A Rotation is laid between two PLACES (lib/shapes · SHAPE_TWO_POINT) ──────────────
      // The twin of the Lage map's two taps, in plan space: first the Wasserbezug, then the
      // Brandstelle. A second tap on the SAME spot lays down the default run instead, so nobody
      // is ever left holding half a gesture with no way to finish it.
      if (SHAPE_TWO_POINT[k]) {
        if (!rotStart) { setRotStart([x, y, floor]); return }
        // ⚠️ y is normalized against the board HEIGHT and sizeN against its WIDTH, so the two
        // axes are only comparable once y is scaled by the board's own proportions
        const f0 = rotStart[2] ?? floor
        const gy0 = mapY(f0, rotStart[1]), gy1 = mapY(floor, y)
        const dx = x - rotStart[0], dy = (gy1 - gy0) * (sH / sW)
        const span = Math.hypot(dx, dy)
        const apart = span >= SHAPE_MIN_N
        const box = rotationBox(apart ? span : rotN.runN, rotN.w)
        geom = {
          x: apart ? (x + rotStart[0]) / 2 : rotStart[0],
          // the midpoint is halved in BOARD space and re-localised into the first tap's storey —
          // averaging two storey-local y's from different storeys puts the loop nowhere
          y: apart ? localY((gy0 + gy1) / 2, f0) : rotStart[1],
          floor: f0,
          rotation: apart ? Math.round((((Math.atan2(dy, dx) * 180) / Math.PI % 360) + 360) % 360) : 0,
          sizeN: box.size,
          aspect: Math.round(box.aspect * 1000) / 1000,
        }
        setRotStart(null)
      }
      add({ id, kind: 'shape', shape: k, color: def.defaultColor, label: name, ...geom })
      log('hex', fillTemplate(appConfig.copy.whiteboard.placeSymbol, { name }), { annoId: id, x: geom.x, y: geom.y, floor: geom.floor })
      // unlocked: place once → pan with the shape selected (its two ends usable); locked: keep placing
      if (placeLock && !SHAPE_TWO_POINT[k]) setSelId(null)
      else { setPendingShape(null); setTool('pan'); setSelId(id) }
      return
    }
    if (tool === 'resource') {
      // if any Trupps are being tracked, ask WHICH one this chip is (listing the names);
      // otherwise drop a generic Team N. Placed trupps are listed too so the names always appear
      // once a Trupp is tracked — and so are the ones that are OUT (05.09.), which is the same
      // list the picker itself renders.
      if (trupps.length) { setTruppPick({ x, y, floor }); setTool('pan') }
      else { placeTeamChip(x, y, floor); setTool('pan') }
    }
  }
  const inkMove = (e: React.PointerEvent) => {
    if (inkPtrs.current.has(e.pointerId)) inkPtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (inkPinch.current != null) {
      const m = inkPinchPts(); const el = canvasRef.current
      if (m && el && inkPinch.current > 0 && m.dist > 0) {
        const r = el.getBoundingClientRect(); zoomTo(m.dist / inkPinch.current, m.mx - r.left, m.my - r.top)
      }
      if (m) inkPinch.current = m.dist
      return
    }
    if (inkTapRef.current) {
      // a two-point shape's press keeps its claim under the travelling finger
      if (rotPlacing) {
        const wasPaused = rotPanPausedRef.current
        claimRotTarget({ x: e.clientX, y: e.clientY })
        // while the ring fills the board must not pan (rotPanPaused): the wobble budget is the
        // magnet radius, not the tap threshold below. Leaving the ring hands the pan back —
        // re-anchored to where the finger rests now, so the board doesn't jump by the wobble.
        if (rotPanPausedRef.current) return
        if (wasPaused) {
          const st = inkTapRef.current
          // …and if the finger has already travelled past the tap threshold by the time it left
          // the ring, this was a drag all along: the tap dies here, as it does on the Karte,
          // where MapLibre's own click tolerance is long gone by that distance.
          if (Math.hypot(e.clientX - st.x, e.clientY - st.y) > DRAG_DEADZONE_PX) st.moved = true
          st.x = e.clientX; st.y = e.clientY; st.px = posRef.current.x; st.py = posRef.current.y
        }
      }
      if (tool === 'line') {
        const n = toNorm(e.clientX, e.clientY)
        if (n) { const floor = stack ? floorAt(n[1]) : draftFloorRef.current; updatePlanDraftMagnet([n[0], localY(n[1], floor), floor], 'move') }
      }
      // node tool: drag pans the board (and disqualifies the tap). 8px of slop tolerates finger
      // jitter so a still tap still places. Pan from the recorded origin, like useBoardGestures.
      const st = inkTapRef.current, dx = e.clientX - st.x, dy = e.clientY - st.y
      if (!st.moved && Math.hypot(dx, dy) > 8) st.moved = true
      if (st.moved) applyView(scaleRef.current, { x: st.px + dx, y: st.py + dy })
      return
    }
    if (circleDraft) {
      // the board rect IS the plan's px box (toNorm works in the same space), so the radius is
      // the pointer's distance from the centre as a fraction of the sheet's width
      const rect = boardRef.current?.getBoundingClientRect(); if (!rect?.width) return
      const cx = rect.left + circleDraft.x * rect.width, cy = rect.top + mapY(circleDraft.floor, circleDraft.y) * rect.height
      setCircleDraft({ ...circleDraft, r: Math.hypot(e.clientX - cx, e.clientY - cy) / rect.width })
      return
    }
    if (!inking || !draft) return
    const n = toNorm(e.clientX, e.clientY); if (n) {
      const floor = stack ? floorAt(n[1]) : draftFloorRef.current
      if (tool === 'line') updatePlanDraftMagnet([n[0], localY(n[1], floor), floor], 'move')
      setDraft((d) => (d ? [...d, [n[0], localY(n[1], floor), floor]] : [[n[0], localY(n[1], floor), floor]]))
    }
  }
  const inkUp = (e?: React.PointerEvent) => {
    if (e) inkPtrs.current.delete(e.pointerId)
    // the claim survives just long enough for placeNode to consume it, and no longer
    if (rotPlacing && (!e || e.type !== 'pointerup' || inkTapRef.current?.moved)) clearRotMagnet()
    if (inkPtrs.current.size < 2) inkPinch.current = null
    if (inkTapRef.current) {
      const st = inkTapRef.current; inkTapRef.current = null
      rotPanPausedRef.current = false // the press is over — whatever happens next pans normally
      // a clean pointer-up that never panned is a tap → drop the node; a drag (moved) or a
      // pointer-cancel just leaves the panned view as-is, with no stray node placed.
      if (e && e.type === 'pointerup' && !st.moved) placeNode(e)
      finishPlanDraftMagnet()
      return
    }
    if (circleDraft) {
      const c = circleDraft; setCircleDraft(null)
      // a real drag keeps its dragged radius; a tap (below the minimum) drops the default-size
      // cordon, so the tool never does «nothing» — the radius is editable either way
      if (e && e.type === 'pointerup') {
        addCircle(c.x, c.y, c.floor, c.r >= appConfig.drawing.circleMinRadiusN ? c.r : appConfig.drawing.circleInitialRadiusN)
      }
      return
    }
    // A dragged Fläche: the same thinned stroke as a freehand Linie, closed into a ring. No
    // magnet and no attachments — those belong to a Leitung's ends, and an area has none.
    if (tool === 'area' && areaMode === 'freehand' && draft) {
      const px = draft.map(([x, y, floor]): [number, number] => [x * sW, mapY(floor ?? draftFloorRef.current, y) * sH])
      if (!isTapStroke(px)) {
        const idx = rdpIndices(px, FREEHAND_SIMPLIFY_PX)
        if (idx.length >= minPoints('area')) addArea(idx.map((i) => draft[i]))
      }
      setDraft(null)
      return
    }
    if (tool === 'line' && lineMode === 'freehand' && draft) {
      // ⚠️ The magnet is settled BEFORE the line is built. `finishPlanDraftMagnet` is what writes an
      // armed END attachment into `draftAttachments`, and `addLine` is what consumes that ref and
      // empties it — in the other order the end attachment missed its own line and was left lying
      // in the ref for whatever got drawn next.
      finishPlanDraftMagnet()
      // thin the raw stroke into a clean, editable polyline (drops the point clusters a slow finger
      // dumps at the start/end). Node-mode lines keep their explicit taps (finishShape doesn't thin).
      const px = draft.map(([x, y, floor]): [number, number] => [x * sW, mapY(floor ?? draftFloorRef.current, y) * sH])
      if (!isTapStroke(px)) {
        const idx = rdpIndices(px, FREEHAND_SIMPLIFY_PX)
        addLine(idx.map((i) => draft[i]))
      } else {
        // ── Abheben ist der Rückzieher ──────────────────────────────────────────────────────
        // The stroke went nowhere, so nothing may be left behind — least of all the start
        // attachment that armed the instant the finger landed on a target (lineAttachments ·
        // armDwell). Without this the next line drawn anywhere on the plan inherited it.
        draftAttachmentsRef.current = {}
      }
      setDraft(null)
    }
  }

  return { inkDown, inkMove, inkUp, placeTeamChip }
}
