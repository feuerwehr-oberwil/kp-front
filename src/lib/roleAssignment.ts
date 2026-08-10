// Handing somebody a job on this Einsatz — Einsatzleiter, Fahrer, a place in a Trupp — says two
// things the record has to learn: that person is HERE, and this is what they are doing. Both used
// to stop at the object the role lives on (the Trupp, the map symbol, reportMeta), so the
// Anwesenheit list and the Soldblatt never heard about it and the operator entered the same
// person twice.
//
// This module is the pure half: what job does a roster field hand out, and what does that
// assignment CONTRADICT in what is already recorded? The writing half
// (opening a presence block, filling the Bemerkung) needs the workspace's setters and stays in
// IncidentWorkspace.
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { intervalsOf, isPresent } from './attendanceIntervals'
import { ortOf } from './attendanceOrt'
import type { AttendanceState, Trupp } from '../types'

/** The roles a conflict is checked for. `el` covers leading the Einsatz and reporting to the
 *  ELZ; `fahrer` covers driving / operating a vehicle. */
export type AssignableRole = 'el' | 'fahrer'

/**
 * What a name typed into a symbol's roster field MEANS — the job, and the Bemerkung it writes
 * onto that person's Anwesenheit row. Pure, so the mapping is testable without the workspace.
 *
 * Three fields carry a person (`appConfig.symbols.rosterFields`) and they are not the same job:
 *   · «Fahrer» on any vehicle → «Fahrer TLF» (the vehicle is the symbol's own label)
 *   · «Name» on the Einsatzleiter glyph → «Einsatzleiter»
 *   · «Stv.» on the same glyph → «Stv. Einsatzleiter» — the deputy used to be put on the list
 *     with no Bemerkung at all, so the one row that says WHY they are on it stayed empty.
 * Anything else (a «Name» on some other symbol) still marks the person present — being named
 * on the board means being there — but has no job to write.
 */
export function rosterFieldRole(
  symbol: string | undefined,
  key: string,
  label: string | undefined,
): { role: AssignableRole; note?: string } {
  const A = appConfig.copy.anwesenheit
  if (key === 'Fahrer') {
    return { role: 'fahrer', note: fillTemplate(A.roleFahrer, { vehicle: label ?? '' }).trim() }
  }
  if (symbol === appConfig.symbols.einsatzleiterName) {
    if (key === 'Name') return { role: 'el', note: A.roleEinsatzleiter }
    if (key === 'Stv.') return { role: 'el', note: A.roleEinsatzleiterStv }
  }
  return { role: 'fahrer' }
}

/**
 * The hint a role assignment earns when it contradicts something already recorded — or nothing,
 * which is the normal case.
 *
 * NEVER blocking. At 3am the app does not get to refuse what the operator says happened: it says
 * what it knows and lets them decide. The three it knows about:
 *   · under PA and driving at the same time — one person in two places
 *   · the Einsatzleiter going in with a Trupp — then nobody is leading the Einsatz
 *   · somebody recorded as «gegangen» taking on a job — one of the two entries is wrong
 */
export function roleConflictHint(
  personId: string | undefined,
  role: AssignableRole,
  name: string,
  attendance: AttendanceState,
  trupps: Trupp[],
): string | undefined {
  if (!personId) return undefined
  const A = appConfig.copy.anwesenheit
  const inTrupp = trupps.find((t) => t.status !== 'raus'
    && (t.leaderPersonId === personId || (t.memberPersonIds ?? []).includes(personId)))
  if (inTrupp) {
    return fillTemplate(role === 'el' ? A.conflictElInTrupp : A.conflictUnderPa, { name, trupp: inTrupp.name })
  }
  // «gegangen» = a closed block exists and none is open. Somebody who was never recorded at all
  // is not a contradiction — that is precisely the person this assignment is about to add.
  const e = attendance[personId]
  if (e && !isPresent(e) && intervalsOf(e).length > 0) return fillTemplate(A.conflictLeft, { name })
  return undefined
}


/**
 * What is already known about one person, for the entry that offers them.
 *
 * The same three facts `roleConflictHint` warns about — under PA, gone home — plus where they
 * are. ⚠️ Shown ON the option rather than after the pick: a toast says «Brunner Thomas ist
 * unter AS» once, three seconds after the operator already chose him, and then it is gone. The
 * list is where the decision is made, so the list is where the fact belongs.
 *
 * Never a block. Somebody under PA CAN be the Fahrer on paper — it usually means one of the two
 * entries is wrong, and which one is the operator's call, not the app's.
 */
export function personStatusHint(
  personId: string | undefined,
  attendance: AttendanceState,
  trupps: Trupp[],
): { label: string; tone?: 'warn' | 'muted' | 'info' } | undefined {
  if (!personId) return undefined
  const A = appConfig.copy.anwesenheit
  const inTrupp = trupps.find((t) => t.status !== 'raus'
    && (t.leaderPersonId === personId || (t.memberPersonIds ?? []).includes(personId)))
  if (inTrupp) return { label: A.statusUnderPa, tone: 'warn' }
  const e = attendance[personId]
  if (!e) return { label: A.legendFrei, tone: 'muted' }
  if (!isPresent(e)) return { label: A.legendLeft, tone: 'muted' }
  // present — and the one thing worth saying about a present person is where they are standing
  return ortOf(e) === 'station' ? { label: A.ortStation, tone: 'info' } : undefined
}
