// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { resetPopoverGuard } from '../../lib/overlays/popoverGuard'
import { DetailsCard } from './VisitSections'
import type { VisitDoc } from '../../objectVisits/types'

beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } }))
  Element.prototype.scrollTo = () => {}
})
afterEach(() => { cleanup(); resetPopoverGuard(); vi.unstubAllGlobals(); vi.useRealTimers() })

const doc = (over: Partial<VisitDoc> = {}): VisitDoc => ({
  schema: 'kp-front.object-visit/1', id: 'ov1759473240123-0kf9', lifecycle: 'draft',
  object: { id: 'o1', name: 'Gemeindeverwaltung' }, visitedAt: '2026-10-01T08:14:00+02:00',
  checklist: null, answers: {}, notes: '', photos: [], proposals: [], ...over,
} as VisitDoc)

it('«Besucht am» is the app\'s own wheel picker: 24h, «Jetzt», no «Leeren» (owner, 05.10.2026)', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 5, 14, 30))
  let edited: VisitDoc | null = null
  render(<DetailsCard doc={doc()} readOnly={false} onEdit={(fn) => { edited = fn(doc()) }} />)
  // no native datetime-local any more — it read «10/01/2026, 08:14 AM» on an English iPhone
  expect(document.querySelector('input[type="datetime-local"]')).toBeNull()
  const trigger = screen.getByRole('button', { name: 'Besucht am' })
  expect(trigger.textContent).toBe('01.10.2026 08:14')
  fireEvent.click(trigger)
  expect(screen.queryByRole('button', { name: 'Leeren' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Jetzt' }))
  expect(edited).not.toBeNull()
  expect(new Date(edited!.visitedAt).getTime()).toBe(new Date(2026, 9, 5, 14, 30).getTime())
})
