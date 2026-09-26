import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { newId } from '../lib/ids'
import { confirmDialog } from '../lib/ui'
import { annoRefs, recordKey, type HistoryStep, type RecordKey } from '../lib/undoKeys'
import type { BoardAnno } from '../types'

/** One step of a plan's history: the sheet's view before it (on `past`) or after it (on
 *  `future`), under the id its timeline entry names. */
export type PlanStep = HistoryStep<BoardAnno[]>

const EMPTY_HIST: { past: PlanStep[]; future: PlanStep[] } = { past: [], future: [] }

/** A fresh id for a plan step — minted by whoever lays the step, and handed to the timeline with
 *  it (`onCheckpoint`), so a merge can keep or drop THAT snapshot (`keepPlanSteps`). */
export const newPlanStep = () => newId('pl')

/**
 * Check-point one plan's annotations — the single definition of what an undo step IS on the board.
 *
 * Exported because the Whiteboard is not the only writer any more: dragging a plan symbol's
 * projection on the Karte moves that plan's annotation while the plan itself is not open (and the
 * Whiteboard is not even mounted — it lives only while `mode === 'plans'`). That write still owes
 * the document an undo step, and it must be the SAME step, capped the same way, or the two writers
 * would disagree about what Rückgängig means on one document.
 */
export function pushBoardPast(hist: BoardHistory, planId: string, snapshot: BoardAnno[], id: string): BoardHistory {
  const c = hist[planId] ?? EMPTY_HIST
  return { ...hist, [planId]: { past: [...c.past, { id, snap: snapshot }].slice(-appConfig.defaults.historyCap), future: [] } }
}

/** Undo/redo stacks for every plan document, keyed by plan id — the scope is per-plan, so one
 *  plan's history can never step into another's. Owned by the surface ABOVE the Whiteboard: see
 *  `hist`/`setHist` below. */
export type BoardHistory = Record<string, { past: PlanStep[]; future: PlanStep[] }>

/**
 * The records ONE plan's history can write, for every entry of it alike: each object any of its
 * snapshots or the sheet's live view holds, plus the view itself (`planview:<planId>`, which a
 * merge reports for every sheet whose DRAWN picture it changed — undoKeys · planViewChanges).
 *
 * ⚠️ Deliberately the whole stack's set, not the step's own. The stack is whole-sheet VIEW
 * snapshots restored through `setBoard`, where an absent anno is a deletion, so a step cannot be
 * re-laid record by record the way the Karte's can: a projection the snapshot never held would be
 * read as deleted. Every entry naming the same set makes the timeline drop a plan's steps together
 * (a dropped one poisons all older ones), and a kept stack is one whose every snapshot the merge
 * left true.
 */
export function planStackTouches(planId: string, hist: BoardHistory[string] | undefined, live: readonly BoardAnno[] | undefined): RecordKey[] {
  const ids = new Set<string>()
  const refs = new Set<RecordKey>()
  const snaps = [...(hist?.past ?? []), ...(hist?.future ?? [])].map((s) => s.snap)
  for (const snap of [...snaps, live ?? []]) {
    for (const a of snap) {
      ids.add(a.id)
      // …and what each anno points at (a Leitung end on another object): a restore re-states it
      for (const r of annoRefs(a)) refs.add(r)
    }
  }
  return [recordKey('planview', planId), ...[...ids].map((id) => recordKey('objects', id)), ...refs]
}

/**
 * Each plan's stacks cut down to the steps whose timeline entries survived a merge — by step id,
 * against a set captured when the merge ran (`keep`), never re-read later. A plan's steps all
 * name the same records (`planStackTouches`), so a plan's survivors are always its newest on the
 * ↶ side and its next on the ↷ side, but the id says so exactly.
 */
export function keepPlanSteps(hist: BoardHistory, keep: (step: string) => boolean): BoardHistory {
  let out: BoardHistory | null = null
  for (const [planId, h] of Object.entries(hist)) {
    const past = h.past.filter((s) => keep(s.id))
    const future = h.future.filter((s) => keep(s.id))
    if (past.length === h.past.length && future.length === h.future.length) continue
    out ??= { ...hist }
    out[planId] = { past, future }
  }
  return out ?? hist
}

