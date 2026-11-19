// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'
import type { Person } from '../types'
import { TruppTeam } from './TruppTeam'

// The camera and the decoder are the device's; what TruppTeam owns is what a scan DOES to the crew.
vi.mock('../lib/tagDecoder', () => ({ useHasCamera: () => true }))
vi.mock('./TagScan', () => ({
  // «take-stub» takes everybody but the first and asks to MOVE the last one out of their old Trupp
  TagScan: ({ personnel, chosenIds, onTake }: { personnel: Person[]; chosenIds: ReadonlySet<string>; onTake: (p: Person[], move: string[]) => void }) => (
    <button type="button" data-chosen={[...chosenIds].join(',')} onClick={() => onTake(personnel.slice(1), [personnel[personnel.length - 1].id])}>take-stub</button>
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

  it('moves the asked-for person out of their old Trupp before the crew changes', () => {
    const calls: string[] = []
    const onTransfer = vi.fn((ids: readonly string[], to: string) => { calls.push(`move ${ids.join('+')} to ${to}`) })
    render(
      <TruppTeam
        value={[{ name: 'Meier Anna', personId: 'p1' }]} onChange={() => calls.push('change')}
        personnel={personnel} legacyRoster={[]} presentIds={new Set()} assignedIds={new Set()} phone
        onTransfer={onTransfer}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.atemschutz.scanTitle }))
    fireEvent.click(screen.getByText('take-stub'))
    // no target name: the rank rule may still crown a scanned person on this add
    expect(calls).toEqual(['move p3 to ', 'change'])
  })

  it('tells the camera about a crew member typed by name, so their tag cannot add them twice', () => {
    render(
      <TruppTeam
        value={[{ name: 'Sarah Huber' }]} onChange={vi.fn()}
        personnel={personnel} legacyRoster={[]} presentIds={new Set()} assignedIds={new Set()} phone
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.atemschutz.scanTitle }))
    expect(screen.getByText('take-stub').dataset.chosen).toBe('p2')
  })

  it('offers no Scan without a synced roster – a tag names a roster id', () => {
    render(
      <TruppTeam value={[]} onChange={vi.fn()} personnel={[]} legacyRoster={['Meier Anna']}
        presentIds={new Set()} assignedIds={new Set()} />,
    )
    expect(screen.queryByRole('button', { name: appConfig.copy.atemschutz.scanTitle })).toBeNull()
  })
})
