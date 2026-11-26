// @vitest-environment jsdom
// What «OK» commits on a date-time field (sweep 25.11.2026): a value the picker did not change is
// no change. It used to commit the wheels' minute, which cut the seconds (09:00:37 → 09:00:00)
// and, on the QR poster, wrote «Zeiten von … korrigiert (QR)» for a time nobody corrected.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'
import { DateTimeField } from './TimeField'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => {
  Element.prototype.scrollTo ??= () => {}
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('coarse'), addEventListener() {}, removeEventListener() {},
  }))
})

const recorded = new Date(2026, 10, 12, 9, 0, 37).toISOString() // 09:00:37

function openField() {
  const onCommit = vi.fn()
  render(<DateTimeField value={recorded} days={[new Date(2026, 10, 12)]} ariaLabel="Einsatzende" onCommit={onCommit} />)
  fireEvent.click(screen.getByRole('button', { name: 'Einsatzende' }))
  return onCommit
}

it('an unchanged «OK» keeps the stored value, seconds and all, and reports no change', () => {
  const onCommit = openField()
  fireEvent.click(screen.getByRole('button', { name: appConfig.copy.wheel.ok }))
  expect(onCommit).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: appConfig.copy.wheel.ok })).toBeNull()
})

it('a changed minute still commits', () => {
  const onCommit = openField()
  const minute = screen.getByRole('listbox', { name: appConfig.copy.wheel.minute })
  fireEvent.click(within(minute).getAllByRole('option', { name: '10' })[0])
  fireEvent.click(screen.getByRole('button', { name: appConfig.copy.wheel.ok }))
  expect(onCommit).toHaveBeenCalledWith(new Date(2026, 10, 12, 9, 10).toISOString())
})
