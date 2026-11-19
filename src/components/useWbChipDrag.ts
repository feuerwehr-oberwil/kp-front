import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { BoardAnno, BoardPoint, BoardTool } from '../types'
import { DRAG_DEADZONE_PX, useHoldToDrag } from '../lib/useHoldToDrag'
import { formatTime } from '../lib/format'
import { serverNow } from '../lib/serverClock'
import { applyRouting, nearestFreeEndpoint, objectAttachment, type AttachableLine } from '../lib/lineAttachments'
import { normalizeStackEdit } from '../lib/stackFloors'
import { storeyMove, withDrawingStorey, type SheetDrawing } from '../lib/floorPackBinding'
import { DOOR_SNAP_PX, isDoor, nearestWall, seatDoor } from '../lib/grundriss'
import { fanOffsets, type PilePoint } from '../lib/labelPass'
import { useLayer } from '../lib/overlays/layer'

interface Args {
  /** the ARMED tool as the board reads it (a select-only surface reads 'pan') */
  tool: BoardTool
  readOnly: boolean
  annos: BoardAnno[]
  /** the selected anno – a press on it drags at once (the Lage's rule) */
  selId: string | null
  editId: string | null
  setSelId: (id: string | null) => void
  setSelIds: (ids: string[]) => void
  setNotePanelId: (id: string | null) => void
  /** client point → normalized 0..1 in plan space */
  toNorm: (clientX: number, clientY: number) => [number, number] | null
  /** floor-stack document: the chip drags freely across storeys */
  stack: boolean
  /** a plain sheet's storey drawings (Modul 6 with its storeys side by side): a symbol landing in
   *  one takes its storey (lib/floorPackBinding · withDrawingStorey); empty elsewhere */
  drawings: readonly SheetDrawing[]
  floorAt: (y: number) => number
  localY: (y: number, floor: number) => number
  mapY: (floor: number | undefined, ly: number) => number
  sW: number
  sH: number
  /** a storey tile's height / width – a dragged Durchgang turns along the Wand it lands on */
  tileAR: number
  attachmentLines: AttachableLine<BoardPoint>[]
  /** the board document's funnel (useBoardDoc): checkpoint, silent writes */
  pushPast: () => void
  set: (next: BoardAnno[]) => void
  emit: (op: string, payload?: Record<string, unknown>) => void
  activeId: string
  onLinkLineTrupp?: (lineId: string, truppId: string) => void
  /** useBoardGestures: pan the board from a press the chip does not (yet) take, and stop it */
  panFrom: (e: React.PointerEvent) => void
  stopPan: () => void
  /** the board's zoom – a fanned pile expires with it (its spokes are screen px) */
  scale: number
  /** every compact chip whose finger pad a press at (x, y) lands in, nearest centre first, as
   *  `id:floor` instance keys (Whiteboard · pileUnder, lib/labelPass · pileAt) */
  pileUnder: (clientX: number, clientY: number, self: BoardAnno) => PilePoint[]
}

/**
 * Dragging a placed chip on the plan — a Trupp, a symbol, a note — lifted out of the Whiteboard
 * (23.09.2026): the press, the drag past the shared deadzone that checkpoints ONCE and carries
 * every trace-routed Leitung end along, and the release that stamps a Trupp's time, writes the
 * audit rows and joins a Trupp's chip dropped on a free hose end to that hose. The handlers are
 * re-created on every render with that render's values (no memo). The drag ref is handed back for
 * the stage dispatcher (Whiteboard · manipMove).
 *
 * ⚠️ The press is the Lage's (duck sweep GESTURES.1, owner 17.11.2026 – MapMarkers · pressMarker):
 * a finger on a chip that is NOT selected pans the board, a tap selects on release, and only a
 * still hold (lib/useHoldToDrag, HOLD_DRAG_MS) lifts the chip. A selected chip, and any mouse
 * press, drags at once. Before, every press dragged: panning a Gebäude plan with the finger on a
 * Trupp moved the Trupp and stamped it a new time.
 *
 * ⚠️ The drag moves the chip's own NODE (design pass 18.11.2026 B7): a `translate` written on the
 * pressed `.wb-anno` per move, and ONE write of the board on release (checkpoint + positions + a
 * Trupp's time + a hose join, one undo step). A `set()` per move re-rendered the whole board and
 * wrote the workspace each time. Where the picture around the chip must follow it live, the drag
 * stays a write per move (`live`): a chip a Leitung is attached to (its end is drawn from the
 * chip's stored position) and every chip on a floor stack (a storey change re-localises it, a
 * Durchgang seats on a Wand, a symbol over several storeys is drawn once per storey).
 *
 * …and a tap on a PILE is resolved the Lage's way (GESTURES.9, MapMarkers · the pile): several
 * compact chips (symbols, Trupps) under the finger's pad fan out on short spokes, the next tap on
 * one of them is the answer, and a single one is the nearest centre – never whichever DOM node
 * happens to be on top. Three Trupps at the stair door no longer hand out the wrong card.
 */
