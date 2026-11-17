import { describe, expect, it, vi } from 'vitest'
import { einsatzSubject } from './einsatzSubject'

describe('einsatzSubject', () => {
  it('names the Einsatz and its Zeit Alarmierung, the day only when it is not today', () => {
    vi.useFakeTimers({ now: new Date('2026-11-17T09:00:00') })
    expect(einsatzSubject({ title: 'Zimmerbrand', started_at: '2026-11-17T08:42:00', is_exercise: false }))
      .toEqual({ head: 'Zimmerbrand', text: 'Zeit Alarmierung 08:42' })
    expect(einsatzSubject({ title: 'Ölspur', started_at: '2026-11-15T23:50:00', is_exercise: true }))
      .toEqual({ head: 'Ölspur · Übung', text: 'Zeit Alarmierung 15.11. 23:50' })
    vi.useRealTimers()
  })
})
