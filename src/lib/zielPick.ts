/**
 * «Ziel auf der Karte wählen» (owner pick M5a A, 18.11.2026) – the Trupp form's «Karte» button
 * beside the Ziel field. The form steps away, the operator taps a symbol on the Karte (or on the
 * Plan they came from), and the form comes back with that symbol's NAME in the Ziel
 * («Vollbrand 2. OG»). «Abbrechen» brings it back with the field as it was.
 *
 * ⚠️ TEXT ONLY (M5c): the pick writes the name into the field and nothing else – the Trupp is not
 * docked, placed or moved. Placing a Trupp is its own act (the card's ⋯ › Platzieren).
 *
 * Module state rather than props, for the reason draftKeep is: the form that asked lives on the
 * Trupps surface, and the Trupps surface UNMOUNTS while the Karte or the Plan is up. So the store
 * holds the form as it was opened (`TruppFormOpen`, the board's own `form` state) and the draft key
 * of its Ziel field; every other field the operator typed is already kept by draftKeep. The pick
 * writes the name into that kept draft, so the remounted form simply reads it back.
 *
 * Three phases: `picking` (the surface takes the next symbol tap), `back` (answered or cancelled –
 * the workspace switches to the Trupps surface), and `idle` once the board has opened the form
 * again (AtemschutzView). Leaving the Karte / Plan for any other surface mid-pick drops it
 * (`endZielPick`): the form's fields stay kept, as for any surface switch.
 *
 * Who reads it: AtemschutzView (starts it, re-opens the parked form), IncidentWorkspace (the
 * surface switches and the `.ziel-pick` class), MapStage and Whiteboard (a symbol tap answers
 * instead of selecting), ZielPickBar (the prompt and «Abbrechen»).
 */

import { useSyncExternalStore } from 'react'
import { keepDraft } from './draftKeep'
import { doneName } from './objectDone'
import type { SymbolProps, Trupp, TruppAuftrag } from '../types'

/** the Trupp form as the board opened it (AtemschutzView · `form`) – what comes back after a pick */
export type TruppFormOpen = {
  mode: 'create' | 'edit' | 'redeploy'
  trupp?: Trupp
  focus?: 'auftrag'
  adoptMarkerId?: string
  presetAuftrag?: TruppAuftrag
}

/** the Ziel field's cap – the card's one-line Ziel and the Leitung chip must not be blown out */
export const ZIEL_MAX_LEN = 60

export type ZielPickPhase = 'idle' | 'picking' | 'back'

type State =
  | { phase: 'idle' }
  | { phase: 'picking'; field: string; form: TruppFormOpen }
  | { phase: 'back'; form: TruppFormOpen }

let state: State = { phase: 'idle' }
const listeners = new Set<() => void>()
const set = (next: State) => { state = next; listeners.forEach((l) => l()) }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const phase = (): ZielPickPhase => state.phase

/** The form's «Karte» was tapped: `field` is its Ziel's draft key, `form` the form to bring back. */
export function beginZielPick(field: string, form: TruppFormOpen): void {
  set({ phase: 'picking', field, form })
}

/** A symbol was tapped while picking: its name goes into the kept Ziel, and the form comes back. */
export function answerZielPick(target: Pick<SymbolProps, 'label' | 'symbol'>): void {
  if (state.phase !== 'picking') return
  keepDraft(state.field, doneName(target).slice(0, ZIEL_MAX_LEN))
  set({ phase: 'back', form: state.form })
}

/** «Abbrechen»: the form comes back with its Ziel untouched. */
export function cancelZielPick(): void {
  if (state.phase === 'picking') set({ phase: 'back', form: state.form })
}

/** The form to open again, while a pick is running or just answered – read, never taken, so a
 *  StrictMode double render of the board's initial state sees it twice. */
export function parkedTruppForm(): TruppFormOpen | null {
  return state.phase === 'idle' ? null : state.form
}

/** The board has the form open again, or the operator left for another surface. */
export function endZielPick(): void {
  if (state.phase !== 'idle') set({ phase: 'idle' })
}

/** Is a surface tap a pick right now? For event handlers; components render from `useZielPick`. */
export function zielPicking(): boolean {
  return state.phase === 'picking'
}

/** the phase, re-rendering on change */
export function useZielPick(): ZielPickPhase {
  return useSyncExternalStore(subscribe, phase, phase)
}
