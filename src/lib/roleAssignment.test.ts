import { describe, expect, it } from 'vitest'
import type { AttendanceState, Trupp } from '../types'
import { appConfig } from '../config/appConfig'
import { mergeRoleNote, personStatusHint, roleConflictHint, rosterFieldRole, truppRoleNote, unrecordedCrewNames } from './roleAssignment'

const trupp = (over: Partial<Trupp>): Trupp => ({
  id: 't1', name: 'Trupp 2', entryPressureBar: 300, entryTime: '', lastContactTime: '',
  status: 'aktiv', ...over,
})

const present: AttendanceState = {
  p1: { status: 'present', displayNameSnapshot: 'Schmid Peter', intervals: [{ from: '2026-06-23T09:00:00' }] },
}
const left: AttendanceState = {
  p1: {
    status: 'left', displayNameSnapshot: 'Schmid Peter',
    intervals: [{ from: '2026-06-23T09:00:00', to: '2026-06-23T10:00:00' }],
  },
}

describe('roleConflictHint', () => {
  it('says nothing when there is nothing to say', () => {
    expect(roleConflictHint('p1', 'fahrer', 'Schmid Peter', present, [])).toBeUndefined()
    // never recorded at all is not a contradiction — that is the person being added
    expect(roleConflictHint('p1', 'el', 'Schmid Peter', {}, [])).toBeUndefined()
    expect(roleConflictHint(undefined, 'el', '', {}, [])).toBeUndefined()
  })

  it('flags a Fahrer who is under AS — one person in two places', () => {
    const hint = roleConflictHint('p1', 'fahrer', 'Schmid Peter', present, [trupp({ memberPersonIds: ['p1'] })])
    expect(hint).toContain('Schmid Peter')
    expect(hint).toContain('AS')
    expect(hint).toContain('Trupp 2')
  })

  /* ⚠️ «unter AS» only when they actually are (03.09.). A Trupp without Atemschutz (types ·
   * TruppKind) carries no cylinder — and this hint feeds the surface the Personalblatt is built
   * from, so «unter AS» about the Verkehrstrupp is a false statement about where somebody was. */
  it('says «im Trupp», not «unter AS», for a Trupp without Atemschutz', () => {
    const plain = [trupp({ kind: 'einfach', name: 'Verkehr', memberPersonIds: ['p1'] })]
    const hint = roleConflictHint('p1', 'fahrer', 'Schmid Peter', present, plain)
    expect(hint).toContain('Verkehr')
    expect(hint).not.toContain('AS')
    expect(personStatusHint('p1', present, plain)).toMatchObject({ label: appConfig.copy.anwesenheit.statusInTrupp })
    // …and the PA Trupp beside it still says so
    expect(personStatusHint('p1', present, [trupp({ memberPersonIds: ['p1'] })]))
      .toMatchObject({ label: appConfig.copy.anwesenheit.statusUnderPa })
  })

  it('flags the Einsatzleiter going in with a Trupp — then nobody is leading', () => {
    const hint = roleConflictHint('p1', 'el', 'Schmid Peter', present, [trupp({ leaderPersonId: 'p1' })])
    expect(hint).toContain('Einsatzleiter')
    expect(hint).toContain('Trupp 2')
  })

  it('ignores a Trupp that is already out — that job is over', () => {
    const out = [trupp({ status: 'raus', memberPersonIds: ['p1'] })]
    expect(roleConflictHint('p1', 'fahrer', 'Schmid Peter', present, out)).toBeUndefined()
  })

  it('flags somebody recorded as «gegangen» — one of the two entries is wrong', () => {
    const hint = roleConflictHint('p1', 'fahrer', 'Schmid Peter', left, [])
    expect(hint).toContain('gegangen')
  })

  it('prefers the Trupp conflict over the departure — the Trupp is the sharper one', () => {
    const hint = roleConflictHint('p1', 'fahrer', 'Schmid Peter', left, [trupp({ memberPersonIds: ['p1'] })])
    expect(hint).toContain('Trupp 2')
  })
})

