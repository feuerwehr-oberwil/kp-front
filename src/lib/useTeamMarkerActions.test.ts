// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('./ui', () => ({ toast, confirmDialog: vi.fn() }))
const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('./serverClock', () => ({ serverNow: () => clock.now, serverNowIso: () => new Date(clock.now).toISOString() }))

import { useTeamMarkerActions } from './useTeamMarkerActions'
import { formatTime } from './format'
import type { Doc } from './workspace'
import type { Entity } from '../types'

// A hand rename of a loose marker to a «Trupp N» somebody holds is refused where it happens —
// a duplicate one device could see coming is never left for a merge to settle
// (docs/trupp-naming.md §7, review of #228).
describe('useTeamMarkerActions · renameTeam', () => {
  afterEach(() => { vi.clearAllMocks() })
  const marker = { id: 'm1', kind: 'team', layer: 'ops', coord: [8, 46], label: 'Trupp 2' } as Entity
  const mount = (taken: (id: string, label: string) => boolean) => {
    const commit = vi.fn()
    const emit = vi.fn()
    const { result } = renderHook(() => useTeamMarkerActions({
      entities: [marker], commit, log: vi.fn(), emit, setSelectedId: vi.fn(), setSelectedDrawingId: vi.fn(),
      teamNameTaken: taken,
    }))
    return { rename: result.current.renameTeam, commit, emit }
  }

  it('refuses a number somebody holds, says so, and keeps the old name', () => {
    const taken = vi.fn(() => true)
    const { rename, commit, emit } = mount(taken)
    rename('m1', 'Trupp 1')
    expect(taken).toHaveBeenCalledWith('m1', 'Trupp 1')
    expect(commit).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][0]).toContain('Trupp 1')
  })

  it('renames to a free number or a word as before', () => {
    const { rename, commit } = mount(() => false)
    rename('m1', 'Angriff Nord')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(toast).not.toHaveBeenCalled()
  })
})

// A team marker's «seit hh:mm» and its marked trail dots count in the DEPLOYMENT's time
// (lib/serverClock), like the Trupp's own stamps (#489, #495): here the device runs ten minutes ahead.
describe('useTeamMarkerActions — marker time is server time', () => {
  const S0 = Date.parse('2026-07-06T10:00:00Z')
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(S0 + 10 * 60_000); clock.now = S0 })
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  const mount = (entities: Entity[]) => {
    let doc = { entities } as unknown as Doc
    const commit = vi.fn((u: (d: Doc) => Doc) => { doc = u(doc) })
    const { result } = renderHook(() => useTeamMarkerActions({
      entities, commit, log: vi.fn(), emit: vi.fn(), setSelectedId: vi.fn(), setSelectedDrawingId: vi.fn(),
    }))
    return { actions: result.current, doc: () => doc }
  }

  it('placing a team marker stamps the server clock', () => {
    const m = mount([])
    m.actions.placeGenericTeam([8, 46])
    expect(m.doc().entities[0].t).toBe(formatTime(new Date(S0)))
  })

  it('«Position markieren» stamps the marker and its dot with the server clock', () => {
    const m = mount([{ id: 'm1', kind: 'team', layer: 'ops', coord: [8, 46], label: 'Team 1', trail: [] } as Entity])
    m.actions.markTeamPosition('m1')
    const marker = m.doc().entities[0]
    expect(marker.t).toBe(formatTime(new Date(S0)))
    expect(marker.trail?.[0]?.t).toBe(formatTime(new Date(S0)))
  })
})
