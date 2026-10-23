// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Deleting an Einsatz takes its Verlauf, Prüfkette and media with it for good, so its guard is a
// modal (ConfirmCard) and not the inline Ja/Nein the re-creatable config rows use (A2, UX sweep).
const { listIncidents, deleteIncident } = vi.hoisted(() => ({ listIncidents: vi.fn(), deleteIncident: vi.fn() }))
vi.mock('../lib/incidents', () => ({ listIncidents, deleteIncident }))

import { IncidentHistoryView } from './IncidentHistoryView'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

const C = appConfig.copy.admin.incidentHistory
const closed = {
  id: 'inc-1', title: 'Brand Gewerbe', address: null, type: null, source: 'manual', status: 'closed',
  is_archived: true, closed_at: '2026-10-01T10:00:00Z', is_exercise: false, report_done_at: null,
  started_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T10:00:00Z',
}

afterEach(cleanup)

describe('IncidentHistoryView — deleting an Einsatz', () => {
  it('opens a modal on the first tap and deletes nothing until it is confirmed', async () => {
    listIncidents.mockResolvedValue([closed])
    deleteIncident.mockResolvedValue(undefined)
    render(<IncidentHistoryView />)
    fireEvent.click(await screen.findByLabelText(fillTemplate(C.deleteAria, { title: closed.title })))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain(fillTemplate(C.deleteQuestion, { title: closed.title }))
    expect(deleteIncident).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText(appConfig.copy.admin.common2.cancel))
    expect(deleteIncident).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText(fillTemplate(C.deleteAria, { title: closed.title })))
    const again = await screen.findByRole('alertdialog')
    fireEvent.click(Array.from(again.querySelectorAll('button')).find((b) => b.textContent === C.delete)!)
    await waitFor(() => expect(deleteIncident).toHaveBeenCalledWith('inc-1'))
  })
})
