// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('./ui', () => ({ confirmDialog: vi.fn() }))
import { confirmDialog } from './ui'
import { useAbschluss } from './useAbschluss'
import type { ReportMeta } from './workspace'

// The Abschluss block (moved out of IncidentWorkspace 23.09.2026). The confirm → flush → handover
// order is pinned end to end in IncidentWorkspace.harness; these pin the derived values.
const args = (over: Partial<Parameters<typeof useAbschluss>[0]> = {}): Parameters<typeof useAbschluss>[0] => ({
  reportMeta: {} as ReportMeta, attendance: {}, mittel: [], trupps: [],
  incidentMeta: { is_archived: false, status: 'offen', closed_at: null }, replayActive: false,
  media: { pendingCount: 0, flush: vi.fn(async () => {}) } as never,
  onCompleteRapport: vi.fn(async () => true),
  setMode: vi.fn(), setPanel: vi.fn(), setOfflineReadyOpen: vi.fn(), requestReportStep: vi.fn(),
  ...over,
})

describe('useAbschluss', () => {
  it('a running Einsatz monitors and freezes nothing; replay and an archived one stop the alarm', () => {
    expect(renderHook(() => useAbschluss(args())).result.current).toMatchObject({ azMonitoring: true, azFrozenAt: undefined })
    expect(renderHook(() => useAbschluss(args({ replayActive: true }))).result.current.azMonitoring).toBe(false)
    const closed = renderHook(() => useAbschluss(args({
      incidentMeta: { is_archived: true, status: 'offen', closed_at: '2026-09-23T12:00:00Z' },
      reportMeta: { endedAt: '2026-09-23T03:30:00Z' } as ReportMeta,
    }))).result.current
    expect(closed.azMonitoring).toBe(false)
    // the Einsatzende, not the morning-after closed_at
    expect(closed.azFrozenAt).toBe(Date.parse('2026-09-23T03:30:00Z'))
  })

  it('a close on ANOTHER device stops the alarm here, in place — no remount (N3, 25.09.2026)', () => {
    // App flips the live meta when the close is heard (App · onIncidentClosed); the hook that
    // drives the AtemschutzAlarmHost must follow the SAME mount, not only the next open
    let meta: Parameters<typeof useAbschluss>[0]['incidentMeta'] = { is_archived: false, status: 'offen', closed_at: null }
    const h = renderHook(() => useAbschluss(args({ incidentMeta: meta })))
    expect(h.result.current.azMonitoring).toBe(true)
    meta = { is_archived: true, status: 'offen', closed_at: '2026-09-25T12:45:00Z' }
    h.rerender()
    expect(h.result.current.azMonitoring).toBe(false)
    expect(h.result.current.azFrozenAt).toBe(Date.parse('2026-09-25T12:45:00Z'))
    // …and «closed» is the backend's `is_open`: a status moved off the running ones ends it too
    expect(renderHook(() => useAbschluss(args({ incidentMeta: { is_archived: false, status: 'abgeschlossen', closed_at: null } }))).result.current.azMonitoring).toBe(false)
  })

  it('an empty Rapport misses its Mindestangaben; no Trupps means none still out', () => {
    const r = renderHook(() => useAbschluss(args())).result.current
    expect(r.abschlussMissing.length).toBeGreaterThan(0)
    expect(r.truppsStillOut).toBe(0)
  })

  it('drains the Verlauf and audit outboxes BEFORE the handover (review of #235)', async () => {
    // after the archive they would be judged against a closed Einsatz
    vi.mocked(confirmDialog).mockResolvedValueOnce(true)
    const order: string[] = []
    const a = args({
      flushOutboxes: vi.fn(async () => { order.push('outboxes') }),
      onCompleteRapport: vi.fn(async () => { order.push('complete'); return true }),
    })
    const r = renderHook(() => useAbschluss(a)).result.current
    await expect(r.confirmAndComplete()).resolves.toBe(true)
    expect(order).toEqual(['outboxes', 'complete'])
  })

  it('marks the rows written between the confirm and the close as the Abschluss\'s own (staging r6, F3)', async () => {
    vi.mocked(confirmDialog).mockResolvedValueOnce(true)
    const marks: boolean[] = []
    const seen: string[] = []
    const a = args({
      markClosing: (on) => { marks.push(on) },
      flushOutboxes: vi.fn(async () => { seen.push(`flush:${marks[marks.length - 1]}`) }),
      onCompleteRapport: vi.fn(async () => { seen.push(`close:${marks[marks.length - 1]}`); return true }),
    })
    const r = renderHook(() => useAbschluss(a)).result.current
    await expect(r.confirmAndComplete()).resolves.toBe(true)
    expect(seen).toEqual(['flush:true', 'close:true'])
    expect(marks).toEqual([true, false])
    // a failed close lifts the mark as well, and a cancelled confirm never sets it
    vi.mocked(confirmDialog).mockResolvedValueOnce(true)
    marks.length = 0
    const failing = renderHook(() => useAbschluss(args({
      markClosing: (on) => { marks.push(on) },
      onCompleteRapport: vi.fn(async () => { throw new Error('offline') }),
    }))).result.current
    await expect(failing.confirmAndComplete()).rejects.toThrow('offline')
    expect(marks).toEqual([true, false])
    vi.mocked(confirmDialog).mockResolvedValueOnce(false)
    marks.length = 0
    await renderHook(() => useAbschluss(args({ markClosing: (on) => { marks.push(on) } }))).result.current.confirmAndComplete()
    expect(marks).toEqual([])
  })

  it('a cancelled confirm hands nothing over and drains nothing', async () => {
    vi.mocked(confirmDialog).mockResolvedValueOnce(false)
    const a = args()
    const r = renderHook(() => useAbschluss(a)).result.current
    await expect(r.confirmAndComplete()).resolves.toBe(false)
    expect(a.media.flush).not.toHaveBeenCalled()
    expect(a.onCompleteRapport).not.toHaveBeenCalled()
  })
})