describe('rosterFieldRole', () => {
  it('names the vehicle a Fahrer drives', () => {
    expect(rosterFieldRole('VKF Fahrzeug', 'Fahrer', 'TLF 1')).toEqual({ role: 'fahrer', note: 'Fahrer TLF 1' })
  })

  it('an unnamed vehicle still says «Fahrer», with nothing trailing it', () => {
    expect(rosterFieldRole('VKF Fahrzeug', 'Fahrer', undefined)).toEqual({ role: 'fahrer', note: 'Fahrer' })
  })

  it('the Einsatzleiter glyph writes the function — Name leads, Stv. deputises', () => {
    expect(rosterFieldRole('VKF Einsatzleiter', 'Name', undefined)).toEqual({ role: 'el', note: 'Einsatzleiter' })
    // the deputy used to land on the Anwesenheit list with an empty Bemerkung
    expect(rosterFieldRole('VKF Einsatzleiter', 'Stv.', undefined)).toEqual({ role: 'el', note: 'Stv. Einsatzleiter' })
  })

  it('a «Name» on any other symbol marks the person present without inventing a job', () => {
    expect(rosterFieldRole('VKF Drehleiter', 'Name', 'ADL')).toEqual({ role: 'fahrer' })
  })
})

// «Rückmeldung ELZ» was filed as `el`, so naming the Trupp member who made the call announced
// «X ist Einsatzleiter und zugleich im Trupp 2». A warning that fires on a correct entry is the
// fastest way to teach an operator to ignore warnings.
describe('presence-only assignments contradict nothing', () => {
  it('stays silent for somebody in a Trupp', () => {
    const trupps = [{ id: 'T1', name: 'Trupp 2', entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'aktiv' as const, memberPersonIds: ['p1'] }]
    expect(roleConflictHint('p1', 'presence', 'Meier Anna', {}, trupps)).toBeUndefined()
    // …while the real Einsatzleiter assignment still says so
    expect(roleConflictHint('p1', 'el', 'Meier Anna', {}, trupps)).toBeTruthy()
  })

  it('stays silent for somebody recorded as gegangen', () => {
    const att = { p1: { status: 'left' as const, displayNameSnapshot: 'Meier Anna', intervals: [{ from: '2026-08-10T10:00:00Z', to: '2026-08-10T11:00:00Z' }] } }
    expect(roleConflictHint('p1', 'presence', 'Meier Anna', att, [])).toBeUndefined()
    expect(roleConflictHint('p1', 'fahrer', 'Meier Anna', att, [])).toBeTruthy()
  })
})

// An Offizier symbol carries a FUNKTION («SiBe», «Lüften», «Atemschutz») and it used to stop at
// the glyph: the person was marked present with no Bemerkung, so neither the Anwesenheitsliste
// nor the Personalblatt printed from it could say what any of the officers actually did.
describe('an Offizier symbol forwards its Funktion to the person', () => {
  it('writes the Funktion as the Bemerkung', () => {
    expect(rosterFieldRole('FW Offizier', 'Name', undefined, { Funktion: 'SiBe', Name: 'Meier Anna' }))
      .toEqual({ role: 'presence', note: 'Offizier SiBe' })
  })

  it('falls back to the plain word when no Funktion was chosen', () => {
    expect(rosterFieldRole('FW Offizier', 'Name', undefined, { Name: 'Meier Anna' }))
      .toEqual({ role: 'presence', note: 'Offizier' })
    expect(rosterFieldRole('FW Offizier', 'Name', undefined, { Funktion: '  ', Name: 'x' }).note).toBe('Offizier')
  })

  it('is presence-only — «Logistik» contradicts nothing about being in a Trupp', () => {
    const trupps = [{ id: 'T1', name: 'Trupp 2', entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'aktiv' as const, memberPersonIds: ['p1'] }]
    const { role } = rosterFieldRole('FW Offizier', 'Name', undefined, { Funktion: 'Logistik' })
    expect(roleConflictHint('p1', role, 'Meier Anna', {}, trupps)).toBeUndefined()
  })

  it('leaves the Einsatzleiter glyph exactly as it was — that one IS a leadership role', () => {
    expect(rosterFieldRole('VKF Einsatzleiter', 'Name', undefined, { Funktion: 'SiBe' }))
      .toEqual({ role: 'el', note: 'Einsatzleiter' })
  })
})

