import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { confirmDialog } from '../lib/ui'
import type { BoardAnno } from '../types'
import type { PlanLogExtra } from './Whiteboard'

const EMPTY_HIST = { past: [] as BoardAnno[][], future: [] as BoardAnno[][] }

/** Undo/redo stacks for every plan document, keyed by plan id — the scope is per-plan, so one
 *  plan's history can never step into another's. Owned by the surface ABOVE the Whiteboard: see
 *  `hist`/`setHist` below. */
export type BoardHistory = Record<string, { past: BoardAnno[][]; future: BoardAnno[][] }>

interface BoardDocDeps {
  annos: BoardAnno[]
  onChange: (next: BoardAnno[]) => void
  emit: (op: string, payload?: Record<string, unknown>) => void
  activeId: string
  log: (icon: string, text: string, extra?: PlanLogExtra) => void
  selId: string | null
  setSelId: (id: string | null) => void
  editId: string | null
  setEditId: (id: string | null) => void
  historyRef?: MutableRefObject<{ undo: () => void; redo: () => void } | null>
  onHistoryState?: (s: { canUndo: boolean; canRedo: boolean }) => void
  /** ⚠️ The history stacks live OUTSIDE this hook, in the surface that mounts the Whiteboard —
   *  the board unmounts on every surface switch (`mode !== 'plans'`), and as component state the
   *  stacks went with it: draw a Leitung, glance at the Verlauf, come back, and Rückgängig was
   *  grey. Same reasoning as `useUndoableSlice` (undo over state somebody else owns). Still keyed
   *  by plan id, so surviving the unmount does NOT leak one plan's history into another's. */
  hist: BoardHistory
  setHist: Dispatch<SetStateAction<BoardHistory>>
}

/**
 * The Whiteboard's annotation document + per-plan undo/redo, lifted out of the god-component.
 * It drives the caller-owned keyed history map (`hist`/`setHist`) and the mutation funnel
 * (set = raw write, commit = checkpoint + write) plus the audit-emitting CRUD
 * (add/patch/patchCommit/remove) and undo/redo, and wires this plan's history into the global
 * TopBar (historyRef) + reports can-undo/redo up (onHistoryState).
 *
 * Mirrors the map's history model exactly — every discrete mutation checkpoints the previous
 * annotation array; a continuous gesture (chip drag) checkpoints once on first movement, so a whole
 * drag is one step. The functions stay byte-for-byte equivalent to their former inline selves; the
 * gesture handlers in Whiteboard call the returned pushPast/commit/patchCommit/… as before.
 */
export function useBoardDoc({ annos, onChange, emit, activeId, log, selId, setSelId, editId, setEditId, historyRef, onHistoryState, hist, setHist }: BoardDocDeps) {
  // Per-document undo/redo, mirroring the map's history model. Every discrete
  // mutation checkpoints the previous annotation array; a continuous gesture
  // (chip drag) checkpoints once, on first movement, so a whole drag is one step.
  // (`hist`/`setHist` are passed IN — see BoardDocDeps for why they can't live here.)
  const h = hist[activeId] ?? EMPTY_HIST
  const canUndo = h.past.length > 0
  const canRedo = h.future.length > 0
  const pushPast = () => setHist((m) => {
    const c = m[activeId] ?? EMPTY_HIST
    return { ...m, [activeId]: { past: [...c.past, annos].slice(-appConfig.defaults.historyCap), future: [] } }
  })
  const set = (next: BoardAnno[]) => onChange(next)                      // raw write, no checkpoint
  const commit = (next: BoardAnno[]) => { pushPast(); onChange(next) }   // checkpoint + write
  // plan mutations now feed the hash-chained audit trail too (board.* ops) — previously
  // the whole Plan surface was invisible to replay/audit. Replay ignores these (it
  // reconstructs the board from snapshots), so they're audit-only and safe to add.
  const add = (a: BoardAnno) => { commit([...annos, a]); emit('board.add', { id: a.id, anno: a, planId: activeId }) }
  const patch = (id: string, p: Partial<BoardAnno>) => set(annos.map((a) => (a.id === id ? { ...a, ...p } : a)))
  const patchCommit = (id: string, p: Partial<BoardAnno>) => { commit(annos.map((a) => (a.id === id ? { ...a, ...p } : a))); emit('board.edit', { id, patch: p, planId: activeId }) }
  const remove = (id: string) => { commit(annos.filter((a) => a.id !== id)); emit('board.delete', { id, planId: activeId }); if (selId === id) setSelId(null); if (editId === id) setEditId(null) }
  // confirm before deleting a note that has been written (parity with the Lage map note)
  const removeAnno = async (a: BoardAnno) => {
    if (a.kind === 'text' && a.text?.trim()) {
      const ok = await confirmDialog({ title: appConfig.copy.notes.deleteTitle, message: appConfig.copy.notes.deleteMsg, confirmLabel: appConfig.copy.delete, cancelLabel: appConfig.copy.cancel, danger: true })
      if (!ok) return
    }
    remove(a.id)
  }
  const undo = () => {
    const c = hist[activeId]; if (!c || !c.past.length) return
    const prev = c.past[c.past.length - 1]
    setHist((m) => { const cc = m[activeId]!; return { ...m, [activeId]: { past: cc.past.slice(0, -1), future: [annos, ...cc.future] } } })
    onChange(prev); setSelId(null); setEditId(null)
    log('undo', appConfig.copy.log.undo, { kind: 'history' })
  }
  const redo = () => {
    const c = hist[activeId]; if (!c || !c.future.length) return
    const next = c.future[0]
    setHist((m) => { const cc = m[activeId]!; return { ...m, [activeId]: { past: [...cc.past, annos], future: cc.future.slice(1) } } })
    onChange(next); setSelId(null); setEditId(null)
    log('redo', appConfig.copy.log.redo, { kind: 'history' })
  }
  // hand this plan's history to the global TopBar undo/redo (App routes by surface).
  // Re-assign after every commit so the captured undo/redo always close over the latest
  // state; cleared on unmount so a stale plan undo can't fire from another surface.
  useEffect(() => { if (historyRef) historyRef.current = { undo, redo }; return () => { if (historyRef) historyRef.current = null } })
  useEffect(() => { onHistoryState?.({ canUndo, canRedo }) }, [canUndo, canRedo]) // eslint-disable-line react-hooks/exhaustive-deps

  return { canUndo, canRedo, pushPast, set, commit, add, patch, patchCommit, remove, removeAnno, undo, redo }
}
