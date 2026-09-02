// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the alarm layer so the host's tone/notification side effects don't touch Web Audio /
// Notification in the test env — we're testing the due-derivation timing, not the alert delivery.
vi.mock('./alarm', () => ({ notify: vi.fn(), startAlarm: vi.fn(), stopAlarm: vi.fn() }))

import { RemindersHost, useReminders } from './useReminders'
import { notify } from './alarm'
import type { TimelineEvent } from '../types'

const copy = { dueTitle: 'fällig', doneLog: '{text}', pendenzDoneLog: 'p {text}', snoozeLog: '{mins} {text}' }
const createdRow = (id: string, dueAt: string, at: string): TimelineEvent =>
  ({ id: `e-${id}`, t: '03:00', at, icon: 'clock', text: 'Keller prüfen', kind: 'reminder', reminder: { op: 'created', id, dueAt } }) as TimelineEvent

// The hook and its host, wired the way IncidentWorkspace wires them: the parent holds
// open/due/markDone/snooze, the null-rendering host holds the clock. `renders` counts the
// PARENT's renders — the whole point of the host is that a plain tick never reaches it.
type Reminders = ReturnType<typeof useReminders>
let latest: Reminders
let renders = 0
const track = (r: Reminders) => { latest = r; renders += 1 }
function Probe({ timeline, enabled = true, report }: { timeline: TimelineEvent[]; enabled?: boolean; report: (r: Reminders) => void }) {
  const r = useReminders(timeline, () => {}, copy, enabled)
  report(r)
  return <RemindersHost {...r.host} />
}

beforeEach(() => { vi.useFakeTimers(); renders = 0 })
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('useReminders — overdue recompute on resume', () => {
  it('uses the Web-Push tag so foreground and killed-app alerts coalesce', () => {
    const t0 = Date.parse('2026-06-30T03:00:00.000Z')
    vi.setSystemTime(t0)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })

    render(<Probe report={track} timeline={[createdRow('r1', new Date(t0 - 1_000).toISOString(), new Date(t0 - 2_000).toISOString())]} />)

    expect(notify).toHaveBeenCalledWith('fällig', {
      body: 'Keller prüfen', tag: 'reminder-r1', target: 'journal',
    })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })

  it('surfaces an overdue reminder immediately on visibilitychange, not only on the 10s tick', () => {
    const t0 = Date.parse('2026-06-30T03:00:00.000Z')
    vi.setSystemTime(t0)
    const timeline = [createdRow('r1', new Date(t0 + 30_000).toISOString(), new Date(t0).toISOString())]

    render(<Probe report={track} timeline={timeline} />)
    expect(latest.dueCount).toBe(0) // not due yet

    // Jump the clock past due WITHOUT running timers — a backgrounded/locked device whose
    // 10s interval was frozen. Without a resume handler the in-app due state would stay stale.
    act(() => { vi.setSystemTime(t0 + 31_000) })
    expect(latest.dueCount).toBe(0)

    // Resuming the app recomputes at once.
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(latest.dueCount).toBe(1)
  })

  it('still detects a due reminder via the periodic 10s tick', () => {
    const t0 = Date.parse('2026-06-30T03:00:00.000Z')
    vi.setSystemTime(t0)
    const timeline = [createdRow('r1', new Date(t0 + 5_000).toISOString(), new Date(t0).toISOString())]

    render(<Probe report={track} timeline={timeline} />)
    expect(latest.dueCount).toBe(0)

    act(() => { vi.advanceTimersByTime(11_000) }) // the 10s interval fires and recomputes
    expect(latest.dueCount).toBe(1)
  })

  it('does not recompute (raise) while still hidden — only when visible again', () => {
    const t0 = Date.parse('2026-06-30T03:00:00.000Z')
    vi.setSystemTime(t0)
    const timeline = [createdRow('r1', new Date(t0 + 30_000).toISOString(), new Date(t0).toISOString())]
    render(<Probe report={track} timeline={timeline} />)

    // Simulate the tab being hidden, clock jumps past due, a visibilitychange fires while hidden.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    act(() => { vi.setSystemTime(t0 + 31_000); document.dispatchEvent(new Event('visibilitychange')) })
    expect(latest.dueCount).toBe(0) // still hidden → no in-app recompute

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(latest.dueCount).toBe(1) // visible again → recompute
  })
})

describe('RemindersHost — the tick stays in the host', () => {
  it('re-renders the parent only when the SET of due ids changes, never on a plain tick', () => {
    const t0 = Date.parse('2026-06-30T03:00:00.000Z')
    vi.setSystemTime(t0)
    const timeline = [createdRow('r1', new Date(t0 + 60_000).toISOString(), new Date(t0).toISOString())]
    render(<Probe report={track} timeline={timeline} />)
    const settled = renders

    // five ticks with nothing crossing — the host ticks, the parent does not hear about it
    act(() => { vi.advanceTimersByTime(50_000) })
    expect(renders).toBe(settled)
    expect(latest.dueCount).toBe(0)

    // the crossing is a change of set → exactly one parent render
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(latest.dueCount).toBe(1)
    expect(renders).toBe(settled + 1)

    // …and the ticks after it are silent again
    act(() => { vi.advanceTimersByTime(50_000) })
    expect(renders).toBe(settled + 1)
  })

  it('clears the due set when disabled (replay), so the banner cannot show a historical alarm', () => {
    const t0 = Date.parse('2026-06-30T03:00:00.000Z')
    vi.setSystemTime(t0)
    const timeline = [createdRow('r1', new Date(t0 - 1_000).toISOString(), new Date(t0 - 2_000).toISOString())]
    const view = render(<Probe report={track} timeline={timeline} />)
    expect(latest.dueCount).toBe(1)
    view.rerender(<Probe report={track} timeline={timeline} enabled={false} />)
    expect(latest.dueCount).toBe(0)
  })
})
