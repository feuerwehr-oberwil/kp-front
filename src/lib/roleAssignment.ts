// Handing somebody a job on this Einsatz — Einsatzleiter, Fahrer, a place in a Trupp — says two
// things the record has to learn: that person is HERE, and this is what they are doing. Both used
// to stop at the object the role lives on (the Trupp, the map symbol, reportMeta), so the
// Anwesenheit list and the Soldblatt never heard about it and the operator entered the same
// person twice.
//
// This module is the pure half: what does a role assignment CONTRADICT? The writing half
// (opening a presence block, filling the Bemerkung) needs the workspace's setters and stays in
// IncidentWorkspace.
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { intervalsOf, isPresent } from './attendanceIntervals'
import type { AttendanceState, Trupp } from '../types'

/** The roles a conflict is checked for. `el` covers leading the Einsatz and reporting to the
 *  ELZ; `fahrer` covers driving / operating a vehicle. */
export type AssignableRole = 'el' | 'fahrer'

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
