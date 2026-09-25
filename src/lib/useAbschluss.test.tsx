// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('./ui', () => ({ confirmDialog: vi.fn() }))
import { confirmDialog } from './ui'
import { useAbschluss } from './useAbschluss'
import type { ReportMeta } from './workspace'
import type { Trupp } from '../types'
import { appConfig } from '../config/appConfig'

// The Abschluss block (moved out of IncidentWorkspace 23.09.2026). The confirm → flush → handover
// order is pinned end to end in IncidentWorkspace.harness; these pin the derived values.
const args = (over: Partial<Parameters<typeof useAbschluss>[0]> = {}): Parameters<typeof useAbschluss>[0] => ({
  reportMeta: {} as ReportMeta, attendance: {}, mittel: [], trupps: [],
  incidentMeta: { is_archived: false, closed_at: null }, replayActive: false,
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
      incidentMeta: { is_archived: true, closed_at: '2026-09-23T12:00:00Z' },
      reportMeta: { endedAt: '2026-09-23T03:30:00Z' } as ReportMeta,
    }))).result.current
    expect(closed.azMonitoring).toBe(false)
    // the Einsatzende, not the morning-after closed_at
    expect(closed.azFrozenAt).toBe(Date.parse('2026-09-23T03:30:00Z'))
  })

  it('an empty Rapport misses its Mindestangaben; no Trupps means none still out', () => {
    const r = renderHook(() => useAbschluss(args())).result.current
    expect(r.abschlussMissing.length).toBeGreaterThan(0)
    expect(r.truppsStillOut).toBe(0)
  })

  it('a cancelled confirm hands nothing over and drains nothing', async () => {
    vi.mocked(confirmDialog).mockResolvedValueOnce(false)
    const a = args()
    const r = renderHook(() => useAbschluss(a)).result.current
    await expect(r.confirmAndComplete()).resolves.toBe(false)
    expect(a.media.flush).not.toHaveBeenCalled()
    expect(a.onCompleteRapport).not.toHaveBeenCalled()
  })

  /* A Trupp still ANGEMELDET at the Abschluss (24.09.2026, D1 ⑦): the Sicherungstrupp T6 stood
     «angemeldet» to the end of the Übung, and the confirm counted only the crews inside. */
  describe('a Trupp still angemeldet is asked about first', () => {
    const A = appConfig.copy.abschluss
    const sich: Trupp = {
      id: 't6', no: 6, name: 'Muster Leo', entryPressureBar: 280, entryTime: '', lastContactTime: '',
      status: 'angemeldet', auftrag: 'sichern',
    }

    it('«Als nicht eingesetzt schliessen» stands it down, then asks the Abschluss as always', async () => {
      const ask = vi.mocked(confirmDialog)
      ask.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(true)
      const standDownTrupps = vi.fn()
      const a = args({ trupps: [sich], standDownTrupps })
      const r = renderHook(() => useAbschluss(a)).result.current
      await expect(r.confirmAndComplete()).resolves.toBe(true)
      expect(ask.mock.calls[0][0]).toMatchObject({
        message: '1 Trupp noch angemeldet (#6 Muster Leo, Sicherungstrupp).',
        confirmLabel: A.registeredStandDown, altLabel: A.registeredToBoard,
      })
      expect(standDownTrupps).toHaveBeenCalledWith(['t6'])
      expect(ask).toHaveBeenCalledTimes(2)
      expect(a.onCompleteRapport).toHaveBeenCalled()
    })

    it('«Zur Tafel» goes to the board and closes nothing', async () => {
      const ask = vi.mocked(confirmDialog)
      ask.mockReset().mockResolvedValueOnce('alt' as never)
      const standDownTrupps = vi.fn()
      const a = args({ trupps: [sich], standDownTrupps })
      const r = renderHook(() => useAbschluss(a)).result.current
      await expect(r.confirmAndComplete()).resolves.toBe(false)
      expect(a.setMode).toHaveBeenCalledWith('atemschutz')
      expect(standDownTrupps).not.toHaveBeenCalled()
      expect(a.onCompleteRapport).not.toHaveBeenCalled()
      expect(ask).toHaveBeenCalledTimes(1)
    })

    it('dismissing the question does nothing at all', async () => {
      const ask = vi.mocked(confirmDialog)
      ask.mockReset().mockResolvedValueOnce(false)
      const standDownTrupps = vi.fn()
      const a = args({ trupps: [sich], standDownTrupps })
      await expect(renderHook(() => useAbschluss(a)).result.current.confirmAndComplete()).resolves.toBe(false)
      expect(standDownTrupps).not.toHaveBeenCalled()
      expect(a.setMode).not.toHaveBeenCalled()
    })

    it('asks nothing about a crew inside, a Trupp already out, or a work squad at the vehicle', async () => {
      const ask = vi.mocked(confirmDialog)
      ask.mockReset().mockResolvedValueOnce(false)
      const a = args({
        trupps: [
          { ...sich, id: 'in', status: 'aktiv', entryTime: '2026-09-23T19:00:00Z' },
          { ...sich, id: 'out', status: 'raus' },
          { ...sich, id: 'plain', kind: 'einfach', entryPressureBar: 0 },
        ],
        standDownTrupps: vi.fn(),
      })
      await renderHook(() => useAbschluss(a)).result.current.confirmAndComplete()
      expect(ask).toHaveBeenCalledTimes(1)
      expect(ask.mock.calls[0][0].message).not.toContain('angemeldet')
    })
  })
})
