// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { AtemschutzAlarmHost } from './useAtemschutzAlarm'
import { notify } from './alarm'
import * as deploymentConfig from './deploymentConfig'
import type { AtemschutzAlarmState } from './atemschutz'
import type { Trupp } from '../types'

// Only `notify` is faked — the tone side (Alarm, chime) is real and inert in jsdom, where there
// is no Web Audio at all.
vi.mock('./alarm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./alarm')>()),
  notify: vi.fn(async () => {}),
}))

// The host exists so the 1 Hz contact-clock tick re-renders only itself — App must hear
// about the alarm ONLY on real transitions (tier / Trupp), never on plain clock ticks
// (a per-second whole-app re-render was a measured phone battery drain).

const T0 = Date.parse('2026-06-21T10:00:00Z')
const trupp = (over: Partial<Trupp> = {}): Trupp => ({
  id: 't1',
  name: 'Müller',
  entryPressureBar: 300,
  entryTime: new Date(T0).toISOString(),
  lastContactTime: new Date(T0).toISOString(),
  status: 'aktiv',
  ...over,
})

const host = (trupps: Trupp[], onState: (s: AtemschutzAlarmState) => void) => (
  <AtemschutzAlarmHost trupps={trupps} muted active logAlarm={() => {}}
    intervalMin={5} graceSec={60} onState={onState} />
)

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); vi.mocked(notify).mockClear() })
afterEach(() => { cleanup(); vi.useRealTimers() })

// ⚠️ THE BELL COVERS BOTH CHANNELS. Until 2026-08-22 `muted` only reached the tone, so the one
// button labelled «Alarmton aus» left the OS tray posting «Atemschutz überfällig» every 30 s —
// with the system's own sound and vibration. A control that silences half of what it claims to
// silence is worse than none, because it is believed.
describe('the mute reaches the OS notification, not only the tone', () => {
  it('posts the überfällig notification while the alarm is on', () => {
    render(
      <AtemschutzAlarmHost trupps={[trupp()]} muted={false} active logAlarm={() => {}}
        intervalMin={5} graceSec={60} onState={() => {}} />,
    )
    act(() => { vi.advanceTimersByTime(6 * 60_000 + 2000) })
    expect(notify).toHaveBeenCalled()
  })

  it('stays silent on the same crossing while muted', () => {
    render(
      <AtemschutzAlarmHost trupps={[trupp()]} muted active logAlarm={() => {}}
        intervalMin={5} graceSec={60} onState={() => {}} />,
    )
    act(() => { vi.advanceTimersByTime(6 * 60_000 + 2000) })
    expect(notify).not.toHaveBeenCalled()
    // …and it keeps quiet through the 30 s re-notify cadence, not just at the crossing
    act(() => { vi.advanceTimersByTime(5 * 60_000) })
    expect(notify).not.toHaveBeenCalled()
  })
})

// ⚠️ TWO emergencies reach tier 2, and until 23.08. the tray was told only one of them: a Trupp
// at its Alarmdruck was announced as «überfällig – Kontakt herstellen». That is the one
// instruction that does not help, because air does not come back on the radio.
describe('the notification names the emergency it is about', () => {
  it('does not call a Trupp at its Alarmdruck «überfällig»', () => {
    render(
      <AtemschutzAlarmHost trupps={[trupp({ lastPressureBar: 90 })]} muted={false} active logAlarm={() => {}}
        intervalMin={5} graceSec={60} onState={() => {}} />,
    )
    act(() => { vi.advanceTimersByTime(1000) })
    const [title, opts] = vi.mocked(notify).mock.calls[0]
    expect(`${title} ${opts?.body ?? ''}`).not.toMatch(/überfällig/i)
    expect(title).toMatch(/Alarmdruck/)
    expect(opts?.body).toContain('90 bar')
  })

  it('posts pressure immediately when an already-overdue Trupp crosses the Alarmdruck', () => {
    const overdue = trupp({ lastContactTime: new Date(T0 - 10 * 60_000).toISOString() })
    const { rerender } = render(
      <AtemschutzAlarmHost trupps={[overdue]} muted={false} active logAlarm={() => {}}
        intervalMin={5} graceSec={60} onState={() => {}} />,
    )
    act(() => { vi.advanceTimersByTime(1000) })
    expect(vi.mocked(notify).mock.calls[0][0]).toMatch(/überfällig/i)
    vi.mocked(notify).mockClear()

    rerender(
      <AtemschutzAlarmHost trupps={[{ ...overdue, lastPressureBar: 90, lastPressureTime: new Date(T0 + 1000).toISOString() }]}
        muted={false} active logAlarm={() => {}} intervalMin={5} graceSec={60} onState={() => {}} />,
    )
    expect(notify).toHaveBeenCalledTimes(1)
    const [title, opts] = vi.mocked(notify).mock.calls[0]
    expect(title).toMatch(/Alarmdruck/)
    expect(opts?.body).toContain('90 bar')
  })
})

