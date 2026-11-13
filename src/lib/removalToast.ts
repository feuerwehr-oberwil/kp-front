// The one delete rule (docs/undo.md · «One delete rule», 13.11.2026, owner: «one rule
// everywhere»): a removal the ↶ timeline can bring back ACTS AT ONCE and says so – «{Name}
// entfernt · Rückgängig». A red ConfirmCard stands only in front of what nothing brings back.
//
// The toast's «Rückgängig» IS the header's ↶ for that one step: the removal's own timeline entry
// is read off the top right after the act, and the button steps it back only while it is still on
// top. Once something else happened in between it declines («Nicht mehr rückgängig machbar») and
// the header's ↶ still reaches the removal. That is the Tafel bin's binding (usePlanTafelPages ·
// deletionToast), and it is exact: the snapshot stacks of the Karte and the Plans give back every
// Leitung end, placard bond, sheet anchor and page the removal touched, and the counter-row is
// the ↶'s own – nothing here re-implements an inverse.
//
// The timeline belongs to the open Einsatz, so IncidentWorkspace plugs it in
// (`connectRemovalToasts`); every removal path calls `removeWithUndo` around its write.

import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { toast, undoToast } from './ui'
import type { UndoEntry } from './undoTimeline'

/** What the toast needs of the Einsatz's timeline: its top entry, and the header's ↶. */
export interface RemovalPort {
  peek: () => UndoEntry | null
  undo: () => void
}

let port: RemovalPort | null = null

/** Plug the open Einsatz's timeline in; returns the unplug (a later plug wins). */
export function connectRemovalToasts(p: RemovalPort): () => void {
  port = p
  return () => { if (port === p) port = null }
}

/** Toasts of this kind replace each other: five bins in a row are one pill, every act on ↶. */
const KIND = 'removal'

/**
 * Run `act` – a removal that lays its own ↶ step – and show «`text` · Rückgängig».
 * An act that laid no step (read-only, nothing to remove) gets no toast: there is nothing to
 * take back, and «entfernt» would be a claim. Outside an Einsatz (no timeline plugged in) the
 * sentence stands alone, without the button. Returns what `act` returns.
 */
export function removeWithUndo<T>(text: string, act: () => T): T {
  const p = port
  const before = p?.peek() ?? null
  const out = act()
  if (!p) { toast(text, { icon: 'trash', kind: KIND }); return out }
  const step = p.peek()
  if (!step || step === before) return out
  undoToast(text, () => p.undo(), () => p.peek() === step, { kind: KIND })
  return out
}

/** The toast's sentence: `what` is the removal's own Verlauf words («TLF entfernt»), plus the
 *  Leitungen it set loose – «TLF entfernt, 2 Leitungen gelöst». */
export function removedText(what: string, freed = 0): string {
  const C = appConfig.copy.removedToast
  return freed > 0 ? fillTemplate(freed === 1 ? C.freedOne : C.freed, { what, n: freed }) : what
}
