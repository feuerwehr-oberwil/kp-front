// @vitest-environment jsdom
// Hunt 24.11.2026, records-rapport F6: the Rapport's date-time picker across the clock changes.
// The station's wall clock is Zurich; the suite pins it for this file.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'
import { DateTimeField } from './TimeField'

const tz = process.env.TZ
process.env.TZ = 'Europe/Zurich'
afterAll(() => { process.env.TZ = tz })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function openTime(value: string, coarse: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: coarse && query.includes('coarse'), addEventListener() {}, removeEventListener() {},
  }))
  Element.prototype.scrollTo ??= () => {}
  const onCommit = vi.fn()
  render(<DateTimeField value={value} days={[new Date(value)]} ariaLabel="Einsatzende" onCommit={onCommit} />)
  fireEvent.click(screen.getByRole('button', { name: 'Einsatzende' }))
  return onCommit
}

it.each([true, false])('an unchanged «OK» on the second 02:15 keeps it (wheels %s)', (coarse) => {
  const second = '2026-10-25T01:15:00.000Z' // 02:15 winter time, an hour after the first 02:15
  const onCommit = openTime(second, coarse)
  fireEvent.click(screen.getByRole('button', { name: 'OK' }))
  // the first 02:15 would be a change and commit; the second one is the value, so nothing does
  expect(onCommit).not.toHaveBeenCalled()
})

it('a time the spring change skips is refused with a note', () => {
  const onCommit = openTime('2026-03-29T00:15:00Z', false)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '02:15' } })
  fireEvent.click(screen.getByRole('button', { name: 'OK' }))
  expect(onCommit).not.toHaveBeenCalled()
  expect(screen.getByText(appConfig.copy.wheel.skippedTime)).toBeTruthy()
})

it('«Jetzt» in the second 02:15 saves that instant, not the first 02:15 the field opened on', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(new Date('2026-10-25T01:20:00.000Z')) // 02:20 winter time
    const onCommit = openTime('2026-10-25T00:15:00.000Z', true) // opened on 02:15 summer time
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.wheel.now }))
    expect(onCommit).toHaveBeenCalledWith('2026-10-25T01:20:00.000Z')
  } finally {
    vi.useRealTimers()
  }
})
