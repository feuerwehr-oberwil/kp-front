// @vitest-environment jsdom
/**
 * The selected Trupp pill and its join sheet — the ONE copy every surface renders. What is pinned
 * here is what the sheet offers and what it calls; the surfaces' own wiring is covered by the
 * Whiteboard / MapMarkers tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { appConfig } from '../config/appConfig'
import type { Trupp } from '../types'
import { TwinTeamPill } from './TwinTeamPill'

afterEach(cleanup)

const A = appConfig.copy.atemschutz
const TRUPPS: Trupp[] = [
  { id: 't1', no: 2, name: 'Meier Anna', status: 'aktiv', members: [], readings: [] } as unknown as Trupp,
]

describe('the join sheet of a loose Trupp marker', () => {
  it('offers «Neuer Trupp» last, and it asks the surface to register one for THIS marker', () => {
    const newTrupp = vi.fn()
    const pick = vi.fn()
    render(<TwinTeamPill name="Trupp 3" color="#c00" raus={false} trailCount={0} trailShown={false} trupps={TRUPPS}
      acts={{ pick, newTrupp, clearTrail: () => {}, remove: () => {} }} />)
    fireEvent.click(screen.getByRole('button', { name: A.markerLabel }))
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent)
    // no «Kein Trupp» on a marker that hangs on no hose (15.09.): the entry exists only on a hose
    expect(items).toEqual(['Meier Anna', appConfig.copy.whiteboard.newTeam])
    fireEvent.click(screen.getByRole('menuitem', { name: appConfig.copy.whiteboard.newTeam }))
    expect(newTrupp).toHaveBeenCalledTimes(1)
    expect(pick).not.toHaveBeenCalled()
  })

  it('has no «Neuer Trupp» row where the surface does not offer it', () => {
    render(<TwinTeamPill name="Trupp 3" color="#c00" raus={false} trailCount={0} trailShown={false} trupps={TRUPPS}
      acts={{ pick: () => {}, clearTrail: () => {}, remove: () => {} }} />)
    fireEvent.click(screen.getByRole('button', { name: A.markerLabel }))
    expect(screen.queryByRole('menuitem', { name: appConfig.copy.whiteboard.newTeam })).toBeNull()
  })
})

describe('the selected pill of a bound Trupp', () => {
  // the «#N» badge lives on the Atemschutz card only (docs/trupp-naming.md §2, 14.09.)
  it('shows the leader name alone — no «#N» badge', () => {
    const { container } = render(<TwinTeamPill name="Meier Anna" color="#c00" raus={false} truppId="t1" trailCount={0} trailShown={false} trupps={TRUPPS} />)
    expect(container.querySelector('.trupp-no')).toBeNull()
    expect(container.textContent).not.toContain('#2')
  })
})