describe('AtemschutzAlarmHost', () => {
  it('reports transitions only — clock ticks alone never reach onState', () => {
    const onState = vi.fn()
    render(host([trupp()], onState))
    expect(onState).not.toHaveBeenCalled() // silent initial state === App's initial state

    // 3 minutes of ticking well below the 5-min interval: still silent, still zero calls
    act(() => { vi.advanceTimersByTime(3 * 60_000) })
    expect(onState).not.toHaveBeenCalled()

    // crossing the interval mark (5:00) → ONE transition to tier 1
    act(() => { vi.advanceTimersByTime(2 * 60_000 + 1000) })
    expect(onState).toHaveBeenCalledTimes(1)
    const s: AtemschutzAlarmState = onState.mock.calls[0][0]
    expect(s.peak).toBe(1)
    expect(s.urgent).toMatchObject({ id: 't1', severity: 1, contactAt: T0 })

    // 30 more seconds inside tier 1: the clock advances, but no new report
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(onState).toHaveBeenCalledTimes(1)
  })

  it('reports the tier-2 crossing as a second transition', () => {
    const onState = vi.fn()
    render(host([trupp()], onState))
    // straight past interval (5 min) + Nachfrist (60 s): tier 1 then tier 2, two reports
    act(() => { vi.advanceTimersByTime(5 * 60_000 + 1000) })
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(onState).toHaveBeenCalledTimes(2)
    expect(onState.mock.lastCall![0].peak).toBe(2)
  })

  it('updates the app-wide chip when tier 2 changes from contact to pressure', () => {
    const overdue = trupp({ lastContactTime: new Date(T0 - 10 * 60_000).toISOString() })
    const onState = vi.fn()
    const { rerender } = render(host([overdue], onState))
    expect(onState.mock.lastCall![0].urgent).toMatchObject({ reason: 'contact' })
    onState.mockClear()

    rerender(host([{ ...overdue, lastPressureBar: 90, lastPressureTime: new Date(T0 + 1000).toISOString() }], onState))
    expect(onState).toHaveBeenCalledTimes(1)
    expect(onState.mock.lastCall![0].urgent).toMatchObject({ reason: 'pressure', bar: 90 })
  })
})

// ⚠️ The Verlauf must not fill with the same alarm. Every mount starts with an empty severity
// map, so a Trupp who was ALREADY überfällig looked like a fresh 0 → 2 crossing and wrote another
// «Atemschutz-Alarm: … Überfällig» line — on every reload, resume-from-kill and HMR update.
describe('AtemschutzAlarmHost · the überfällig line is written once per real crossing', () => {
  const overdueTrupp = () => trupp({
    // last contact 10 minutes ago: past 5 min + 60 s, i.e. already tier 2 when the app starts
    lastContactTime: new Date(T0 - 10 * 60_000).toISOString(),
  })

  it('does not re-log a Trupp who was already overdue when the app started', () => {
    const logAlarm = vi.fn()
    render(
      <AtemschutzAlarmHost trupps={[overdueTrupp()]} muted active logAlarm={logAlarm}
        intervalMin={5} graceSec={60} onState={() => {}} />,
    )
    act(() => { vi.advanceTimersByTime(5 * 60_000) })
    expect(logAlarm).not.toHaveBeenCalled()
  })

  // …and the same when the roster arrives asynchronously with the workspace, which is the normal
  // case: the first evaluation runs over an EMPTY list, so a global «first pass» flag would be
  // spent before any Trupp had been seen.
  it('does not re-log when the Trupps land after the first evaluation', () => {
    const logAlarm = vi.fn()
    const { rerender } = render(
      <AtemschutzAlarmHost trupps={[]} muted active logAlarm={logAlarm}
        intervalMin={5} graceSec={60} onState={() => {}} />,
    )
    act(() => { vi.advanceTimersByTime(1000) })
    rerender(
      <AtemschutzAlarmHost trupps={[overdueTrupp()]} muted active logAlarm={logAlarm}
        intervalMin={5} graceSec={60} onState={() => {}} />,
    )
    act(() => { vi.advanceTimersByTime(5 * 60_000) })
    expect(logAlarm).not.toHaveBeenCalled()
  })

  it('DOES log a crossing this session watched happen', () => {
    const logAlarm = vi.fn()
    render(
      <AtemschutzAlarmHost trupps={[trupp()]} muted active logAlarm={logAlarm}
        intervalMin={5} graceSec={60} onState={() => {}} />,
    )
    expect(logAlarm).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(6 * 60_000 + 2000) }) // past interval + grace
    expect(logAlarm).toHaveBeenCalledTimes(1)
    expect(logAlarm.mock.calls[0][1]).toBe('ueberfaellig')
    // …and staying overdue writes nothing more
    act(() => { vi.advanceTimersByTime(10 * 60_000) })
    expect(logAlarm).toHaveBeenCalledTimes(1)
  })

  it('does not write passive visitors alarm crossings into the shared demo journal', () => {
    const demo = vi.spyOn(deploymentConfig, 'isDemoMode').mockReturnValue(true)
    const logAlarm = vi.fn()
    render(
      <AtemschutzAlarmHost trupps={[trupp()]} muted active logAlarm={logAlarm}
        intervalMin={5} graceSec={60} onState={() => {}} />,
    )
    act(() => { vi.advanceTimersByTime(6 * 60_000 + 2000) })
    expect(logAlarm).not.toHaveBeenCalled()
    demo.mockRestore()
  })
})