// One person routinely holds two jobs. Filling only an EMPTY note meant whichever was recorded
// first silently swallowed every later one — the Fahrer who then went under Atemschutz stayed
// «Fahrer Pio» on the sheet somebody reads to answer «wer war wo».
describe('mergeRoleNote', () => {
  it('joins a second, different job', () => {
    expect(mergeRoleNote('Fahrer Pio', 'AS')).toBe('Fahrer Pio, AS')
    expect(mergeRoleNote('AS', 'Fahrer Pio')).toBe('AS, Fahrer Pio')
  })

  it('says nothing twice', () => {
    expect(mergeRoleNote('Fahrer Pio, AS', 'AS')).toBe('Fahrer Pio, AS')
    expect(mergeRoleNote('AS', 'as')).toBe('AS')
  })

  it('⚠️ REPLACES a part with the same leading word — a correction is not a second job', () => {
    expect(mergeRoleNote('Offizier SiBe', 'Offizier Atemschutz')).toBe('Offizier Atemschutz')
    expect(mergeRoleNote('Fahrer Pio, AS', 'Fahrer MoWa')).toBe('AS, Fahrer MoWa')
  })

  it('never touches what somebody typed by hand', () => {
    expect(mergeRoleNote('abgelöst 21:40', 'AS')).toBe('abgelöst 21:40, AS')
  })

  // ⚠️ Handing the Einsatz over: the two notes share no leading word but are ONE slot on one
  // symbol, so joining them would put «Einsatzleiter, Stv. Einsatzleiter» on a single row.
  it('⚠️ EL and Stv. EL replace each other — nobody is both', () => {
    expect(mergeRoleNote('Einsatzleiter', 'Stv. Einsatzleiter')).toBe('Stv. Einsatzleiter')
    expect(mergeRoleNote('Stv. Einsatzleiter', 'Einsatzleiter')).toBe('Einsatzleiter')
    // …and the rest of the row survives the swap
    expect(mergeRoleNote('Fahrer TLF, Einsatzleiter', 'Stv. Einsatzleiter')).toBe('Fahrer TLF, Stv. Einsatzleiter')
  })

  /* ⚠️ …and so do «AS» and «Trupp» (04.09.): a place in a Trupp is ONE job, and its Art can be
   * changed after the fact (useTruppActions · editTrupp · kindPatch). Joined, the crew of a
   * Verkehrstrupp that later went under PA would read «Trupp, AS». */
  it('⚠️ AS and Trupp replace each other — one place in one team', () => {
    expect(mergeRoleNote('Trupp', 'AS')).toBe('AS')
    expect(mergeRoleNote('AS', 'Trupp')).toBe('Trupp')
    expect(mergeRoleNote('Fahrer TLF, Trupp', 'AS')).toBe('Fahrer TLF, AS')
  })

  it('handles the empty cases', () => {
    expect(mergeRoleNote(undefined, 'AS')).toBe('AS')
    expect(mergeRoleNote('  ', 'AS')).toBe('AS')
    expect(mergeRoleNote('Fahrer Pio', '  ')).toBe('Fahrer Pio')
  })
})


