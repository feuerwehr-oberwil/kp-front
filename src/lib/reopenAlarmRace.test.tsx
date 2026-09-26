// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { AtemschutzAlarmHost } from './useAtemschutzAlarm'
import { useTruppActions } from './useTruppActions'
import { clocksAfterReopen, latestLifecycle } from './reopenClocks'
import { objectsFromLegacy } from './tacticalObjects'
import type { TimelineEvent, Trupp } from '../types'

// THREE TABLETS, ONE CREW OVERDUE AT THE CLOSE, «WIEDER ÖFFNEN» ON ONE OF THEM (staging r6, F1).
//
// Every tablet had the Atemschutz-Alarm open when the Einsatz was closed. After the reopen each
// one ends it, under the SAME derived row id (`azcl-<Trupp>-<turnus>`) — and the server keeps the
// first copy it gets. So the reason in that row must come out the same on every tablet, whatever
// order it hears the reopen in: the reopening tablet (row + restart at once), a tablet that hears
// the lifecycle header before the reopen ROW, and one that gets the reopening tablet's restarted
// Trupps before the row. On staging the listening tablets sent «– Kontakt wiederhergestellt»
// 0.4 s after the reopen, because the alarm host (a child) ended the alarm off the Tafel WITH the
// restart laid over it while the row's text was read off the parent's state WITHOUT it — the
// parent's restart effect runs after the child's.
//
// Each Device below is IncidentWorkspace's wiring, cut down to what this is about: the Trupps in
// state, the Verlauf rows, `alarmTrupps` / `reopenPending` off the newest boundary row, the real
// alarm engine as a CHILD, the real `logTruppAlarmCleared`, and the restart effect in the parent.

vi.mock('./alarm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./alarm')>()),
  notify: vi.fn(async () => {}),
}))

