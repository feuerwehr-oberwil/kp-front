// @vitest-environment jsdom
// 05.10.2026, owner's Übung in airplane mode: «Wieder öffnen» from «Alle Einsätze» failed with no
// word at all (an unhandled rejection). Reopening stays a server call — the server writes the
// reopen boundary the Atemschutz clocks restart from — so offline it has to SAY what it needs.
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../../config/appConfig'
import { ApiError } from '../../lib/api'

const toast = vi.fn()
const reactivateIncident = vi.fn()
vi.mock('../../lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/ui')>()),
  toast: (...a: unknown[]) => toast(...a),
  confirmDialog: async () => true,
}))
vi.mock('../../lib/incidents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/incidents')>()),
  listIncidents: async () => [{
    id: 'a1', title: 'Brand Scheune', status: 'abgeschlossen', is_archived: true, is_exercise: false,
    address: 'Musterweg 1', started_at: '2026-09-20T10:00:00Z', closed_at: '2026-09-20T11:30:00Z',
  }],
  reactivateIncident: (...a: unknown[]) => reactivateIncident(...a),
}))

import { HistoryPanel } from './HistoryPanel'

afterEach(() => { cleanup(); toast.mockReset(); reactivateIncident.mockReset() })

describe('«Alle Einsätze» · «Wieder öffnen» without a server', () => {
  it('says it needs the server and does not open the Einsatz', async () => {
    reactivateIncident.mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
    const onOpen = vi.fn()
    render(<HistoryPanel onClose={() => {}} onOpen={onOpen} onArchive={async () => {}} />)
    const btn = await screen.findByRole('button', { name: appConfig.copy.history.reactivate })
    fireEvent.click(btn)
    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(toast.mock.calls[0][0]).toBe(appConfig.copy.archived.reactivateNeedsServer)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('a refusal keeps the server’s own words', async () => {
    reactivateIncident.mockRejectedValue(new ApiError(403, 'Bearbeiter-Berechtigung erforderlich'))
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} onArchive={async () => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: appConfig.copy.history.reactivate }))
    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(toast.mock.calls[0][0]).toBe('Bearbeiter-Berechtigung erforderlich')
  })

  it('shows the start and end of each Einsatz in its row', async () => {
    render(<HistoryPanel onClose={() => {}} onOpen={() => {}} />)
    await screen.findByText('Brand Scheune')
    expect(document.querySelector('.ip-hist-when')?.textContent).toMatch(/\d\d:\d\d–\d\d:\d\d · 1\u00a0h\u00a030/)
  })
})
