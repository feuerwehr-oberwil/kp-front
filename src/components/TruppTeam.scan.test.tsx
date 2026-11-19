// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'
import type { Person } from '../types'
import { TruppTeam } from './TruppTeam'

// The camera and the decoder are the device's; what TruppTeam owns is what a scan DOES to the crew.
vi.mock('../lib/tagDecoder', () => ({ useHasCamera: () => true }))
vi.mock('./TagScan', () => ({
  TagScan: ({ personnel, onTake }: { personnel: Person[]; onTake: (p: Person[]) => void }) => (
    <button type="button" onClick={() => onTake(personnel.slice(1))}>take-stub</button>
  ),
}))

afterEach(cleanup)

const person = (id: string, displayName: string): Person => ({ id, displayName, active: true, updatedAt: '2026-11-19T00:00:00Z' })
const personnel = [person('p1', 'Meier Anna'), person('p2', 'Huber Sarah'), person('p3', 'Brunner Thomas')]

describe('TruppTeam · Scan', () => {
  it('adds the whole scanned crew in ONE change, after whoever is already in', () => {
    const onChange = vi.fn()
    render(
      <TruppTeam
        value={[{ name: 'Meier Anna', personId: 'p1' }]} onChange={onChange}
        personnel={personnel} legacyRoster={[]} presentIds={new Set()} assignedIds={new Set()} phone
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.atemschutz.scanTitle }))
    fireEvent.click(screen.getByText('take-stub'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith([
      { name: 'Meier Anna', personId: 'p1' },
      { name: 'Huber Sarah', personId: 'p2' },
      { name: 'Brunner Thomas', personId: 'p3' },
    ], 'add')
    expect(screen.queryByText('take-stub')).toBeNull()
  })

  it('offers no Scan without a synced roster – a tag names a roster id', () => {
    render(
      <TruppTeam value={[]} onChange={vi.fn()} personnel={[]} legacyRoster={['Meier Anna']}
        presentIds={new Set()} assignedIds={new Set()} />,
    )
    expect(screen.queryByRole('button', { name: appConfig.copy.atemschutz.scanTitle })).toBeNull()
  })
})
