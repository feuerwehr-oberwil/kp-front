import { describe, expect, it } from 'vitest'
import type { IncidentMeta } from '../incidents'
import { appScreen, bootPlan, type ScreenState } from './home'

// The boot decision table (docs/karte-objekte.md · «Home»): every resume case lands where it did
// before variant B; only «nothing to resume» changed — home is Karte & Objekte for an account.
// Synthetic incidents only.

const NOW = Date.parse('2026-10-16T20:00:00Z')
const inc = (over: Partial<IncidentMeta>): IncidentMeta => ({
  id: 'i1', divera_id: null, title: 'Einsatz', type: null, priority: null, address: null, lat: null, lng: null,
  status: 'offen', source: 'manual', source_ref: null, auto_opened: false, is_exercise: false, report_done_at: null,
  started_at: '2026-10-16T18:00:00Z', closed_at: null, is_archived: false, workspace_rev: 0, created_by: null,
  created_at: '2026-10-16T18:00:00Z', updated_at: '2026-10-16T18:00:00Z', ...over,
})
const NO_CRASH = { now: NOW, crash: null }

describe('bootPlan — the resume rules are unchanged', () => {
  const remembered = inc({ id: 'mine', started_at: '2026-10-16T17:00:00Z' })
  const freshAlarm = inc({ id: 'alarm', source: 'divera', started_at: '2026-10-16T19:30:00Z' })
  const oldAlarm = inc({ id: 'old', source: 'divera', started_at: '2026-10-16T12:00:00Z' })

  const cases: { name: string; path?: string; list: IncidentMeta[]; prefs: Parameters<typeof bootPlan>[2]; want: string }[] = [
    { name: 'a fresh alarm-created Einsatz (< 3 h) wins over the remembered one', list: [remembered, freshAlarm], prefs: { incidentId: 'mine' }, want: 'open:alarm' },
    { name: 'the remembered one wins over an alarm older than the window', list: [remembered, oldAlarm], prefs: { incidentId: 'mine' }, want: 'open:mine' },
    { name: 'an alarm that existed when the operator chose by hand does not drag them back', list: [remembered, freshAlarm], prefs: { incidentId: 'mine', incidentChosenAt: Date.parse('2026-10-16T19:45:00Z') }, want: 'open:mine' },
    { name: 'nothing remembered: the first open Einsatz', list: [remembered], prefs: {}, want: 'open:mine' },
    { name: 'landed after an Abschluss: stays home', list: [remembered], prefs: { landedAt: Date.parse('2026-10-16T19:00:00Z') }, want: 'home' },
    { name: 'landed after an Abschluss: a fresh alarm since then still opens', list: [remembered, freshAlarm], prefs: { landedAt: Date.parse('2026-10-16T19:00:00Z') }, want: 'open:alarm' },
    { name: 'the remembered one is closed and nothing else is open: fetch it', list: [], prefs: { incidentId: 'gone', incidentChosenAt: Date.parse('2026-10-16T19:45:00Z') }, want: 'closed:gone' },
    { name: 'the remembered one is closed but another is open: the open one (first-open fallback, as before)', list: [freshAlarm], prefs: { incidentId: 'gone', incidentChosenAt: Date.parse('2026-10-16T19:45:00Z') }, want: 'open:alarm' },
    { name: 'no open Einsatz and nothing remembered: home', list: [], prefs: {}, want: 'home' },
    { name: 'a deep link into Karte & Objekte opens nothing behind it', path: '/karte', list: [remembered], prefs: { incidentId: 'mine' }, want: 'surface' },
    { name: '…nor one with an object selected', path: '/karte', list: [freshAlarm], prefs: {}, want: 'surface' },
    { name: 'a deep link into the Objektbesuche opens nothing behind it', path: '/besuche/neu', list: [remembered], prefs: { incidentId: 'mine' }, want: 'surface' },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const p = bootPlan(c.path ?? '/', c.list, c.prefs, NO_CRASH)
      const got = p.kind === 'open' ? `open:${p.incident.id}` : p.kind === 'closed' ? `closed:${p.id}` : p.kind
      expect(got).toBe(c.want)
    })
  }

  it('skips a crash-looping Einsatz — the escape never leads back into the crash', () => {
    const looping = { id: 'mine', n: 2, at: NOW - 1_000 }
    expect(bootPlan('/', [remembered], { incidentId: 'mine' }, { now: NOW, crash: looping }).kind).toBe('home')
    const other = inc({ id: 'other' })
    expect(bootPlan('/', [remembered, other], { incidentId: 'mine' }, { now: NOW, crash: looping })).toMatchObject({ kind: 'open', incident: { id: 'other' } })
  })
})

describe('appScreen — home is Karte & Objekte, for an account only', () => {
  const base: ScreenState = {
    linkSession: false, visitsShown: false, karteRoute: false, karteEntered: false, activeId: false, workspaceReady: false,
    listLoaded: true, bootDecided: true, bootOpening: false,
  }
  const at = (over: Partial<ScreenState>) => appScreen({ ...base, ...over })

  it('lands an account with nothing open on the viewer, where the launcher used to be', () => {
    expect(at({})).toBe('karte')
  })
  it('keeps the launcher card for a link session whose Einsatz could not be fetched', () => {
    expect(at({ linkSession: true })).toBe('launcher')
    expect(at({ linkSession: true, karteRoute: true, karteEntered: true })).toBe('launcher')
  })
  it('never shows home before the boot has decided (no flash before the Einsatz opens)', () => {
    expect(at({ listLoaded: false })).toBe('splash')
    expect(at({ bootDecided: false })).toBe('splash')
    expect(at({ bootOpening: true })).toBe('opening')
  })
  it('an open Einsatz is the Einsatz', () => {
    expect(at({ activeId: true, workspaceReady: true })).toBe('einsatz')
  })
  it('the Einsatz menu\'s row covers the open Einsatz with the viewer; a stale /karte entry does not', () => {
    expect(at({ activeId: true, workspaceReady: true, karteRoute: true, karteEntered: true })).toBe('karte')
    expect(at({ activeId: true, workspaceReady: true, karteRoute: true, karteEntered: false })).toBe('einsatz')
  })
  it('a deep link to /karte shows at once, before the list arrives', () => {
    expect(at({ karteRoute: true, karteEntered: true, listLoaded: false, bootDecided: false })).toBe('karte')
  })
  it('the Objektbesuche surface wins over everything', () => {
    expect(at({ visitsShown: true, karteRoute: true, karteEntered: true })).toBe('visits')
  })
})
