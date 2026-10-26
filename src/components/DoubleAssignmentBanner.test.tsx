// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trupp } from '../types'
import { DoubleAssignmentBanner } from './DoubleAssignmentBanner'

afterEach(cleanup)

const t = (over: Partial<Trupp>): Trupp => ({
  id: 'T1', no: 4, name: 'Keller Leo', members: ['Müller Hans'], leaderPersonId: 'p1', memberPersonIds: ['p2'],
  entryPressureBar: 300, entryTime: '2026-10-25T14:00:00Z', lastContactTime: '', status: 'aktiv', ...over,
})
const both = [t({}), t({ id: 'T2', no: 5, name: 'Brunner Anna', leaderPersonId: 'p3' })]

describe('DoubleAssignmentBanner (audit F05)', () => {
  it('names the person and offers each Trupp; the tap says which one keeps them', () => {
    const onKeep = vi.fn()
    render(<DoubleAssignmentBanner trupps={both} personnel={[]} onKeep={onKeep} />)
    expect(screen.getByRole('alert').textContent).toContain('Müller Hans in 2 Trupps')
    fireEvent.click(screen.getByRole('button', { name: 'Bleibt in Trupp 5 (Brunner Anna)' }))
    expect(onKeep).toHaveBeenCalledWith('T2', 'p2')
  })

  it('does not offer a choice that would leave the other crew without anybody', () => {
    const alone = t({ id: 'T2', no: 5, name: 'Müller Hans', leaderPersonId: 'p2', members: [], memberPersonIds: [] })
    render(<DoubleAssignmentBanner trupps={[both[0], alone]} personnel={[]} onKeep={() => {}} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Bleibt in Trupp 4 (Keller Leo)' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Bleibt in Trupp 5 (Müller Hans)' }).disabled).toBe(false)
  })

  it('tells a viewer without a choice, and says nothing when nobody is doubled', () => {
    const { rerender } = render(<DoubleAssignmentBanner trupps={both} personnel={[]} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<DoubleAssignmentBanner trupps={[both[0]]} personnel={[]} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
