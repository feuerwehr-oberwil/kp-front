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
import { isAtemschutzTrupp } from './atemschutz'
import type { AttendanceState, Trupp } from '../types'

/** The roles a conflict is checked for. `el` covers leading the Einsatz and reporting to the
 *  ELZ; `fahrer` covers driving / operating a vehicle. */
/**
 * `presence` is a job-less assignment: naming somebody here MARKS THEM PRESENT and nothing more.
 *
 * ⚠️ It exists because «Rückmeldung ELZ» was filed as `el`. Whoever phoned the Einsatzleitzentrale
 * is not thereby the Einsatzleiter — it is a call somebody made, not a function they hold — so
 * that field inherited the Einsatzleiter conflict check and announced «X ist Einsatzleiter und
 * zugleich im Trupp 2» about a Trupp member who had simply made the call. A warning that fires on
 * a normal, correct entry is the fastest way to teach an operator to ignore warnings.
 */
export type AssignableRole = 'el' | 'fahrer' | 'presence'

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
  /** the symbol's OTHER fields — an Offizier's job is written on the symbol as «Funktion», so
   *  the note that reaches the Anwesenheit has to be able to read it. */
  fields?: Record<string, string>,
): { role: AssignableRole; note?: string } {
  const A = appConfig.copy.anwesenheit
  if (key === 'Fahrer') {
    return { role: 'fahrer', note: fillTemplate(A.roleFahrer, { vehicle: label ?? '' }).trim() }
  }
  if (symbol === appConfig.symbols.einsatzleiterName) {
    if (key === 'Name') return { role: 'el', note: A.roleEinsatzleiter }
    if (key === 'Stv.') return { role: 'el', note: A.roleEinsatzleiterStv }
  }
  // ⚠️ An Offizier symbol carries a FUNKTION («SiBe», «Lüften», «Atemschutz»), and it used to
  // stop at the glyph: the named person was marked present with no Bemerkung, so the
  // Anwesenheitsliste — and the Personalblatt printed from it — could not say what any of the
  // officers actually did. The job is written right there on the symbol; this forwards it.
  if (symbol && (appConfig.symbols.officerRosterSymbols as readonly string[]).includes(symbol) && key === 'Name') {
    const fn = (fields?.Funktion ?? '').trim()
    // `presence`, not a leadership role: «Logistik» or «Lüften» contradicts nothing about being
    // in a Trupp, and a warning that fires on a correct entry teaches people to ignore warnings.
    return { role: 'presence', note: fn ? fillTemplate(A.roleOffizier, { funktion: fn }) : A.roleOffizierPlain }
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
  // a presence-only assignment contradicts nothing: it says somebody was here, which is exactly
  // what being in a Trupp or driving a vehicle already says
  if (role === 'presence') return undefined
  const A = appConfig.copy.anwesenheit
  const inTrupp = trupps.find((t) => t.status !== 'raus'
    && (t.leaderPersonId === personId || (t.memberPersonIds ?? []).includes(personId)))
  if (inTrupp) {
    // ⚠️ «unter AS» only when they actually are (03.09.): a Trupp without Atemschutz (types ·
    // TruppKind) carries no cylinder, and saying so about somebody in the Verkehrstrupp is a
    // false statement about where they were — on the surface that feeds the Personalblatt.
    const tpl = role === 'el' ? A.conflictElInTrupp
      : isAtemschutzTrupp(inTrupp) ? A.conflictUnderPa : A.conflictInTrupp
    return fillTemplate(tpl, { name, trupp: inTrupp.name })
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
  // same rule as roleConflictHint: only a PA Trupp earns «unter AS»
  if (inTrupp) return { label: isAtemschutzTrupp(inTrupp) ? A.statusUnderPa : A.statusInTrupp, tone: 'warn' }
  const e = attendance[personId]
  if (!e) return { label: A.statusFrei, tone: 'muted' }
  if (!isPresent(e)) return { label: A.statusLeft, tone: 'muted' }
  // present — so where they are standing, and then WHAT THEY ARE DOING
  if (ortOf(e) === 'station') return { label: A.ortStation, tone: 'info' }
  // ⚠️ The job they already hold, off their Anwesenheits-Bemerkung. It used to stop at the two
  // whereabouts above, so the symbol pickers — the «Fahrer» on a vehicle, the «Name» on the
  // Einsatzleiter glyph — were the only person lists in the app that could not say «this one is
  // already the Fahrer of the TLF». Same fact the Trupp form's picker has always shown; the
  // ordering is that picker's too (in einem Trupp → Magazin → Funktion → nicht anwesend).
  const note = (e.note ?? '').trim()
  return note ? { label: fillTemplate(A.alreadyBooked, { role: note }), tone: 'info' } : undefined
}


/**
 * The crew names on a Trupp that the ID path did NOT record — the ones still owed an Anwesenheit.
 *
 * ⚠️ Why it exists (field report 02.09.): the Trupp form takes a person from the picker OR a
 * hand-typed name («Name eingeben (Gast/Nachbarwehr)»), and only the first kind leaves a
 * `leaderPersonId`/`memberPersonIds` entry. Marking the crew present off those ids alone therefore
 * skipped every Gast: somebody who was under Atemschutz for the whole Einsatz was missing from the
 * Anwesenheit, from the headcount and from the Personalblatt printed off it.
 *
 * `resolve` is the roster lookup (lib/personnel · personIdForName over the pickable list, guests
 * included), so a name that IS somebody already recorded resolves to them instead of opening a
 * second row — and a name whose id the Trupp already carries is dropped, because the grouped id
 * path above has just handled it. Deduplicated by name: the same person typed into two slots is
 * one person.
 */
export function unrecordedCrewNames(
  trupp: { name?: string; members?: string[]; leaderPersonId?: string; memberPersonIds?: string[] },
  resolve: (name: string) => string | undefined,
): string[] {
  const covered = new Set([trupp.leaderPersonId, ...(trupp.memberPersonIds ?? [])].filter(Boolean) as string[])
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of [trupp.name, ...(trupp.members ?? [])]) {
    const name = (raw ?? '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const known = resolve(name)
    if (known && covered.has(known)) continue
    out.push(name)
  }
  return out
}


/**
 * The Bemerkung a person should carry after being given another job.
 *
 * One person routinely holds two: the Fahrer who then goes under Atemschutz is «Fahrer Pio, AS»,
 * and the Anwesenheitsliste has to say both — it is the sheet somebody reads to answer «wer war
 * wo». Filling only an EMPTY note (the old rule) meant whichever job was recorded first silently
 * swallowed every later one.
 *
 * ⚠️ A new part REPLACES an existing part with the same leading word, and is otherwise appended.
 * That is what keeps a correction a correction: «Offizier SiBe» re-filed as «Offizier Atemschutz»
 * is the same field saying something new, not a second job — while «AS» beside «Fahrer Pio» is
 * genuinely a second one. Hand-typed text has no such collision and is never touched.
 *
 * ⚠️ …and two notes can be the same JOB while sharing no leading word. «Einsatzleiter» and «Stv.
 * Einsatzleiter» are one slot on one symbol — handing the Einsatz over (the ⇄ on the Einsatzleiter
 * glyph, or simply moving a name from one field to the other) would otherwise leave the person who
 * stepped back reading «Einsatzleiter, Stv. Einsatzleiter»: an Anwesenheitsliste claiming somebody
 * is both, on the one row a Rapport quotes.
 */
const sameSlot = (a: string, b: string): boolean => {
  const A = appConfig.copy.anwesenheit
  const pair = [A.roleEinsatzleiter.toLowerCase(), A.roleEinsatzleiterStv.toLowerCase()]
  const [x, y] = [a.trim().toLowerCase(), b.trim().toLowerCase()]
  return pair.includes(x) && pair.includes(y)
}

export function mergeRoleNote(existing: string | undefined, add: string): string {
  const next = add.trim()
  if (!next) return (existing ?? '').trim()
  const parts = (existing ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  const lead = (p: string) => p.split(/\s+/)[0].toLowerCase()
  // already said, in exactly these words — nothing to do
  if (parts.some((p) => p.toLowerCase() === next.toLowerCase())) return parts.join(', ')
  const kept = parts.filter((p) => lead(p) !== lead(next) && !sameSlot(p, next))
  return [...kept, next].join(', ')
}
