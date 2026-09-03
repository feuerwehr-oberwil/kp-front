// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// The secret-token trio (admin/ui · useSecret + SecretCard) now backs THREE admin surfaces —
// the Statistik-Export token, the Einsatz-Link minting key and the Erfassungs-Poster secret.
// What this file pins is the contract those three depend on, and nothing else:
//
//   · the endpoints are derived from `basePath` alone — GET <basePath>, POST <basePath>/rotate,
//     DELETE <basePath>. A card pointed at the wrong resource rotates somebody else's secret.
//   · «Deaktivieren» clears the value on screen. The token is handed out ONCE; a card that
//     kept showing it after the off switch would leave a dead secret looking live, and the
//     copy button beside it hands that dead value to whoever is setting up the other system.
//   · `report()` reaches the card's own result chip — CaptureAdminView is its only consumer,
//     and it is how «Poster konnte nicht erzeugt werden» is ever said at all.

const { apiGet, apiPost, apiDelete } = vi.hoisted(() => ({
  apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(),
}))
vi.mock('../lib/api', () => ({ apiGet, apiPost, apiDelete }))

const { downloadPosterPdf } = vi.hoisted(() => ({ downloadPosterPdf: vi.fn() }))
vi.mock('./capturePdf', () => ({ downloadPosterPdf, downloadSheetPdf: vi.fn() }))

import { IncidentLinkAdminView } from './IncidentLinkAdminView'
import { CaptureAdminView } from './CaptureAdminView'
import { appConfig } from '../config/appConfig'

const L = appConfig.copy.admin.einsatzlink
const E = appConfig.copy.admin.erfassung
const COMMON = appConfig.copy.admin.common

afterEach(() => { cleanup(); vi.clearAllMocks() })

/** Arm a two-step ConfirmButton and answer it — how every destructive admin action is taken. */
function confirm(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(screen.getByRole('button', { name: COMMON.confirmYes }))
}

describe('secret-token card — the contract three admin surfaces share', () => {
  it('reads, rotates and deletes exactly its own basePath', async () => {
    apiGet.mockResolvedValue({ configured: false })
    apiPost.mockResolvedValue({ configured: true, token: 'k-1' })
    apiDelete.mockResolvedValue(undefined)
    render(<IncidentLinkAdminView />)

    await waitFor(() => expect(screen.getByText(L.enableBtn)).toBeTruthy())
    expect(apiGet).toHaveBeenCalledWith('/api/incident-link/secret')

    fireEvent.click(screen.getByRole('button', { name: L.enableBtn }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/incident-link/secret/rotate', {}))

    confirm(L.disableBtn)
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/api/incident-link/secret'))
  })

  it('shows the freshly minted value once, and «Deaktivieren» takes it off the screen', async () => {
    apiGet.mockResolvedValue({ configured: false })
    apiPost.mockResolvedValue({ configured: true, token: 'k-1' })
    apiDelete.mockResolvedValue(undefined)
    render(<IncidentLinkAdminView />)
    await waitFor(() => expect(screen.getByText(L.enableBtn)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: L.enableBtn }))
    // the value, and the line the other system needs built around it
    await waitFor(() => expect(screen.getByText(`${L.keyLabel}: k-1`)).toBeTruthy())
    expect(screen.getByText(L.exampleLabel, { exact: false })).toBeTruthy()

    confirm(L.disableBtn)
    await waitFor(() => expect(screen.getByText(L.stateOff)).toBeTruthy())
    expect(screen.queryByText(`${L.keyLabel}: k-1`)).toBeNull()
    expect(screen.queryByText(L.exampleLabel, { exact: false })).toBeNull()
  })

  it('says a failed poster on the card, through report()', async () => {
    apiGet.mockResolvedValue({ configured: false })
    apiPost.mockResolvedValue({ configured: true, token: 'p-1' })
    downloadPosterPdf.mockRejectedValue(new Error('jsPDF unavailable'))
    render(<CaptureAdminView />)
    await waitFor(() => expect(screen.getByText(E.enableBtn)).toBeTruthy())

    // the poster button only exists once there is a token to put on it
    fireEvent.click(screen.getByRole('button', { name: E.enableBtn }))
    await waitFor(() => expect(screen.getByText(E.printBtn)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: E.printBtn }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(E.failed))
  })
})