// Shown ON the option, before the pick. ⚠️ The symbol pickers («Fahrer» on a vehicle, «Name» on
// the Einsatzleiter glyph) read this and nothing else, so whatever it omits, those dropdowns
// cannot say — which is why the job belongs in it.
describe('personStatusHint', () => {
  const A = appConfig.copy.anwesenheit

  it('names the job a present person already holds', () => {
    const st: AttendanceState = { ...present, p1: { ...present.p1, note: 'Fahrer TLF' } }
    expect(personStatusHint('p1', st, [])).toMatchObject({ label: 'Fahrer TLF' })
  })

  it('says nothing about a present person with no job — the ordinary case stays quiet', () => {
    expect(personStatusHint('p1', present, [])).toBeUndefined()
  })

  it('under PA outranks the job: one person cannot be in two places', () => {
    const st: AttendanceState = { ...present, p1: { ...present.p1, note: 'Fahrer TLF' } }
    const t = trupp({ leaderPersonId: 'p1' })
    expect(personStatusHint('p1', st, [t])).toMatchObject({ label: A.statusUnderPa, tone: 'warn' })
  })

  it('…and so does where they are standing', () => {
    const st: AttendanceState = { ...present, p1: { ...present.p1, note: 'Fahrer TLF', ort: 'station' } }
    expect(personStatusHint('p1', st, [])).toMatchObject({ label: A.ortStation })
  })

  it('somebody who has gone home is still the more important fact', () => {
    const st: AttendanceState = { ...left, p1: { ...left.p1, note: 'Fahrer TLF' } }
    expect(personStatusHint('p1', st, [])).toMatchObject({ label: A.statusLeft })
  })
})

/* ⚠️ Field report 04.09.: «Trupp Brunner Thomas (AS) / Müller Hans (AS) / Schmid Peter (AS)
 * angemeldet» — about a Trupp OHNE Atemschutz. The «(AS)» is that person's Anwesenheits-Funktion,
 * printed behind their name by the Verlauf (lib/journalLinks), and it was written for every kind
 * of Trupp alike. */
describe('truppRoleNote (what a place in a Trupp writes onto the Anwesenheit)', () => {
  const A = appConfig.copy.anwesenheit

  it('files a Trupp ohne Atemschutz as «Trupp», on its own crew line', () => {
    expect(truppRoleNote({ kind: 'einfach' })).toEqual({ role: A.roleTrupp, groupTemplate: A.logRoleGroupTrupp })
  })

  it('keeps «AS» for a Trupp under Atemschutz — absent kind included (types · TruppKind)', () => {
    const pa = { role: A.roleAtemschutz, groupTemplate: A.logRoleGroup }
    expect(truppRoleNote({ kind: 'atemschutz' })).toEqual(pa)
    expect(truppRoleNote({})).toEqual(pa)
  })
})

// ⚠️ Field report 02.09.: a Gast («Bobo DJ») entered through the Trupp form's «Name eingeben
// (Gast/Nachbarwehr)» was under Atemschutz for the whole Einsatz and appeared on no printed
// Anwesenheit at all — the crew was marked present off the person IDS, and a typed name has none.
describe('unrecordedCrewNames (who a Trupp still owes an Anwesenheit)', () => {
  const roster: Record<string, string> = { 'Meier Anna': 'p1', 'Müller Hans': 'p2' }
  const resolve = (n: string) => roster[n]

  it('returns the hand-typed Gast and nobody else', () => {
    expect(unrecordedCrewNames(
      { name: 'Bobo DJ', members: ['Meier Anna'], memberPersonIds: ['p1'] },
      resolve,
    )).toEqual(['Bobo DJ'])
  })

  it('says nothing when every slot was picked from the roster', () => {
    expect(unrecordedCrewNames(
      { name: 'Müller Hans', members: ['Meier Anna'], leaderPersonId: 'p2', memberPersonIds: ['p1'] },
      resolve,
    )).toEqual([])
  })

  // …the picker was bypassed but the name IS somebody on the list: they get their own row through
  // the normal path rather than a second, guest-shaped one
  it('returns a roster name the Trupp carries no id for', () => {
    expect(unrecordedCrewNames({ name: 'Meier Anna' }, resolve)).toEqual(['Meier Anna'])
  })

  it('counts the same name typed into two slots once', () => {
    expect(unrecordedCrewNames({ name: 'Bobo DJ', members: ['Bobo DJ', '  '] }, resolve)).toEqual(['Bobo DJ'])
  })
})
