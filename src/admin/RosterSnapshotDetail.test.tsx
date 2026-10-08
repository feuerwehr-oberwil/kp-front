// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The roster-snapshot row on System › Verbindungen is the only surface the feature has. What a
// person must be able to read off it at a glance, and do from it:
//   • a held run says how many people it would deactivate and that NOTHING changed;
//   • «Abgänge übernehmen» exists only while a run is held, asks first, and sends force=true;
//   • «Jetzt abrufen» never sends force — releasing the cap is never a side effect;
//   • a normal run reads as counts, the names it could not place are named, unknown ranks too.

const apiPost = vi.fn()
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, apiPost: (...args: unknown[]) => apiPost(...args) }
})

import { RosterSnapshotDetail, type RosterSnapshotCounts } from './RosterSnapshotDetail'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

const C = appConfig.copy.admin.system

afterEach(() => { cleanup(); apiPost.mockReset() })

const HELD: RosterSnapshotCounts = {
  held: true,
  activeBefore: 30,
  deactivationLimit: 6,
  pendingDeactivations: 10,
  outcome: { refused: 'held: …', unmatched: [{ display_name: 'Meier Anna', reason: 'absent_from_snapshot' }] },
}

describe('RosterSnapshotDetail', () => {
  it('a held run names the numbers and offers the release, which asks first and forces', async () => {
    apiPost.mockResolvedValue({})
    const reload = vi.fn()
    render(<RosterSnapshotDetail counts={HELD} onReload={reload} />)

    expect(screen.getByText(fillTemplate(C.snapHeldText, { n: 10, total: 30, limit: 6 }))).toBeTruthy()
    expect(screen.getByText(fillTemplate(C.snapHeldWho, { names: 'Meier Anna' }))).toBeTruthy() // who would go
    fireEvent.click(screen.getByRole('button', { name: C.snapRelease }))
    expect(apiPost).not.toHaveBeenCalled() // armed, not sent
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.admin.common.confirmYes }))
    await waitFor(() => expect(apiPost).toHaveBeenCalled())
    expect(apiPost.mock.calls[0][0]).toBe('/api/personnel/snapshot/sync')
    expect(apiPost.mock.calls[0][1]).toEqual({ force: true })
    await waitFor(() => expect(reload).toHaveBeenCalled())
  })

  it('«Jetzt abrufen» never forces, and there is no release while nothing is held', async () => {
    apiPost.mockResolvedValue({})
    render(<RosterSnapshotDetail counts={{ outcome: { created: 2, updated: 1, deactivated: 0 } }} onReload={vi.fn()} />)
    expect(screen.queryByRole('button', { name: C.snapRelease })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: C.snapRunNow }))
    await waitFor(() => expect(apiPost).toHaveBeenCalled())
    expect(apiPost.mock.calls[0][1]).toEqual({ force: false })
  })

  it('a normal run reads as counts, names who it could not place and the unknown ranks', () => {
    render(
      <RosterSnapshotDetail
        counts={{
          outcome: {
            created: 2,
            updated: 1,
            deactivated: 1,
            unknown_ranks: ['zgf'],
            unmatched: [
              { display_name: 'Meier Peter', reason: 'ambiguous_name' },
              { display_name: 'Alt Ehemals', reason: 'inactive_in_snapshot' },
            ],
          },
          lastGood: { generatedAt: '2026-10-08T04:00:00+00:00', count: 40 },
        }}
        onReload={vi.fn()}
      />,
    )
    expect(screen.getByText(fillTemplate(C.snapSummary, { created: 2, updated: 1, deactivated: 1 }))).toBeTruthy()
    // a former member the file lists as inactive is not a problem to report
    expect(screen.getByText(fillTemplate(C.snapUnmatched, { n: 1, names: 'Meier Peter' }))).toBeTruthy()
    expect(screen.getByText(fillTemplate(C.snapUnknownRanks, { ranks: 'zgf' }))).toBeTruthy()
  })
})
