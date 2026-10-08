/*
 * *A NEW Trupp is led by its most senior member until somebody is crowned by hand* (30.09.2026,
 * `lib/truppLeader`): while «Trupp anmelden» is open and no name was tapped/held, every add or
 * removal puts the highest Dienstgrad (`lib/rank · rankOrder`) in front; ties and rankless crews
 * (Gäste) keep the order they were picked in. A tap on a name ends it for that form (kept with
 * the draft). An edit, a re-entry and the Mannschaft sheet never move the leader — a crew
 * somebody joins later keeps the one the radio knows. `TruppTeam · onChange` says which move it
 * made (`'add' | 'remove' | 'lead'`). The keyboard-up Trupp form buys back VERTICAL air only:
 * body, footer and blocked line keep the sheet's 20px side gutter.
 */

import type { CrewSlot } from './truppQuickEdit'

/**
 * Who leads a Trupp that is being FORMED (30.09.2026, owner: «auto-set the highest person rank wise
 * as group leader unless adding in people later»).
 *
 * The crew list is the record — `team[0]` IS the Gruppenführer (components/TruppTeam) — and until
 * now the first name picked took the crown, whoever it was. At the door the Lt is often the third
 * name called out, and the crown then had to be moved by hand on every Anmeldung. So while a NEW
 * Trupp is being put together and nobody has tapped a name to crown it, the crown follows the most
 * senior Dienstgrad in the crew (lib/rank · rankOrder); ties keep whoever was added first.
 *
 * ⚠️ It stops for good the moment the operator crowns somebody (a tap or a hold on a name): that is
 * an answer, and re-ranking over it would take it back. And it never runs on a Trupp that already
 * exists (edit, re-entry, the Mannschaft sheet) — a crew somebody joins later keeps the leader it
 * was registered with, who is the one the radio already knows.
 */

/** what just happened to the crew list — TruppTeam says which of its three moves it made */
export type CrewChange = 'add' | 'remove' | 'lead'

/**
 * The crew with its most senior member in front, everyone else in the order they stand.
 * `rankOf` is seniority, lower = more senior, `Infinity` for no rank (a Gast, a rankless roster
 * row). ⚠️ Only a STRICTLY more senior member takes the crown — ties keep the one in front, then
 * list order — so a crew with no ranks at all, or two Leutnants, leads exactly as it was picked.
 * Returns the same array when nothing moves.
 */
export function leaderByRank<T extends CrewSlot>(team: T[], rankOf: (slot: T) => number): T[] {
  let best = 0
  for (let i = 1; i < team.length; i++) if (rankOf(team[i]) < rankOf(team[best])) best = i
  return best === 0 ? team : [team[best], ...team.filter((_, i) => i !== best)]
}

/**
 * One crew change in the Trupp form, with the rule applied: while `auto` holds, the crown follows
 * the rank (on an add AND on a removal — the leader taken out hands it to the next most senior);
 * a `lead` is the operator's own pick and switches `auto` off. The form starts `auto` on a NEW
 * Trupp only (AtemschutzView · TruppForm).
 */
export function crewAfterChange<T extends CrewSlot>(
  next: T[], why: CrewChange, auto: boolean, rankOf: (slot: T) => number,
): { team: T[]; auto: boolean } {
  if (why === 'lead') return { team: next, auto: false }
  return { team: auto ? leaderByRank(next, rankOf) : next, auto }
}
