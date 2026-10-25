import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import type { Trupp, TruppFields } from '../../types'
import { createUndoTimeline } from '../undoTimeline'
import { truppActionCore } from './core'
import { truppLifecycleActions } from './lifecycle'

// The lifecycle family's stamps count in the DEPLOYMENT's time (lib/serverClock), like the clock
// family's: a device running ahead must not write its own clock into a Trupp's record. Here the
// device is ten minutes ahead of the server, so a stamp tells which clock wrote it.

const server = vi.hoisted(() => ({ now: '' }))
vi.mock('../serverClock', () => ({ serverNowIso: () => server.now }))
vi.mock('../ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('../ui')>(),
  toast: () => 0,
  undoToast: () => 0,
}))

const S0 = Date.parse('2026-07-06T10:00:00Z')
const serverAt = (min: number) => new Date(S0 + min * 60_000).toISOString()
/** server time moves to `min`; the device stays ten minutes ahead of it */
const tick = (min: number) => {
  server.now = serverAt(min)
  vi.setSystemTime(S0 + (min + 10) * 60_000)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  tick(0)
})
afterEach(() => { vi.useRealTimers() })

const trupp = (over: Partial<Trupp> = {}): Trupp => ({
  id: 'T1', name: 'Keller Anna', members: ['Frei Nina'], leaderPersonId: 'p1', memberPersonIds: ['p2'],
  entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'angemeldet', readings: [], ...over,
})
const fields = (t: Trupp, over: Partial<TruppFields> = {}): TruppFields => ({
  name: t.name, members: t.members, leaderPersonId: t.leaderPersonId, memberPersonIds: t.memberPersonIds,
  pressure: t.entryPressureBar, kind: t.kind, ...over,
})

/** the newest row of a Trupp's own log */
const last = (t: Trupp) => t.readings?.[t.readings.length - 1]

/** The lifecycle family over a plain Trupp list, placements stubbed out. `act()` rebuilds it on
 *  the CURRENT list, the way each render does. */
function board(trupps: Trupp[]) {
  const state = { trupps }
  const timeline = createUndoTimeline()
  const act = () => {
    const deps = {
      trupps: state.trupps,
      setTrupps: (a: SetStateAction<Trupp[]>) => { state.trupps = typeof a === 'function' ? a(state.trupps) : a },
      entities: [], board: {},
      log: () => {}, emit: () => {},
      undoTimeline: timeline,
      liveTrupps: () => state.trupps,
    }
    return truppLifecycleActions({
      ...deps, ...truppActionCore(deps),
      dropPlacements: () => {}, syncPlacementLabel: () => {}, recolorPlacement: () => {}, clearLineAnchor: () => {},
    })
  }
  const t = () => state.trupps[0]
  return { act, timeline, t }
}

describe('truppLifecycleActions — stamps in server time', () => {
  it('putting a Trupp under PA starts its contact clock and paOn row at server time', () => {
    const b = board([trupp({ kind: 'einfach', status: 'aktiv', entryTime: serverAt(0) })])
    tick(5)
    b.act().editTrupp('T1', fields(b.t(), { kind: 'atemschutz', pressure: 280 }))
    expect(b.t().lastContactTime).toBe(serverAt(5))
    expect(b.t().readings?.find((r) => r.kind === 'paOn')?.t).toBe(serverAt(5))
  })

  it('taking a Trupp off PA stamps the paOff row at server time', () => {
    const b = board([trupp({ status: 'aktiv', entryTime: serverAt(0), lastContactTime: serverAt(0) })])
    tick(5)
    b.act().editTrupp('T1', fields(b.t(), { kind: 'einfach' }))
    expect(b.t().readings?.find((r) => r.kind === 'paOff')?.t).toBe(serverAt(5))
  })

  it('a crew edited in the form gets its crew row at server time', () => {
    const b = board([trupp()])
    tick(5)
    b.act().editTrupp('T1', fields(b.t(), { members: ['Frei Nina', 'Huber Leo'] }))
    expect(last(b.t())).toMatchObject({ kind: 'crew', t: serverAt(5) })
  })

  it('a person moved to another Trupp leaves a crew row at server time', () => {
    const b = board([trupp()])
    tick(5)
    expect(b.act().transferOutOfTrupp('T1', 'p2', 'Huber Leo')).toBe(true)
    expect(last(b.t())).toMatchObject({ kind: 'crew', t: serverAt(5) })
  })

  it('undoing an Anmeldung stamps removedAt when it is undone, not when it was registered', () => {
    const b = board([])
    b.act().createTrupp(trupp())
    tick(5)
    b.timeline.undo()
    expect(b.t().removedAt).toBe(serverAt(5))
  })
})
