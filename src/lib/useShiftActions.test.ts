import { describe, expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import { useShiftActions } from './useShiftActions'
import type { Person, Shift } from '../types'

vi.mock('./ui', () => ({ toast: vi.fn(), undoToast: vi.fn() }))
import { toast, undoToast } from './ui'

// «Schicht erstellen» is a one-time action (05.11.2026: a double tap planned two identical
// shifts): the sheet latches its button (TimeBlockSheet · addedLabel). The way back is the
// Zeitplan slice's ↶ step (owner pick 28, 17.11.2026) – no toast doubles it.
describe('useShiftActions', () => {
  it('plans one shift and removes it again, without a toast', () => {
    let shifts: Shift[] = []
    const setShifts = (u: SetStateAction<Shift[]>) => { shifts = typeof u === 'function' ? u(shifts) : u }
    const { addShift, removeShift } = useShiftActions({ setShifts, startedAt: null })
    addShift({ id: 'p1', displayName: 'Meier Anna' } as Person)
    expect(shifts).toHaveLength(1)
    removeShift(shifts[0].id)
    expect(shifts).toHaveLength(0)
    expect(toast).not.toHaveBeenCalled()
    expect(undoToast).not.toHaveBeenCalled()
  })
})
