/**
 * «Ziel auf der Karte wählen» (owner pick M5a A, 18.11.2026) – the «Karte» button beside the Ziel,
 * in the Trupp form AND in the card's Auftrag sheet (both doors edit the same Ziel, so both offer
 * the same button – owner, 18.11.2026). The asker steps away, the operator taps a symbol on the
 * Karte (or on the Plan they came from), and the asker comes back with that symbol's NAME in the
 * Ziel («Vollbrand 2. OG»). «Abbrechen» brings it back with the field as it was.
 *
 * ⚠️ TEXT ONLY (M5c): the pick writes the name into the field and nothing else – the Trupp is not
 * docked, placed or moved. Placing a Trupp is its own act (the card's ⋯ › Platzieren).
 *
 * Module state rather than props, for the reason draftKeep is: the asker lives on the Trupps
 * surface, and the Trupps surface UNMOUNTS while the Karte or the Plan is up. So the store parks
 * the asker as it stood (`ZielAsker`):
 * - the FORM (`TruppFormOpen`, the board's own `form` state) and the draft key of its Ziel – every
 *   other field the operator typed is already kept by draftKeep, so the pick writes the name into
 *   that kept draft and the remounted form simply reads it back;
 * - the AUFTRAG SHEET (`AuftragSheetOpen`): which Trupp, and the sheet's three fields as typed. The
 *   sheet keeps no drafts of its own, so the store holds them, and the pick writes the name there.
 *
 * Three phases: `picking` (the surface takes the next symbol tap), `back` (answered or cancelled –
 * the workspace switches to the Trupps surface), and `idle` once the board has opened the asker
 * again (AtemschutzView). Leaving the Karte / Plan for any other surface mid-pick drops it
 * (`endZielPick`): the form's fields stay kept, as for any surface switch; the sheet's go.
 *
 * Who reads it: AtemschutzView (starts it, re-opens the parked asker), IncidentWorkspace (the
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

/** the card's Auftrag sheet's fields as typed (TruppSheets · AuftragSheet) */
export type AuftragDraft = {
  auftrag: TruppAuftrag | null | undefined
  ziel: string
  lineNo: number | null
}
/** …and whose sheet it is – what comes back after a pick */
export type AuftragSheetOpen = AuftragDraft & { truppId: string }

/** who asked for the pick: the Trupp form (its Ziel kept in draftKeep under `field`), or the
 *  Auftrag sheet (its fields held here) */
export type ZielAsker =
  | { kind: 'form'; form: TruppFormOpen; field: string }
  | { kind: 'auftrag'; sheet: AuftragSheetOpen }

/** the Ziel field's cap – the card's one-line Ziel and the Leitung chip must not be blown out */
export const ZIEL_MAX_LEN = 60

export type ZielPickPhase = 'idle' | 'picking' | 'back'

type State =
  | { phase: 'idle' }
  | { phase: 'picking' | 'back'; asker: ZielAsker }

let state: State = { phase: 'idle' }
const listeners = new Set<() => void>()
const set = (next: State) => { state = next; listeners.forEach((l) => l()) }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const phase = (): ZielPickPhase => state.phase

/** A «Karte» beside a Ziel was tapped: park the asker until a symbol answers or the pick is cancelled. */
export function beginZielPick(asker: ZielAsker): void {
  set({ phase: 'picking', asker })
}

/** A symbol was tapped while picking: its name goes into the parked Ziel, and the asker comes back. */
export function answerZielPick(target: Pick<SymbolProps, 'label' | 'symbol'>): void {
  if (state.phase !== 'picking') return
  const name = doneName(target).slice(0, ZIEL_MAX_LEN)
  const { asker } = state
  if (asker.kind === 'form') keepDraft(asker.field, name)
  set({ phase: 'back', asker: asker.kind === 'form' ? asker : { kind: 'auftrag', sheet: { ...asker.sheet, ziel: name } } })
}

/** «Abbrechen»: the asker comes back with its Ziel untouched. */
export function cancelZielPick(): void {
  if (state.phase === 'picking') set({ phase: 'back', asker: state.asker })
}

/** The form / the sheet to open again, while a pick is running or just answered – read, never
 *  taken, so a StrictMode double render of the board's initial state sees it twice. */
export function parkedTruppForm(): TruppFormOpen | null {
  return state.phase !== 'idle' && state.asker.kind === 'form' ? state.asker.form : null
}
export function parkedAuftragSheet(): AuftragSheetOpen | null {
  return state.phase !== 'idle' && state.asker.kind === 'auftrag' ? state.asker.sheet : null
}

/** The board has the asker open again, or the operator left for another surface. */
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
