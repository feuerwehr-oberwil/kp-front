// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('./ui', () => ({ toast, confirmDialog: vi.fn() }))

import { useTeamMarkerActions } from './useTeamMarkerActions'
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
