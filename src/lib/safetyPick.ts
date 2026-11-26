import { useEffect, useRef } from 'react'
import { appConfig } from '../config/appConfig'
import { safetyCandidates } from './atemschutz'
import type { MenuActionItem, MenuHeading, MenuSeparator } from './overlays/Menu'
import type { Trupp } from '../types'

// «Sicherungstrupp bestimmen» – ONE choice, wherever it is asked: the Notfall banner and the link
// page's «Anderer ⌄» (AtemschutzView · candidateMenu), and the «Kein Sicherungstrupp bereit» row's
// «Bestimmen» (components/SafetyMissingMeldung, owner pick UX journeys M·16, 25.11.2026).
//
// The row stands on every surface, but the acts live on the board: a crew turns «Sichern» there,
// and the form a crew that is out (fresh bottle) or a new Trupp needs is the board's. So the row's
// pick goes to whoever ANSWERS picks – the board, while it is mounted and may write
// (`useSafetyPickAnswer`). The row brings the board forward first; a pick made while no board
// answers waits for the one that mounts next, for PICK_WAIT_MS at most (a board that cannot write
// never takes it, and an old pick must not act minutes later). A module store, not a prop through
// IncidentWorkspace: the board mounts AFTER the row's tap switched to it.

/** what the pick asks of the board: `crew` – that crew on «Sichern», `new` – a Trupp registered
 *  on «Sichern». HOW a crew gets there (turned «Sichern», or the re-entry form for a crew that is
 *  out) the board decides from the crew as it stands when it answers: a pick can wait, and the
 *  crew can go out meanwhile (AtemschutzView · answerSafetyPick). */
export type SafetyPick = { kind: 'crew'; id: string } | { kind: 'new' }

const PICK_WAIT_MS = 10_000
let answer: ((p: SafetyPick) => void) | null = null
let pending: { pick: SafetyPick; at: number } | null = null

/** Hand a pick to the board – at once while one answers, else to the next one that mounts. */
export function requestSafetyPick(pick: SafetyPick): void {
  if (answer) answer(pick)
  else pending = { pick, at: Date.now() }
}

/** The board answers picks while `onPick` is set (absent: it may not write, or the Einsatz is
 *  closed) – and the one still waiting from the row's tap that brought it forward. */
export function useSafetyPickAnswer(onPick: ((p: SafetyPick) => void) | null): void {
  const ref = useRef(onPick)
  useEffect(() => { ref.current = onPick })
  const on = onPick != null
  useEffect(() => {
    if (!on) return
    const mine = (p: SafetyPick) => ref.current?.(p)
    answer = mine
    const waiting = pending
    pending = null
    if (waiting && Date.now() - waiting.at < PICK_WAIT_MS) mine(waiting.pick)
    return () => { if (answer === mine) answer = null }
  }, [on])
}

/**
 * The choice's rows: every other Atemschutz-Trupp, grouped under the phone board's heads –
 * Bereit, Drin, Draussen (lib/atemschutz · safetyCandidates, owner 30.10.2026 «Becomes
 * Sicherung») – then «Neuen Trupp anmelden (Sichern)». A crew is named in full, «Leiter / AdF».
 */
export function safetyPickItems(trupps: readonly Trupp[], pick: (p: SafetyPick) => void): (MenuActionItem | MenuHeading | MenuSeparator)[] {
  const az = appConfig.copy.atemschutz
  const c = safetyCandidates(trupps)
  const groups = [[az.phoneSectionReady, c.ready], [az.phoneSectionIn, c.inside], [az.phoneSectionOut, c.out]] as const
  return [
    ...groups.flatMap(([head, list]) => list.length === 0 ? [] : [
      { kind: 'head' as const, label: head },
      ...list.map((x) => ({
        label: [x.name, ...(x.members ?? [])].map((n) => n.trim()).filter(Boolean).join(' / '),
        onClick: () => pick({ kind: 'crew', id: x.id }),
      })),
    ]),
    { kind: 'sep' as const },
    { label: az.safetyPickNew, onClick: () => pick({ kind: 'new' }) },
  ]
}
