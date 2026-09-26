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
export type UndoDomain = 'karte' | 'plan' | 'trupps' | 'anwesenheit' | 'mittel' | 'checkliste' | 'gebaeude' | 'rapport' | 'zeitplan' | 'ansicht' | 'pendenz' | 'suche'

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

/** What `push` hands back: the dropper (call it) and a way to NAME the entry once the writer
 *  knows what it did — the Karte learns that only after its commit (its Verlauf row, or the
 *  objects that changed), and the ↶ must not keep saying «Änderung auf der Karte». */
export type UndoHandle = (() => void) & { rename: (label: string) => void }

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
  push: (entry: UndoEntry) => UndoHandle
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
  /**
   * ONE act that writes into several domains is ONE step (staging r3 F1). Everything pushed until
   * the returned `end()` is gathered into a single entry: its undo takes the parts back newest
   * first, its redo puts them back in order, and it carries the label of the part named by
   * `primary` (the Trupp's «Trupp 2 … angemeldet», not the «Anwesenheit» its crew filing wrote
   * after it). A registration with two Gäste used to leave «Rückgängig: Anwesenheit» on top — a
   * ↶ that stripped the crew's AS-Funktion, kept them present and kept the Trupp.
   *
   * Re-entrant: a group opened while one is open joins it (its `end` does nothing). A group with
   * one part pushes that part as it is; with none, nothing.
   */
  group: (primary?: UndoDomain) => () => void
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

  const record = (entry: UndoEntry, id: string) => {
    // A new action anywhere clears the ENTIRE global redo tail, not just its own domain's:
    // the tail is a chronology, and re-doing into a past that has moved on is not «forward».
    past = [...past, { ...entry, id }].slice(-cap)
    future = []
    notify()
  }
  const dropById = (id: string) => {
    const before = past.length + future.length
    past = past.filter((e) => e.id !== id)
    future = future.filter((e) => e.id !== id)
    if (past.length + future.length !== before) notify()
  }

  /** the open group: its parts, and — once it is recorded — the id each part now lives under */
  let open: { parts: Recorded[]; primary?: UndoDomain } | null = null
  const partOf = new Map<string, string>()
  /** a recorded compound step → the part whose label it wears */
  const headOf = new Map<string, string>()

  const compound = (parts: Recorded[], primary?: UndoDomain): UndoEntry => {
    const head = parts.find((p) => p.domain === primary) ?? parts[0]
    return {
      domain: head.domain,
      label: head.label,
      scope: head.scope,
      // newest first, like the separate steps would have run; a part that finds its target gone
      // does not stop the others (they are still takeable), but the step reports the loss
      undo: () => {
        let ok = true
        for (const p of [...parts].reverse()) if (p.undo() === false) ok = false
        return ok
      },
      redo: () => {
        let ok = true
        for (const p of parts) if (p.redo() === false) ok = false
        return ok
      },
    }
  }

  return {
    push: (entry) => {
      const id = newId('u')
      const g0 = open
      let drop: () => void
      if (g0) {
        g0.parts.push({ ...entry, id })
        drop = () => {
          if (open === g0) { g0.parts = g0.parts.filter((p) => p.id !== id); return }
          // dropped after the group closed: the part is inside a recorded step — drop that step
          const host = partOf.get(id)
          if (host) dropById(host)
        }
      } else {
        record(entry, id)
        drop = () => dropById(id)
      }
      return Object.assign(drop, {
        // the writer names its step once it knows its words (lib/karteStepLabel) — a part still in
        // an open group is renamed there; a recorded compound takes the name only from its HEAD part
        rename: (label: string) => {
          if (g0 && open === g0) { g0.parts = g0.parts.map((p) => (p.id === id ? { ...p, label } : p)); return }
          const host = partOf.get(id)
          const target = host && headOf.get(host) === id ? host : host ? null : id
          if (!target) return
          let hit = false
          const named = (e: Recorded) => { if (e.id !== target || e.label === label) return e; hit = true; return { ...e, label } }
          past = past.map(named)
          future = future.map(named)
          if (hit) notify()
        },
      })
    },
    group: (primary) => {
      if (open) return () => {}
      const g: { parts: Recorded[]; primary?: UndoDomain } = { parts: [], primary }
      open = g
      return () => {
        if (open !== g) return
        open = null
        if (!g.parts.length) return
        if (g.parts.length === 1) { record(g.parts[0], g.parts[0].id); return }
        const id = newId('u')
        for (const p of g.parts) partOf.set(p.id, id)
        headOf.set(id, (g.parts.find((p) => p.domain === g.primary) ?? g.parts[0]).id)
        record(compound(g.parts, g.primary), id)
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
