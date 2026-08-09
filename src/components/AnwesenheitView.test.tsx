// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AnwesenheitView } from './AnwesenheitView'
import { appConfig } from '../config/appConfig'
import type { AttendanceState, Person } from '../types'

afterEach(cleanup)
beforeAll(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

const people: Person[] = [{ id: 'p1', displayName: 'Meier Anna', active: true, updatedAt: 't' }]
const noop = () => {}
const mount = (over: Partial<Parameters<typeof AnwesenheitView>[0]> = {}) => {
  const props = {
    people, attendance: {} as AttendanceState, canEdit: true, loading: false, error: false,
    blockedIds: new Set<string>(), truppOfPerson: new Map<string, string>(), onMarkPresent: noop, onMarkLeft: noop, onClear: noop,
    onJumpToTrupp: noop, onReload: vi.fn(),
    ...over,
  }
  render(<AnwesenheitView {...props} />)
  return props
}

describe('the roster refreshes itself, so the header carries no refresh button', () => {
  it('shows nothing while the roster is fine', () => {
    mount()
    // «Aktualisieren» said the wrong thing twice: attendance follows live and never needed it, and
    // the roster it really refreshed only moves when an admin syncs Divera — which usePersonnel
    // now picks up in the background.
    expect(screen.queryByRole('button', { name: appConfig.copy.anwesenheit.reload })).toBeNull()
  })

  it('offers a retry once a fetch has actually failed', () => {
    const props = mount({ error: true })
    const retry = screen.getByRole('button', { name: appConfig.copy.anwesenheit.reload })
    expect(retry.textContent).toContain(appConfig.copy.anwesenheit.retry)
    fireEvent.click(retry)
    expect(props.onReload).toHaveBeenCalled()
  })

  it('says it is working while the retry is in flight, and cannot be pressed twice', () => {
    mount({ error: true, loading: true })
    const retry = screen.getByRole('button', { name: appConfig.copy.anwesenheit.reload })
    expect(retry.textContent).toContain(appConfig.copy.anwesenheit.loading)
    expect(retry.hasAttribute('disabled')).toBe(true)
  })
})

// A guest is not on the Mannschaftsliste — they exist only as an attendance entry, synthesised
// into a row. The clock button looked its person up in the ROSTER, so for a guest it found
// nobody and the sheet silently did not open. That sheet is also the only place «Person
// entfernen» lives (the row's tap deliberately refuses to cycle a guest back to «frei», because
// that tap would delete the only record they were ever here) — so a guest could be added and
// then never removed, with both routes out failing quietly.
describe('a guest can be opened and removed like anybody else', () => {
  const A = appConfig.copy.anwesenheit
  const withGuest: AttendanceState = {
    g1: { status: 'present', displayNameSnapshot: 'Muster Felix', intervals: [{ from: '2026-08-07T10:00:00.000Z' }] },
  } as unknown as AttendanceState

  it('opens the Zeiten sheet for a guest', () => {
    mount({ attendance: withGuest })
    const clock = screen.getByRole('button', { name: A.openBlocks.replace('{name}', 'Muster Felix') })
    fireEvent.click(clock)
    expect(screen.getByRole('button', { name: new RegExp(A.removeGuest) })).toBeTruthy()
  })

  it('removes the guest through it', () => {
    const onClear = vi.fn()
    mount({ attendance: withGuest, onClear })
    fireEvent.click(screen.getByRole('button', { name: A.openBlocks.replace('{name}', 'Muster Felix') }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(A.removeGuest) }))
    expect(onClear).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1', guest: true }))
  })
})
