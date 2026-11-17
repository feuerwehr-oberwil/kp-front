// The one delete rule (docs/undo.md · «One delete rule», 13.11.2026, owner: «one rule
// everywhere»): a removal the ↶ timeline can bring back ACTS AT ONCE – and says nothing (owner
// pick 28, 17.11.2026: no toast where the top bar's ↶ «Rückgängig» brings it back). The object
// leaving the screen is the confirmation; the ↶ names the step (`removedText` is its caption).
// A red ConfirmCard stands only in front of what nothing brings back.
//
// The snapshot stacks of the Karte and the Plans give back every Leitung end, placard bond, sheet
// anchor and page the removal touched in ONE ↶ step – nothing here re-implements an inverse.
//
// ONE exception asks first (owner, 14.11.2026): a symbol – or a Mehrfach group – that Leitungen
// hang on. «TLF hat 2 Leitungen» · [Nur Symbol] [Mit Leitungen] [Abbrechen] (`askJoinedLines`):
// «Nur Symbol» is the rule's act (the ends let go where they stood), «Mit Leitungen» takes every
// line on it in the same write (`withLinesText`), and either is still ONE ↶ step.
// Nothing joined → no card. Lage (workspace/useMapActions) and Plan (components/usePlanRemoval) alike.

import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { confirmDialog } from './ui'

/** The ↶ caption of a removal: `what` is the removal's own Verlauf words («TLF entfernt»), plus
 *  the Leitungen it set loose – «TLF entfernt, 2 Leitungen gelöst». */
export function removedText(what: string, freed = 0): string {
  const C = appConfig.copy.removedToast
  return freed > 0 ? fillTemplate(freed === 1 ? C.freedOne : C.freed, { what, n: freed }) : what
}

/** The «Mit Leitungen» sentence: «TLF und 2 Leitungen entfernt». `what` is the bare name. */
export function withLinesText(what: string, lines: number): string {
  const C = appConfig.copy.removedToast
  return fillTemplate(lines === 1 ? C.withLine : C.withLines, { what, n: lines })
}

/** What the joined-lines card answered: the object alone (its Leitungen let go), or with them. */
export type JoinedAnswer = 'only' | 'with'

/**
 * Ask before removing something `lines` Leitungen hang on (the exception in this module's
 * header): «`what` hat 2 Leitungen». No lines → 'only' at once, with no card. Null = Abbrechen
 * (or any dismissal). `group` names the Mehrfach group's own answer («Nur Auswahl»).
 */
export async function askJoinedLines(what: string, lines: number, group = false): Promise<JoinedAnswer | null> {
  if (lines <= 0) return 'only'
  const C = appConfig.copy.removedToast
  const answer = await confirmDialog({
    title: fillTemplate(lines === 1 ? C.joinedTitleOne : C.joinedTitle, { what, n: lines }),
    message: '',
    confirmLabel: group ? C.joinedOnlyGroup : C.joinedOnly,
    altLabel: C.joinedWith,
  })
  return answer === 'alt' ? 'with' : answer ? 'only' : null
}
