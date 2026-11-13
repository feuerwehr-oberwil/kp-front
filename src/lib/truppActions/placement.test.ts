import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardAnno, Entity, Trupp } from '../../types'
import type { Doc } from '../workspace'
import { formatTime } from '../format'
import { truppPlacementActions } from './placement'
import { confirmDialog } from '../ui'
import type { TacticalObject } from '../tacticalObjects'

// The placement family's chip/marker time («seit hh:mm» on the plan chip and the Lage marker)
// counts in the DEPLOYMENT's time (lib/serverClock), like the clock and lifecycle families: a
// device running ahead must not print its own clock onto a Trupp. Here the device is ten minutes
// ahead of the server.

const server = vi.hoisted(() => ({ now: '' }))
vi.mock('../serverClock', () => ({ serverNowIso: () => server.now }))
vi.mock('../ui', () => ({ confirmDialog: vi.fn(async () => false) }))

const S0 = Date.parse('2026-07-06T10:00:00Z')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  server.now = new Date(S0).toISOString()
  vi.setSystemTime(S0 + 10 * 60_000)
})
afterEach(() => { vi.useRealTimers() })

const trupp: Trupp = { id: 'T1', name: 'Keller Anna', entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'aktiv' }

function placement(trupps: Trupp[] = [trupp], objects: TacticalObject[] = []) {
  let board: Record<string, BoardAnno[]> = {}
  let doc = { entities: [] as Entity[], drawings: [] } as unknown as Doc
  const actions = truppPlacementActions({
    trupps, drawings: [], objects, board, building: null,
    setBoard: (u) => { board = typeof u === 'function' ? u(board) : u },
    setDocRaw: (u) => { doc = typeof u === 'function' ? u(doc) : u },
    log: vi.fn(), logPlan: vi.fn(), emit: vi.fn(), setMode: vi.fn(), setActivePlanId: vi.fn(), setPanel: vi.fn(),
    setPlanFocus: vi.fn(), mapCenter: () => [7.5, 47.5], focusMapEntity: vi.fn(), updateTrupp: vi.fn(),
    teamColor: () => '#f00', setTruppStatus: vi.fn(), linkTruppLine: vi.fn(() => true), unlinkTruppLine: vi.fn(),
  })
  return { actions, board: () => board, doc: () => doc }
}

describe('placement — the chip/marker time is server time', () => {
  const serverHHMM = () => formatTime(new Date(S0))

  it('placeTruppOnPlan stamps the chip with the server clock', () => {
    const p = placement()
    const annoId = p.actions.placeTruppOnPlan('T1', 'modul6', { x: 0.5, y: 0.5, floor: 0 })
    expect(p.board().modul6.find((a) => a.id === annoId)?.t).toBe(serverHHMM())
  })

  it('placeTruppOnMap stamps the marker with the server clock', () => {
    const p = placement()
    const entityId = p.actions.placeTruppOnMap('T1', [7.5, 47.5])
    expect(p.doc().entities.find((e) => e.id === entityId)?.t).toBe(serverHHMM())
  })
})

// A marker another Trupp holds asks first, and the button answers the question with WHO takes it
// («Für Trupp {to} übernehmen», WORD.8) – not a bare «Übernehmen».
describe('adoptTruppMarker — the takeover confirm names the new Trupp', () => {
  it('fills {to} with the adopting Trupp and writes nothing on cancel', async () => {
    const holder: Trupp = { ...trupp, id: 'T2', name: 'Graf Jonas', entityId: 'e1' }
    const marker = { id: 'e1', entity: { id: 'e1', kind: 'team' } } as unknown as TacticalObject
    const p = placement([trupp, holder], [marker])
    expect(await p.actions.adoptTruppMarker('T1', 'e1')).toBe(false)
    expect(vi.mocked(confirmDialog)).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Für Trupp Keller Anna übernehmen' }))
  })
})
