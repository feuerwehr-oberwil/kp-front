import { appConfig } from '../config/appConfig'
import { newId } from './ids'

/**
 * ONE chronological undo timeline for the whole Einsatz (decided 2026-09-08).
 *
 * Before this, ↶ meant something different depending on where you were standing: the Karte had
 * document history, each Plan had its own, the Anwesenheit had a slice history with its own pair
 * of buttons on the phone, and the Atemschutz-Tafel had confirm-with-undo toasts that expired.
 * Four histories means an operator who taps ↶ has to already know which one he is in — the exact
 * recall the 3am tenet forbids. So the header pair now drives THIS: the last thing that happened
 * anywhere is the thing that comes back.
 *
 * ⚠️ This does NOT own any state. It is a list of what happened and how to take each one back:
 *
 *   • **Delegating entries** – the Karte document, one Plan document, the Anwesenheit slice –
 *     call their domain's own undo. That is sound because a global chronological order, read back
 *     restricted to one domain, IS that domain's LIFO order: every entry between two of a domain's
 *     entries belongs to some other domain, so the domain's own stack is never stepped out of turn.
 *   • **Closure entries** – the Atemschutz-Tafel, Mittel, Checklisten, the Gebäude one-shots –
 *     carry their own inverse, because those domains keep no stack of their own (they used to hand
 *     the inverse to a toast that then expired).
 *
 * ⚠️ An entry may describe something that no longer exists: the slice it edited was replaced by a
 * remote merge, or the record it touched lost a delete-beats-edit race. Two mechanisms answer that,
 * and both must stay – `invalidate()` for the history we KNOW died (the hydrate that dropped it),
 * and a soft `false` from an entry's own undo/redo for the one that only finds out when it tries.
 * Neither may throw: a failed undo drops its entry and says so quietly. Nothing is left half-done,
 * because an entry that cannot act does not act.
 */

/** The surfaces an entry can come from. `scope` narrows it further where a domain has several
 *  independent documents (a Plan id) – so replacing one plan does not invalidate the others. */
export type UndoDomain = 'karte' | 'plan' | 'trupps' | 'anwesenheit' | 'mittel' | 'checkliste' | 'gebaeude'

/** What an entry's undo/redo reports back. `false` = the target is gone; the entry is discarded
 *  and the operator is told, rather than the app pushing stale state over a remote truth. */
export type UndoResult = boolean | void

export interface UndoEntry {
  domain: UndoDomain
  /** ⚠️ NAMES THE ACTION, in the operator's words and already localised: «Kontakt Trupp 2». It is
   *  what the hold-tooltip promises and what the flash caption confirms, so a cross-surface undo
   *  never happens invisibly. Not a sentence – the surrounding copy supplies «Rückgängig: …». */
  label: string
  /** the document inside the domain, where there is more than one (plan id) */
  scope?: string
  undo: () => UndoResult
  redo: () => UndoResult
}

interface Recorded extends UndoEntry {
  id: string
}

/** What a step did. `lost` is the soft failure: the entry could not act and has been dropped. */
export type StepOutcome =
  | { status: 'empty' }
  | { status: 'done'; entry: UndoEntry }
  | { status: 'lost'; entry: UndoEntry }

export interface UndoTimeline {
  /** Record an action. Returns the way to take that ONE entry back off the timeline again –
   *  needed where a confirm-with-undo toast still stands beside the header pair: the toast's
   *  «Rückgängig» does the inverse itself, and the entry it describes must not stay on the stack
   *  for the ↶ to do a second time. */
  push: (entry: UndoEntry) => () => void
  undo: () => StepOutcome
  redo: () => StepOutcome
  /** the entry ↶ would take back – the label the hold-tooltip reads */
  peekUndo: () => UndoEntry | null
  /** the entry ↷ would put back */
  peekRedo: () => UndoEntry | null
  canUndo: () => boolean
  canRedo: () => boolean
  /** a domain's history is gone (remote hydrate, slice reset, plan replaced): drop its entries
   *  from BOTH stacks. Pass `scope` to drop one document's entries and leave its siblings. */
  invalidate: (domain: UndoDomain, scope?: string) => void
  /** everything is gone (a different incident is loaded) */
  clear: () => void
  /** React glue – fires whenever the stacks change, so `canUndo`/the label re-render */
  subscribe: (fn: () => void) => () => void
}

export function createUndoTimeline(cap: number = appConfig.defaults.historyCap): UndoTimeline {
  let past: Recorded[] = []
  let future: Recorded[] = []
  const listeners = new Set<() => void>()
  const notify = () => { for (const fn of listeners) fn() }

  const step = (from: 'past' | 'future'): StepOutcome => {
    const stack = from === 'past' ? past : future
    if (!stack.length) return { status: 'empty' }
    const entry = from === 'past' ? stack[stack.length - 1] : stack[0]
    // Taken off its stack BEFORE it runs, and on a `lost` it goes on no other: a step that could
    // not act is not a step you can walk back. The operator is told once and the next ↶ moves on
    // to the entry below, which is usually still perfectly takeable.
    if (from === 'past') past = past.slice(0, -1)
    else future = future.slice(1)
    const acted = from === 'past' ? entry.undo() : entry.redo()
    if (acted === false) { notify(); return { status: 'lost', entry } }
    if (from === 'past') future = [entry, ...future]
    else past = [...past, entry]
    notify()
    return { status: 'done', entry }
  }

  return {
    push: (entry) => {
      // A new action anywhere clears the ENTIRE global redo tail, not just its own domain's:
      // the tail is a chronology, and re-doing into a past that has moved on is not «forward».
      const id = newId('u')
      past = [...past, { ...entry, id }].slice(-cap)
      future = []
      notify()
      return () => {
        const before = past.length + future.length
        past = past.filter((e) => e.id !== id)
        future = future.filter((e) => e.id !== id)
        if (past.length + future.length !== before) notify()
      }
    },
    undo: () => step('past'),
    redo: () => step('future'),
    peekUndo: () => past[past.length - 1] ?? null,
    peekRedo: () => future[0] ?? null,
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    invalidate: (domain, scope) => {
      const keep = (e: Recorded) => e.domain !== domain || (scope !== undefined && e.scope !== scope)
      const before = past.length + future.length
      past = past.filter(keep)
      future = future.filter(keep)
      if (past.length + future.length !== before) notify()
    },
    clear: () => { past = []; future = []; notify() },
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
}
