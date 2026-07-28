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
    blockedIds: new Set<string>(), onMarkPresent: noop, onMarkLeft: noop, onClear: noop,
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
