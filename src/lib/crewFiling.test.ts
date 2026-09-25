import { describe, expect, it } from 'vitest'
import { derivedCrewGuestId, keepCrewFiled, stampCrewFiled, unfiledTruppCrew, unionCrewFiled } from './crewFiling'
import { mergeWorkspace } from './mergeWorkspace'
import type { AttendanceState, Trupp } from '../types'
import { appConfig } from '../config/appConfig'

const A = appConfig.copy.anwesenheit
const trupp = (over: Partial<Trupp>): Trupp => ({
  id: 't1', name: 'Muster Leo', entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'angemeldet', ...over,
})
const present = (name: string): AttendanceState[string] =>
  ({ status: 'present', displayNameSnapshot: name, intervals: [{ from: '2026-09-25T10:00:00Z' }] }) as unknown as AttendanceState[string]
const noRoster = () => undefined

describe('unfiledTruppCrew — what an editor device files for a Link-registered crew', () => {
  it('files two typed Gäste under ids every device derives the same way, leader with the GF note', () => {
    const [f] = unfiledTruppCrew([trupp({ members: ['Frei Nora'] })], {}, noRoster)
    expect(f.entries).toEqual([
      { id: derivedCrewGuestId('t1', 'Muster Leo'), name: 'Muster Leo', note: expect.stringContaining(A.roleAtemschutz) },
      { id: derivedCrewGuestId('t1', 'Frei Nora'), name: 'Frei Nora', note: A.roleAtemschutz },
    ])
    expect(f.groupTemplate).toBe(A.logRoleGroup)
    // …and the row id is the same on a second device that sees the same Trupp
    expect(unfiledTruppCrew([trupp({ members: ['Frei Nora'] })], {}, noRoster)[0].rowId).toBe(f.rowId)
  })

  it('marks a picked roster person present under their own id', () => {
    const [f] = unfiledTruppCrew([trupp({ leaderPersonId: 'p1' })], {}, noRoster)
    expect(f.entries).toEqual([expect.objectContaining({ id: 'p1', name: 'Muster Leo' })])
  })

  it('files nobody twice: already on the list by id, or by the same name (a Gast from an editor device) — marked, not filed', () => {
    const derived = derivedCrewGuestId('t1', 'Muster Leo')
    const [byId] = unfiledTruppCrew([trupp({ leaderPersonId: 'p1' })], { p1: present('Muster Leo') }, noRoster)
    expect(byId).toMatchObject({ entries: [], mark: ['p1'] })
    const [byName] = unfiledTruppCrew([trupp({})], { gX: present('Muster Leo') }, noRoster)
    expect(byName).toMatchObject({ entries: [], mark: [derived] })
    const [byDerived] = unfiledTruppCrew([trupp({})], { [derived]: present('Muster Leo') }, noRoster)
    expect(byDerived).toMatchObject({ entries: [], mark: [derived] })
  })

  it('is a one-shot per (Trupp, person): a key on crewFiled is never filed again, even when the entry is gone', () => {
    const derived = derivedCrewGuestId('t1', 'Muster Leo')
    expect(unfiledTruppCrew([trupp({ crewFiled: [derived] })], {}, noRoster)).toEqual([])
    expect(unfiledTruppCrew([trupp({ leaderPersonId: 'p1', crewFiled: ['p1'] })], {}, noRoster)).toEqual([])
    // …while a member added to the crew later IS filed — the marker is per person, not per Trupp
    const [f] = unfiledTruppCrew([trupp({ crewFiled: [derived], members: ['Frei Nora'] })], {}, noRoster)
    expect(f.entries.map((e) => e.name)).toEqual(['Frei Nora'])
    expect(f.mark).toEqual([derivedCrewGuestId('t1', 'Frei Nora')])
  })

  it('resolves a typed name to the roster, and leaves a Trupp taken off the board alone', () => {
    const [f] = unfiledTruppCrew([trupp({})], {}, (n) => (n === 'Muster Leo' ? 'p7' : undefined))
    expect(f.entries[0].id).toBe('p7')
    expect(unfiledTruppCrew([trupp({ removedAt: '2026-09-25T11:00:00Z' })], {}, noRoster)).toEqual([])
  })
})

/** What the editor device's observer does in one pass (IncidentWorkspace): file, stamp. */
const observe = (ws: { trupps: Trupp[]; attendance: AttendanceState }) => {
  const todo = unfiledTruppCrew(ws.trupps, ws.attendance, noRoster)
  const attendance = { ...ws.attendance }
  for (const f of todo) for (const e of f.entries) if (!attendance[e.id]) attendance[e.id] = present(e.name)
  return { trupps: stampCrewFiled(ws.trupps, todo), attendance }
}