export function useWbChipDrag({
  tool, readOnly, annos, selId, editId, setSelId, setSelIds, setNotePanelId, toNorm, stack, drawings, floorAt, localY, mapY, sW, sH, tileAR,
  attachmentLines, pushPast, set, emit, activeId, onLinkLineTrupp, panFrom, stopPan, scale, pileUnder,
}: Args) {
  const chipDrag = useRef<{
    id: string; moved: boolean; sx: number; sy: number; floorOffset: number
    /** the pressed chip, moved by `translate` while the drag is not `live` */
    node: HTMLElement | null
    /** the board is written on every move (see the header) — else once, on release */
    live: boolean
    /** where the finger has put it so far */
    last: BoardPoint | null
    /** the chip as the press found it – a storey drawing's storey is worked out from it */
    orig: BoardAnno | null
  } | null>(null)
  const hold = useHoldToDrag()

  // ── the fanned pile: screen-px offsets per instance key (`id:floor`), computed ONCE at the tap.
  // They ride along with a pan (the pile moves as one) and expire by DERIVATION on a zoom or when
  // a member moves (another device, a GPS fix) – the Lage's rule, MapMarkers · fanKey.
  type FanOffsets = Record<string, { dx: number; dy: number }>
  const fanKey = (offsets: FanOffsets) => `${scale}|` + Object.keys(offsets).sort().map((k) => {
    const a = annos.find((x) => x.id === k.slice(0, k.lastIndexOf(':')))
    return a ? `${k}@${a.x},${a.y},${a.floor ?? 0}` : k
  }).join('|')
  const [fanState, setFan] = useState<{ key: string; offsets: FanOffsets } | null>(null)
  const fan = fanState && fanState.key === fanKey(fanState.offsets) ? fanState.offsets : null
  // a press anywhere that is not a fanned chip closes the fan (capture: the board's own presses too)
  useEffect(() => {
    if (!fan) return
    const away = (ev: PointerEvent) => { if (!(ev.target as Element | null)?.closest?.('.wb-anno.fanned')) setFan(null) }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [fan])
  // Escape folds the fan and nothing else – the Lage's (MapMarkers), the one Esc stack
  // (lib/overlays/layer, CONT.2): the selection and the tool under it stay
  useLayer({ open: !!fan, onClose: () => setFan(null), inside: [], outside: false, back: false })

  // --- chip dragging (resource / symbol / text in pan mode) ---
  const chipDown = (e: React.PointerEvent, id: string, shownFloor?: number) => {
    if (tool !== 'pan') return
    // only the main button selects or drags (GESTURES.13): a right press on an object does nothing
    if (e.button > 0) { e.stopPropagation(); return }
    // (a locked shape never reaches this handler: its anno div is pointer-events:none —
    // click-through ink, the LockChip is the only door, same as a locked drawn Fläche)
    // Notiz-Grammatik (29.08., unified with symbols across Karte AND Plan): tapping a note opens
    // its detail panel, exactly as tapping a symbol opens its ContextPanel — the ⚙ grip that used
    // to be the panel's only door is gone. Not while the note is mid-edit (its textarea owns the
    // taps then), and never on placement: placeNode arms editId, not this.
    const self = annos.find((x) => x.id === id)
    const kind = self?.kind
    e.stopPropagation()
    const selectId = (pick: string) => {
      setSelId(pick); setSelIds([])
      const note = annos.find((x) => x.id === pick)?.kind === 'text'
      if (note && (readOnly || editId !== pick)) setNotePanelId(pick)
    }
    const select = () => selectId(id)
    // which chip did the finger MEAN? The nearest centre of the pile under its pad; a tap on
    // several fans them out, a tap on a fanned one is the answer
    const pile = self && !fan ? pileUnder(e.clientX, e.clientY, self) : []
    const tap = () => {
      if (fan) { setFan(null); select(); return }
      if (pile.length > 1) { setFan({ key: fanKey(fanOffsets(pile)), offsets: fanOffsets(pile) }); return }
      selectId(pile[0] ? pile[0].id.slice(0, pile[0].id.lastIndexOf(':')) : id)
    }
    const node = e.currentTarget instanceof HTMLElement ? e.currentTarget : null
    const live = stack || annos.some((line) => [line.startAttachment, line.endAttachment].some((rel) => rel?.target.kind === 'object' && rel.target.id === id))
    const grab = (sx: number, sy: number) => {
      chipDrag.current = { id, moved: false, sx, sy, floorOffset: (shownFloor ?? 0) - (annos.find((a) => a.id === id)?.floor ?? 0), node, live, last: null, orig: annos.find((a) => a.id === id) ?? null }
    }
    // view-only (viewer / replay / EL view): a tap still SELECTS — so the read-only detail panel
    // can open, parity with the Lage map — but nothing ever drags.
    // ⚠️ A FORM has no body drag (02.09., Karte parity): it is moved from the bar's ✥, and its
    // body only selects — so a press on a Rotation's loop cannot nudge it away from the end grip
    // somebody was aiming for.
    // While a pile is fanned nothing drags: the chips stand off their real positions.
    const canDrag = !readOnly && kind !== 'shape' && !fan
    const resolves = !!fan || pile.length > 1 // the tap decides – a pile is never grabbed on the press
    if (canDrag && !resolves && (selId === id || e.pointerType === 'mouse')) {
      grab(e.clientX, e.clientY)
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      select()
      return
    }
    const sx = e.clientX, sy = e.clientY
    panFrom(e)
    hold.begin(e, {
      onTap: tap,
      // the still hold lifted it: the board stops where it is and the chip follows the finger
      onHoldStart: () => { stopPan(); grab(sx, sy); select() },
    }, { mode: e.pointerType === 'mouse' ? 'mouse' : 'touch', canDrag })
  }
  /** The board with the dragged chip at `point` — and every trace-routed Leitung end along. */
  const movedTo = (d: NonNullable<typeof chipDrag.current>, point: BoardPoint): BoardAnno[] => annos.map((anno) => {
    if (anno.id === d.id) {
      const f = point[2] ?? 0
      let moved: BoardAnno = { ...anno, x: point[0], y: point[1], ...(stack ? { floor: f - d.floorOffset } : {}) }
      // a Durchgang dropped near a Wand sits on it again, turned along it; elsewhere it stands free
      if (stack && isDoor(anno) && sW) moved = seatDoor(moved, nearestWall(annos, moved.floor ?? 0, point[0], point[1], tileAR, DOOR_SNAP_PX / sW))
      return stack ? normalizeStackEdit(anno, moved) : withDrawingStorey(d.orig, moved, drawings)
    }
    if (anno.kind !== 'draw' || !anno.pts?.length) return anno
    let next = anno
    for (const endpoint of ['start', 'end'] as const) {
      const rel = endpoint === 'start' ? next.startAttachment : next.endAttachment
      if (rel?.target.kind === 'object' && rel.target.id === d.id && rel.routing === 'trace') next = { ...next, pts: applyRouting(next.pts!, endpoint, point, 'trace', 0.002) }
    }
    return next
  })
  const chipMove = (e: React.PointerEvent) => {
    const d = chipDrag.current
    if (!d) return
    const a = annos.find((x) => x.id === d.id); if (!a) return
    const n = toNorm(e.clientX, e.clientY); if (!n) return
    // deadzone (shared with the Lage map's hold-to-drag): don't move until the pointer travels
    // past DRAG_DEADZONE_PX, so a tap-to-select can't nudge a placed chip a pixel.
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_DEADZONE_PX) return
    if (!d.moved && d.live) pushPast() // one checkpoint per drag, before the first move
    d.moved = true
    // on the floor-stack the chip drags FREELY across storeys: the floor follows the cursor,
    // y is re-localised into whichever storey the pointer is over. Single-sheet docs unchanged.
    const f = (stack ? floorAt(n[1]) : a.floor) ?? 0
    const point: BoardPoint = [n[0], localY(n[1], f), f]
    d.last = point
    if (d.live) { set(movedTo(d, point)); return }
    // the chip's anchor goes where the finger is (the same jump-to-the-finger the board write makes)
    if (d.node) d.node.style.translate = `${(n[0] - (a.x ?? 0)) * sW}px ${(n[1] - mapY(a.floor, a.y ?? 0)) * sH}px`
  }
  const chipUp = () => {
    const d = chipDrag.current; chipDrag.current = null
    if (!d || !d.moved) return
    // ONE write for the whole release: the positions (unless they streamed), the time, the join —
    // each a patch of this render's `annos` would overwrite the one before it
    let next = annos
    if (!d.live && d.last) {
      // the board takes the chip over from the node in the same frame (React re-renders the
      // transform before the next paint)
      if (d.node) d.node.style.translate = ''
      pushPast() // the drag's one step
      next = movedTo(d, d.last)
    }
    // moving just relocates the team's live position — it does NOT record a
    // breadcrumb. Positions are logged only via markPosition (explicit), so the
    // rule is unambiguous: a dot exists exactly where you chose to log one.
    const stamp = (x: BoardAnno) => (x.id === d.id && x.kind === 'resource' ? { ...x, t: formatTime(new Date(serverNow())) } : x)
    next = next.map(stamp)
    const a = next.find((x) => x.id === d.id)
    const join = joinFor(a)
    if (join) next = next.map((x) => (x.id === join.lineId ? { ...x, ...join.out } : x))
    set(next)
    // record the relocation in the audit trail (the drag itself was silent patches)
    if (a) emit('board.move', { id: d.id, x: a.x, y: a.y, floor: a.floor, ...(a.kind === 'symbol' ? storeyMove(a, stack, drawings) : {}), planId: activeId })
    // …and a Durchgang's seat, which a position does not carry (its turn, the Wand it sits on)
    if (a && stack && isDoor(a)) emit('board.edit', { id: d.id, patch: { rotation: a.rotation, onWall: a.onWall ?? null }, planId: activeId })
    next.filter((line) => [line.startAttachment, line.endAttachment].some((rel) => rel?.target.kind === 'object' && rel.target.id === d.id && rel.routing === 'trace'))
      .forEach((line) => emit('board.edit', { id: line.id, patch: { pts: line.pts }, planId: activeId }))
    if (!a || !join) return
    emit('board.edit', { id: join.lineId, patch: join.out, planId: activeId })
    // …and the link itself, unless this hose is already anchored to this very Trupp — nudging the
    // chip beside its own Leitung is not a new fact, and every link writes a Verlauf row
    if (a.truppId && annos.find((x) => x.id === join.lineId)?.truppId !== a.truppId) onLinkLineTrupp?.(join.lineId, a.truppId)
  }
  /**
   * Ein Trupp auf dem Leitungsende (15.09.): a Trupp's chip dropped on the FREE end of a hose
   * joins the two, the same link snapping the hose onto the chip makes — the picture is the
   * pick, from whichever side the operator works. The Karte does exactly this on its own marker
   * release (IncidentWorkspace · finishEntityMove). The chip's own DOT is what is measured (its
   * body hangs to the right of it — see attachBox), only ends that hang free count, and the
   * middle of a hose says nothing about who works it. The coupling is written exactly as the
   * endpoint magnet writes one (routed «Direkt» by default — lib/lineAttachments ·
   * DEFAULT_OBJECT_ROUTING), inside the drag's own step — one gesture, one step.
   */
  const joinFor = (a: BoardAnno | undefined): { lineId: string; out: Partial<BoardAnno> } | null => {
    if (a?.kind !== 'resource' || !a.truppId || a.x == null || a.y == null || !sW || !sH) return null
    const join = nearestFreeEndpoint<BoardPoint>(
      [a.x * sW, mapY(a.floor, a.y) * sH],
      attachmentLines,
      (p) => [p[0] * sW, mapY(p[2] ?? 0, p[1]) * sH],
    )
    if (!join) return null
    return { lineId: join.lineId, out: join.endpoint === 'start' ? { startAttachment: objectAttachment(a.id) } : { endAttachment: objectAttachment(a.id) } }
  }

  return { chipDrag, chipDown, chipMove, chipUp, fan }
}
