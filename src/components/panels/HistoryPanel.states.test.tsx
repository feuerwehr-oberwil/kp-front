// @vitest-environment jsdom
// «Alle Einsätze» tells loading, offline, failed and empty apart (duck sweep LISTS.1, 17.11.2026):
// the FU in the cellar read «Noch keine Einsätze» offline and took yesterday's Einsatz for gone.
// Its rows carry the menu's red Atemschutz word (LISTS.2), and every lifecycle confirm names the
// Einsatz it acts on (LISTS.11).
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../../config/appConfig'
import { ApiError } from '../../lib/api'
import type { IncidentMeta } from '../../lib/incidents'

const listIncidents = vi.fn()
const readCachedIncidentList = vi.fn()
const confirmDialog = vi.fn(async (_o: unknown) => false)
vi.mock('../../lib/ui', async (orig) => ({
  ...(await orig<typeof import('../../lib/ui')>()),
  confirmDialog: (o: unknown) => confirmDialog(o),
}))
vi.mock('../../lib/incidents', async (orig) => ({
  ...(await orig<typeof import('../../lib/incidents')>()),
  listIncidents: () => listIncidents(),
  readCachedIncidentList: () => readCachedIncidentList(),
}))

import { HistoryPanel } from './HistoryPanel'

const meta = (over: Partial<IncidentMeta>): IncidentMeta => ({
  id: 'a1', divera_id: null, title: 'Zimmerbrand', type: null, priority: null, address: 'Schlossgasse 9', lat: null, lng: null,
  status: 'offen', source: 'manual', source_ref: null, auto_opened: false, started_at: '2026-11-16T23:58:00Z',
  closed_at: null, is_archived: false, is_exercise: false, report_done_at: null, ...over,
} as IncidentMeta)
const h = appConfig.copy.history

afterEach(() => { cleanup(); listIncidents.mockReset(); readCachedIncidentList.mockReset(); confirmDialog.mockClear() })

describe('«Alle Einsätze» list states', () => {
  it('loading is not empty', () => {
    listIncidents.mockReturnValue(new Promise(() => {}))
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} />)
    expect(screen.getByText(h.loading)).toBeTruthy()
    expect(screen.queryByText(h.empty)).toBeNull()
  })

  it('offline shows the cached running list, says what is missing, and offers a retry', async () => {
    listIncidents.mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
    readCachedIncidentList.mockResolvedValue([meta({ atemschutz_due: [{ id: 't1', name: 'Trupp 1', reason: 'contact' }] })])
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} />)
    expect(await screen.findByText(h.offlineCached)).toBeTruthy()
    expect(screen.getByText('Zimmerbrand')).toBeTruthy()
    // a cached alarm tier is as old as the cache – never shown as if it were now
    expect(screen.queryByText(appConfig.copy.atemschutz.foreign.mark)).toBeNull()
    expect(screen.queryByText(h.empty)).toBeNull()
    listIncidents.mockResolvedValue([])
    fireEvent.click(screen.getByRole('button', { name: h.retry }))
    expect(await screen.findByText(h.empty)).toBeTruthy()
  })

  it('offline with nothing cached says so – not «Noch keine Einsätze»', async () => {
    listIncidents.mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
    readCachedIncidentList.mockResolvedValue([])
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} />)
    expect(await screen.findByText(h.offlineNothing)).toBeTruthy()
    expect(screen.queryByText(h.empty)).toBeNull()
  })

  it('a refusal is a failure with a retry, not an empty list', async () => {
    listIncidents.mockRejectedValue(new ApiError(500, 'kaputt'))
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} />)
    expect(await screen.findByText(h.loadFailed)).toBeTruthy()
    expect(screen.getByRole('button', { name: h.retry })).toBeTruthy()
    expect(screen.queryByText(h.empty)).toBeNull()
  })
})

describe('«Alle Einsätze» rows', () => {
  it('a running Einsatz with a Trupp at the alarm tier carries the red word, as in the menu', async () => {
    listIncidents.mockResolvedValue([meta({ atemschutz_due: [{ id: 't1', name: 'Trupp 1', reason: 'contact' }] })])
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} />)
    expect(await screen.findByText(appConfig.copy.atemschutz.foreign.mark)).toBeTruthy()
  })

  it('«Wieder öffnen» and «Löschen» confirm by naming the Einsatz', async () => {
    listIncidents.mockResolvedValue([meta({ is_archived: true, is_exercise: true, exercise_since_creation: true, status: 'abgeschlossen' } as Partial<IncidentMeta>)])
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} onArchive={async () => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: h.reactivate }))
    fireEvent.click(screen.getByRole('button', { name: h.deleteConfirmTitle }))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(2))
    for (const [o] of confirmDialog.mock.calls) {
      expect((o as { subject: { head: string } }).subject.head).toBe('Zimmerbrand · Übung')
    }
  })
})