interface BoardDocDeps {
  annos: BoardAnno[]
  onChange: (next: BoardAnno[], opts?: { gesture?: boolean }) => void
  emit: (op: string, payload?: Record<string, unknown>) => void
  activeId: string
  selId: string | null
  setSelId: (id: string | null) => void
  editId: string | null
  setEditId: (id: string | null) => void
  historyRef?: MutableRefObject<{ undo: (expect?: string) => boolean; redo: (expect?: string) => boolean } | null>
  /** ⚠️ The history stacks live OUTSIDE this hook, in the surface that mounts the Whiteboard —
   *  the board unmounts on every surface switch (`mode !== 'plans'`), and as component state the
   *  stacks went with it: draw a Leitung, glance at the Verlauf, come back, and Rückgängig was
   *  grey. Same reasoning as `useUndoableSlice` (undo over state somebody else owns). Still keyed
   *  by plan id, so surviving the unmount does NOT leak one plan's history into another's. */
  hist: BoardHistory
  setHist: Dispatch<SetStateAction<BoardHistory>>
  /** Told whenever a step is laid down on THIS plan, so the one global timeline
   *  (`lib/undoTimeline`) can record that the plan moved, in the same chronology as the Karte and
   *  the Tafel. The per-plan stacks above stay the thing that answers the step itself. */
  onCheckpoint?: (planId: string, step: string) => void
  onStepEnd?: () => void
}

/**
 * The Whiteboard's annotation document + per-plan undo/redo, lifted out of the god-component.
 * It drives the caller-owned keyed history map (`hist`/`setHist`) and the mutation funnel
 * (set = raw write, commit = checkpoint + write) plus the audit-emitting CRUD
 * (add/patch/patchCommit/remove) and undo/redo, and wires this plan's history into the global
 * TopBar (historyRef).
 *
 * Mirrors the map's history model exactly — every discrete mutation checkpoints the previous
 * annotation array; a continuous gesture (chip drag) checkpoints once on first movement, so a whole
 * drag is one step. The functions stay byte-for-byte equivalent to their former inline selves; the
 * gesture handlers in Whiteboard call the returned pushPast/commit/patchCommit/… as before.
 */
