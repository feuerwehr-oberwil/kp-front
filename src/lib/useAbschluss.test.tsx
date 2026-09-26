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

  /* A Trupp still ANGEMELDET at the Abschluss (24.09.2026, D1 ⑦): the Sicherungstrupp stood
     «angemeldet» to the end of the Übung, and the confirm counted only the crews inside. */
  describe('a Trupp still angemeldet is asked about first', () => {
    const A = appConfig.copy.abschluss
    const sich: Trupp = {
      id: 't6', no: 6, name: 'Muster Leo', entryPressureBar: 280, entryTime: '', lastContactTime: '',
      status: 'angemeldet', auftrag: 'sichern',
    }

    it('«Als nicht eingesetzt schliessen» stands it down only AFTER the final «Abschliessen»', async () => {
      const ask = vi.mocked(confirmDialog)
      const order: string[] = []
      ask.mockReset()
        .mockImplementationOnce(async () => { order.push('ask registered'); return true })
        .mockImplementationOnce(async () => { order.push('ask abschluss'); return true })
      const standDownTrupps = vi.fn(() => { order.push('stand down') })
      const a = args({ trupps: [sich], standDownTrupps, onCompleteRapport: vi.fn(async () => { order.push('complete'); return true }) })
      const r = renderHook(() => useAbschluss(a)).result.current
      await expect(r.confirmAndComplete()).resolves.toBe(true)
      expect(ask.mock.calls[0][0]).toMatchObject({
        message: '1 Trupp noch angemeldet (#6 Muster Leo, Sicherungstrupp).',
        confirmLabel: A.registeredStandDown, altLabel: A.registeredToBoard,
        // «Zur Tafel» is the focused, filled answer — an Enter closes nothing
        safeAnswer: 'alt',
      })
      expect(standDownTrupps).toHaveBeenCalledWith(['t6'])
      expect(order).toEqual(['ask registered', 'ask abschluss', 'stand down', 'complete'])
    })

    it('«schliessen», then «Abbrechen» on the Abschluss, stands NOTHING down', async () => {
      const ask = vi.mocked(confirmDialog)
      ask.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      const standDownTrupps = vi.fn()
      const a = args({ trupps: [sich], standDownTrupps })
      await expect(renderHook(() => useAbschluss(a)).result.current.confirmAndComplete()).resolves.toBe(false)
      expect(standDownTrupps).not.toHaveBeenCalled()
      expect(a.onCompleteRapport).not.toHaveBeenCalled()
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

    it('is not offered while a crew is still inside — the Abschluss asks about that one first', async () => {
      const ask = vi.mocked(confirmDialog)
      // «trotzdem» on the crews-inside question, then «Abbrechen» on the Abschluss itself
      ask.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      const standDownTrupps = vi.fn()
      const a = args({
        trupps: [sich, { ...sich, id: 'in', no: 1, auftrag: 'loeschen', status: 'aktiv', entryTime: '2026-09-23T19:00:00Z' }],
        standDownTrupps,
      })
      await renderHook(() => useAbschluss(a)).result.current.confirmAndComplete()
      expect(ask).toHaveBeenCalledTimes(2)
      expect(ask.mock.calls[1][0].message).not.toContain('angemeldet')
      expect(standDownTrupps).not.toHaveBeenCalled()
    })

    it('asks nothing about a Trupp already out, a work squad at the vehicle, or a Reserve that was inside', async () => {
      const ask = vi.mocked(confirmDialog)
      ask.mockReset().mockResolvedValueOnce(false)
      const a = args({
        trupps: [
          { ...sich, id: 'out', status: 'raus' },
          { ...sich, id: 'plain', kind: 'einfach', entryPressureBar: 0 },
          { ...sich, id: 'reserve', readings: [{ t: '2026-09-23T19:00:00Z', bar: 300, kind: 'entry' }] },
        ],
        standDownTrupps: vi.fn(),
      })
      await renderHook(() => useAbschluss(a)).result.current.confirmAndComplete()
      expect(ask).toHaveBeenCalledTimes(1)
      expect(ask.mock.calls[0][0].message).not.toContain('angemeldet')
    })

    it('keeps ONE confirm across Trupp writes — the callback is not rebuilt per Kontakt', () => {
      const a = args({ trupps: [sich], standDownTrupps: vi.fn() })
      const { result, rerender } = renderHook((p: Parameters<typeof useAbschluss>[0]) => useAbschluss(p), { initialProps: a })
      const first = result.current.confirmAndComplete
      rerender({ ...a, trupps: [{ ...sich, lastContactTime: '2026-09-23T19:01:00Z' }] })
      expect(result.current.confirmAndComplete).toBe(first)
    })
  })

  /* Crews still INSIDE (staging walk-through 25.09.2026): their own first question, naming them,
     with «Zur Tafel» as the filled, focused answer — an Enter must never close over them. */
  describe('crews still inside are asked about first, by name', () => {
    const inside: Trupp = {
      id: 'in', no: 1, name: 'Muster Leo', members: ['Graf Eva'], entryPressureBar: 300,
      entryTime: '2026-09-25T10:00:00Z', lastContactTime: '2026-09-25T10:04:00Z', status: 'aktiv',
    }

    it('names them, focuses «Zur Tafel», and «Zur Tafel» closes nothing', async () => {
      const ask = vi.mocked(confirmDialog)
      ask.mockReset().mockResolvedValueOnce('alt' as never)
      const a = args({ trupps: [inside] })
      await expect(renderHook(() => useAbschluss(a)).result.current.confirmAndComplete()).resolves.toBe(false)
      expect(ask.mock.calls[0][0]).toMatchObject({
        message: '1 Trupp ist noch drin: Trupp 1 (Muster Leo / Graf Eva).',
        altLabel: appConfig.copy.abschluss.registeredToBoard,
        confirmLabel: appConfig.copy.abschluss.insideClose,
        safeAnswer: 'alt',
      })
      expect(a.setMode).toHaveBeenCalledWith('atemschutz')
      expect(a.onCompleteRapport).not.toHaveBeenCalled()
    })

    it('closing anyway goes on to the Abschluss itself — and writes no Austritt', async () => {
      const ask = vi.mocked(confirmDialog)
      ask.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(true)
      const standDownTrupps = vi.fn()
      const a = args({ trupps: [inside], standDownTrupps })
      await expect(renderHook(() => useAbschluss(a)).result.current.confirmAndComplete()).resolves.toBe(true)
      expect(ask).toHaveBeenCalledTimes(2)
      expect(standDownTrupps).not.toHaveBeenCalled()
    })

    // staging r3 F4: closing over them wrote nothing, and the record ended with open sorties
    it('closing anyway writes «beim Abschluss noch drin» for each crew — before the handover, and only then', async () => {
      const ask = vi.mocked(confirmDialog)
      const order: string[] = []
      const noteInsideAtClose = vi.fn((ts: Trupp[]) => { order.push(`note ${ts.map((t) => t.id).join(',')}`) })
      ask.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(true)
      const a = args({ trupps: [inside], noteInsideAtClose, onCompleteRapport: vi.fn(async () => { order.push('complete'); return true }) })
      await renderHook(() => useAbschluss(a)).result.current.confirmAndComplete()
      expect(order).toEqual(['note in', 'complete'])
      // «Trotzdem» on the crews question, then «Zurück» on the list: nothing written
      noteInsideAtClose.mockClear()
      ask.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      await renderHook(() => useAbschluss(args({ trupps: [inside], noteInsideAtClose }))).result.current.confirmAndComplete()
      expect(noteInsideAtClose).not.toHaveBeenCalled()
    })

    it('dismissing it does nothing', async () => {
      const ask = vi.mocked(confirmDialog)
      ask.mockReset().mockResolvedValueOnce(false)
      const a = args({ trupps: [inside] })
      await expect(renderHook(() => useAbschluss(a)).result.current.confirmAndComplete()).resolves.toBe(false)
      expect(ask).toHaveBeenCalledTimes(1)
      expect(a.onCompleteRapport).not.toHaveBeenCalled()
    })
  })

  /* People still MISSING (walk-through 25.09.2026, N6): «8 Personen noch vermisst» was a grey row
     under a filled, focused «Trotzdem abschliessen», and an Enter closed the Einsatz over them. */
  describe('people still missing are their own question, after the crews', () => {
    const inside: Trupp = {
      id: 'in', no: 1, name: 'Muster Leo', entryPressureBar: 300,
      entryTime: '2026-09-25T10:00:00Z', lastContactTime: '2026-09-25T10:04:00Z', status: 'aktiv',
    }
    const suche = { vermisst: 9, openBereiche: [], ask: '9 Personen noch vermisst: Klasse 4b (8), Tim Muster.' }

    it('asks after the crews, names them, and «Zur Suche» is the focused answer that closes nothing', async () => {
      const ask = vi.mocked(confirmDialog)
      ask.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce('alt' as never)
      const openSuche = vi.fn()
      const a = args({ trupps: [inside], suche, openSuche })
      await expect(renderHook(() => useAbschluss(a)).result.current.confirmAndComplete()).resolves.toBe(false)
      expect(ask.mock.calls[0][0].message).toContain('Trupp ist noch drin')
      expect(ask.mock.calls[1][0]).toMatchObject({
        message: suche.ask,
        altLabel: appConfig.copy.suche.abschlussToSuche,
        confirmLabel: appConfig.copy.abschluss.insideClose,
        safeAnswer: 'alt',
      })
      expect(openSuche).toHaveBeenCalled()
      expect(a.onCompleteRapport).not.toHaveBeenCalled()
    })

    it('closing anyway goes on — and the paperwork list does not ask about them a second time', async () => {
      const ask = vi.mocked(confirmDialog)
      ask.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(true)
      const a = args({ suche })
      await expect(renderHook(() => useAbschluss(a)).result.current.confirmAndComplete()).resolves.toBe(true)
      const list = ask.mock.calls[1][0] as { items?: { label: string }[] }
      expect((list.items ?? []).map((i) => i.label).join(' ')).not.toMatch(/vermisst/)
    })

    it('dismissing it does nothing; nobody missing asks nothing', async () => {
      const ask = vi.mocked(confirmDialog)
      ask.mockReset().mockResolvedValueOnce(undefined as never)
      const a = args({ suche })
      await expect(renderHook(() => useAbschluss(a)).result.current.confirmAndComplete()).resolves.toBe(false)
      expect(a.onCompleteRapport).not.toHaveBeenCalled()
      ask.mockReset().mockResolvedValueOnce(true)
      const b = args({ suche: { vermisst: 0, openBereiche: [], ask: null } })
      await renderHook(() => useAbschluss(b)).result.current.confirmAndComplete()
      expect(ask).toHaveBeenCalledTimes(1) // only the Abschluss itself
    })
  })

  // N6 (staging r2): with open points the list's safe answer is the focused one
  it('with open points, «Zurück» is the focused answer and «Trotzdem abschliessen» the quiet one', async () => {
    const ask = vi.mocked(confirmDialog)
    ask.mockReset().mockResolvedValueOnce(false)
    const a = args()
    await renderHook(() => useAbschluss(a)).result.current.confirmAndComplete()
    expect(ask.mock.calls[0][0]).toMatchObject({
      confirmLabel: appConfig.copy.abschluss.confirmAnyway,
      cancelLabel: appConfig.copy.abschluss.confirmBack,
      safeAnswer: 'cancel',
    })
  })
})