describe('a crew member taken off the Anwesenheit stays off — on every device (no ghost refiling)', () => {
  const linkTrupp = trupp({ members: ['Frei Nora'] })
  const nora = derivedCrewGuestId('t1', 'Frei Nora')

  it('file → delete → merge from a second device → still deleted, and nobody files them again', () => {
    // device A observes the Link Trupp: files both, stamps the marker
    const filed = observe({ trupps: [linkTrupp], attendance: {} })
    expect(Object.keys(filed.attendance)).toContain(nora)
    expect(filed.trupps[0].crewFiled).toEqual(unionCrewFiled([derivedCrewGuestId('t1', 'Muster Leo'), nora]))
    // …a person on A takes Frei Nora off the list; that is what the server holds now
    const { [nora]: _gone, ...afterDelete } = filed.attendance
    const server = { trupps: filed.trupps, attendance: afterDelete }

    // device B had seen the filing (its base and its own state carry Nora) and saves an edit
    const bMine = { trupps: filed.trupps.map((t) => ({ ...t, ziel: 'Innenangriff' })), attendance: filed.attendance }
    const mergedB = mergeWorkspace(filed, bMine, server) as unknown as { trupps: Trupp[]; attendance: AttendanceState }
    expect(mergedB.attendance[nora]).toBeUndefined()
    // …and B's observer, running over the merged record, files nobody
    expect(unfiledTruppCrew(mergedB.trupps, mergedB.attendance, noRoster)).toEqual([])
    expect(observe(mergedB).attendance[nora]).toBeUndefined()

    // device C only ever saw the bare Link Trupp, then receives the server's record
    const cBase = { trupps: [linkTrupp], attendance: {} }
    const mergedC = mergeWorkspace(cBase, cBase, server) as unknown as { trupps: Trupp[]; attendance: AttendanceState }
    expect(observe(mergedC).attendance[nora]).toBeUndefined()
  })

  it('without the marker, the same observer would have written the deletion straight back (the trap this closes)', () => {
    const filed = observe({ trupps: [linkTrupp], attendance: {} })
    const { [nora]: _gone, ...afterDelete } = filed.attendance
    const unmarked = filed.trupps.map(({ crewFiled: _c, ...t }) => t as Trupp)
    expect(observe({ trupps: unmarked, attendance: afterDelete }).attendance[nora]).toBeDefined()
  })

  it('the marker merges as a union, and a divergence ONLY in it is no Trupp conflict', () => {
    const base = { trupps: [linkTrupp] }
    const mine = { trupps: [{ ...linkTrupp, crewFiled: ['a'] }] }
    const theirs = { trupps: [{ ...linkTrupp, crewFiled: ['b'] }] }
    const conflicts: unknown[] = []
    const merged = mergeWorkspace(base, mine, theirs, undefined, (c) => conflicts.push(c)) as unknown as { trupps: Trupp[] }
    expect(merged.trupps[0].crewFiled).toEqual(['a', 'b'])
    expect(conflicts).toEqual([])
    // grow-only: a side that dropped a key (an old snapshot) does not take it off
    const dropped = mergeWorkspace({ trupps: [{ ...linkTrupp, crewFiled: ['a'] }] }, { trupps: [{ ...linkTrupp, ziel: 'x' }] },
      { trupps: [{ ...linkTrupp, crewFiled: ['a'], status: 'aktiv' as const }] }) as unknown as { trupps: Trupp[] }
    expect(dropped.trupps[0].crewFiled).toEqual(['a'])
    // …and a real both-sides edit is still reported
    mergeWorkspace(base, { trupps: [{ ...linkTrupp, ziel: 'x', crewFiled: ['a'] }] }, { trupps: [{ ...linkTrupp, ziel: 'y' }] },
      undefined, (c) => conflicts.push(c))
    expect(conflicts).toHaveLength(1)
  })

  it('stamping writes nothing when nothing is new, and an undo restore keeps the live marker', () => {
    const ts = [trupp({ crewFiled: ['a'] })]
    expect(stampCrewFiled(ts, [{ truppId: 't1', groupTemplate: '', role: '', rowId: '', entries: [], mark: ['a'] }])).toBe(ts)
    expect(keepCrewFiled(trupp({ ziel: 'alt' }), trupp({ crewFiled: ['a'] }))).toMatchObject({ ziel: 'alt', crewFiled: ['a'] })
  })
})