export function useBoardDoc({ annos, onChange, emit, activeId, selId, setSelId, editId, setEditId, historyRef, hist, setHist, onCheckpoint, onStepEnd }: BoardDocDeps) {
  // Per-document undo/redo, mirroring the map's history model. Every discrete
  // mutation checkpoints the previous annotation array; a continuous gesture
  // (chip drag) checkpoints once, on first movement, so a whole drag is one step.
  // (`hist`/`setHist` are passed IN — see BoardDocDeps for why they can't live here.)
  const h = hist[activeId] ?? EMPTY_HIST
  const canUndo = h.past.length > 0
  const canRedo = h.future.length > 0
  /** the step the running gesture laid — see `set` */
  const openStep = useRef<string | null>(null)
  const seenStep = useRef<string | null>(null)
  const pushPast = () => {
    const step = newPlanStep()
    openStep.current = step
    setHist((m) => pushBoardPast(m, activeId, annos, step)); onCheckpoint?.(activeId, step)
  }
  /**
   * Raw write, no checkpoint — a gesture's later samples fold into the step its first one laid.
   * ⚠️ Unless a remote merge took that step away mid-gesture (keepPlanSteps, 25.09.2026): the
   * samples would then fold into nothing and the rest of the gesture could not be taken back, so
   * the first sample after it lays a fresh step (its snapshot is the merged sheet).
   */
  const set = (next: BoardAnno[]) => {
    const open = openStep.current
    if (open) {
      // ⚠️ only a step this hook has SEEN on the stack counts as gone when it is missing: the
      // stack arrives a render after `pushPast`, and the samples in between must fold, not heal
      const standing = h.past.some((s) => s.id === open) || h.future.some((s) => s.id === open)
      if (standing) seenStep.current = open
      else if (seenStep.current === open) pushPast()
    }
    onChange(next)
  }
  const commit = (next: BoardAnno[]) => { pushPast(); onChange(next); onStepEnd?.() }   // checkpoint + write
  // plan mutations now feed the hash-chained audit trail too (board.* ops) — previously
  // the whole Plan surface was invisible to replay/audit. Replay ignores these (it
  // reconstructs the board from snapshots), so they're audit-only and safe to add.
  const add = (a: BoardAnno) => { commit([...annos, a]); emit('board.add', { id: a.id, anno: a, planId: activeId }) }
  const patch = (id: string, p: Partial<BoardAnno>) => set(annos.map((a) => (a.id === id ? { ...a, ...p } : a)))
  const patchCommit = (id: string, p: Partial<BoardAnno>) => { commit(annos.map((a) => (a.id === id ? { ...a, ...p } : a))); emit('board.edit', { id, patch: p, planId: activeId }) }
  const remove = (id: string) => { commit(annos.filter((a) => a.id !== id)); emit('board.delete', { id, planId: activeId }); if (selId === id) setSelId(null); if (editId === id) setEditId(null) }
  // confirm before deleting a note that has been written (parity with the Lage map note).
  // Answers whether the object actually went: a caller that armed something on the way in
  // («Marker und Spur löschen», Whiteboard) has to take that back when the ask was declined.
  const removeAnno = async (a: BoardAnno): Promise<boolean> => {
    if (a.kind === 'text' && a.text?.trim()) {
      const ok = await confirmDialog({ title: appConfig.copy.notes.deleteTitle, message: appConfig.copy.notes.deleteMsg, confirmLabel: appConfig.copy.remove, cancelLabel: appConfig.copy.cancel, danger: true })
      if (!ok) return false
    }
    remove(a.id)
    return true
  }
  // `expect` = the step the timeline entry stands for; a different top is not stepped
  const undo = (expect?: string): boolean => {
    const c = hist[activeId]
    const prev = c?.past[c.past.length - 1]
    if (!prev || (expect !== undefined && prev.id !== expect)) return false
    setHist((m) => { const cc = m[activeId]!; return { ...m, [activeId]: { past: cc.past.slice(0, -1), future: [{ id: prev.id, snap: annos }, ...cc.future] } } })
    // ⚠️ a restore, not a placement: `gesture: false`, or a projection the snapshot still held at
    // an older spot would flip onto this sheet (lib/useObjectStore · setBoard, 24.09.2026)
    onChange(prev.snap, { gesture: false }); setSelId(null); setEditId(null)
    // ⚠️ No Verlauf row here since 08.09.2026. This is reached ONLY through the one global
    // timeline now (IncidentWorkspace · planStepAt), which writes the row itself — and writes
    // the SAME row whether the plan happened to be open or not. Logging in both places gave a
    // step on the open plan two lines and a step on a closed one a different wording.
    return true
  }
  const redo = (expect?: string): boolean => {
    const c = hist[activeId]
    const next = c?.future[0]
    if (!next || (expect !== undefined && next.id !== expect)) return false
    setHist((m) => { const cc = m[activeId]!; return { ...m, [activeId]: { past: [...cc.past, { id: next.id, snap: annos }], future: cc.future.slice(1) } } })
    onChange(next.snap, { gesture: false }); setSelId(null); setEditId(null)
    // …and the same for the way forward (see `undo` above).
    return true
  }
  // hand this plan's history to the global TopBar undo/redo (App routes by surface).
  // Re-assign after every commit so the captured undo/redo always close over the latest
  // state; cleared on unmount so a stale plan undo can't fire from another surface.
  useEffect(() => { if (historyRef) historyRef.current = { undo, redo }; return () => { if (historyRef) historyRef.current = null } })

  return { canUndo, canRedo, pushPast, set, commit, add, patch, patchCommit, remove, removeAnno, undo, redo }
}