const T0 = Date.parse('2026-07-06T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const CLOSED_AT = iso(T0 + 10 * 60_000)
const REOPEN_AT = iso(T0 + 30 * 60_000)
const closeRow: TimelineEvent = { id: 'sys-close', t: '10:10', at: CLOSED_AT, icon: 'lock', text: 'Einsatz abgeschlossen', lifecycle: 'closed' }
const reopenRow: TimelineEvent = { id: 'sys-reopen', t: '10:30', at: REOPEN_AT, icon: 'unlock', text: 'Einsatz wiedereröffnet', lifecycle: 'reopened' }
const crew = (): Trupp => ({
  id: 'T1', name: 'Fabich Mischa', entryPressureBar: 300, entryTime: iso(T0), lastContactTime: iso(T0), status: 'aktiv',
  readings: [{ t: iso(T0), bar: 300, kind: 'contact' }],
})

/** the server's rule for a derived id: the first copy stays */
const server = { kept: new Map<string, string>(), posts: [] as { device: string; id: string; text: string }[] }

interface DeviceHandle { merge: (ts: Trupp[]) => void }
interface DeviceProps { name: string; running: boolean; rows: TimelineEvent[] }

const Device = forwardRef<DeviceHandle, DeviceProps>(function Device({ name, running, rows }, ref) {
  const [trupps, setTrupps] = useState<Trupp[]>(() => [crew()])
  useImperativeHandle(ref, () => ({ merge: (ts) => setTrupps(ts) }), [])
  const boundary = useMemo(() => latestLifecycle(rows), [rows])
  const reopenPending = running && boundary?.kind === 'closed'
  const alarmTrupps = useMemo(() => clocksAfterReopen(trupps, running ? boundary : null), [trupps, running, boundary])
  const noop = () => {}
  const actions = useTruppActions({
    trupps, drawings: [], entities: [], objects: objectsFromLegacy([], [], {}),
    setTrupps: setTrupps as Dispatch<SetStateAction<Trupp[]>>,
    board: {}, setBoard: noop, setDocRaw: noop, building: null,
    log: (_icon: string, text: string, _k?: unknown, _a?: unknown, _e?: unknown, opts?: { rowId?: string }) => {
      if (!opts?.rowId?.startsWith('azcl-')) return
      server.posts.push({ device: name, id: opts.rowId, text })
      if (!server.kept.has(opts.rowId)) server.kept.set(opts.rowId, text)
    },
    logPlan: noop, emit: noop, setMode: noop, setActivePlanId: noop, setPanel: noop, setPlanFocus: noop,
    mapCenter: () => [7.53, 47.41], focusMapEntity: noop, focusMapDrawing: noop,
  })
  // the parent's restart write (IncidentWorkspace) — declared in the PARENT, so it runs after the
  // alarm host's effect in the same commit, exactly as on the tablet
  useEffect(() => {
    if (!running || boundary?.kind !== 'reopened') return
    setTrupps((ts) => clocksAfterReopen(ts, boundary))
  }, [running, boundary])
  return (
    <AtemschutzAlarmHost trupps={alarmTrupps} muted active={running && !reopenPending}
      logAlarm={actions.logTruppAlarm} logAlarmCleared={actions.logTruppAlarmCleared}
      intervalMin={5} graceSec={60} onState={noop} />
  )
})

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(T0)
  server.kept.clear(); server.posts.length = 0
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('the alarm a reopen ends reads the same on every tablet, in any order (F1)', () => {
  it('three tablets, the listeners racing the reopen row, write one reason: the restart', () => {
    const names = ['A', 'B', 'C'] as const
    const handles: Record<string, DeviceHandle | null> = {}
    const tree = (state: Record<string, { running: boolean; rows: TimelineEvent[] }>) => (
      <>{names.map((n) => <Device key={n} ref={(h) => { handles[n] = h }} name={n} {...state[n]} />)}</>
    )
    const all = (running: boolean, rows: TimelineEvent[]) => Object.fromEntries(names.map((n) => [n, { running, rows }]))
    const view = render(tree(all(true, [])))
    // the crew goes overdue on all three (5 min + 60 s), and the Einsatz is closed at 10:10
    act(() => { vi.advanceTimersByTime(8 * 60_000) })
    act(() => { vi.advanceTimersByTime(2 * 60_000) })
    view.rerender(tree(all(false, [closeRow])))
    act(() => { vi.advanceTimersByTime(20 * 60_000) })
    expect(server.posts).toEqual([])

    // 10:30 — A reopens (row and meta at once). B hears the lifecycle header FIRST (running, the
    // Verlauf still ends at the close), C gets A's restarted Trupps FIRST
    const restarted = clocksAfterReopen([crew()], latestLifecycle([closeRow, reopenRow]))
    view.rerender(tree({ A: { running: true, rows: [closeRow, reopenRow] }, B: { running: true, rows: [closeRow] }, C: { running: false, rows: [closeRow] } }))
    act(() => { handles.C!.merge(restarted) })
    act(() => { vi.advanceTimersByTime(400) })
    view.rerender(tree(all(true, [closeRow, reopenRow])))
    act(() => { vi.advanceTimersByTime(2_000) })

    const want = 'Atemschutz-Alarm beendet: Trupp Fabich Mischa – Kontaktuhr neu gestartet (wieder geöffnet)'
    expect(server.posts.map((p) => p.device).sort()).toEqual(['A', 'B', 'C'])
    expect(new Set(server.posts.map((p) => p.id))).toEqual(new Set([`azcl-T1-${iso(T0)}`]))
    for (const p of server.posts) expect(p.text).toBe(want)
    expect([...server.kept.values()]).toEqual([want])
  })

  it('a tablet that gets the reopen ROW before its Trupps carry the restart still names the restart', () => {
    let handle: DeviceHandle | null = null
    const view = render(<Device ref={(h) => { handle = h }} name="B" running rows={[]} />)
    act(() => { vi.advanceTimersByTime(10 * 60_000) })
    view.rerender(<Device ref={(h) => { handle = h }} name="B" running={false} rows={[closeRow]} />)
    act(() => { vi.advanceTimersByTime(20 * 60_000) })
    // the row and the meta in one render, the Trupps still the pre-restart ones in state
    view.rerender(<Device ref={(h) => { handle = h }} name="B" running rows={[closeRow, reopenRow]} />)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(handle).not.toBeNull()
    expect(server.posts.map((p) => p.text)).toEqual(['Atemschutz-Alarm beendet: Trupp Fabich Mischa – Kontaktuhr neu gestartet (wieder geöffnet)'])
  })
})
