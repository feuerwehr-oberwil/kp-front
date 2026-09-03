// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { EinsatzLinkSheet, ShareIncident, TeilenSheet } from './ShareIncident'
import { appConfig } from '../../config/appConfig'
import { ApiError } from '../../lib/api'
import { createShareLink, fetchShareLink, mintEinsatzLink, revokeShareLink } from '../../lib/viewLink'

// The Einsatz-Link now has three doors (Rapport · Einsatz-Karte · Atemschutz-Tafel), two KINDS
// and one implementation. What is worth pinning is what makes handing one out safe rather than
// what it looks like:
//   1. Opening the surface never mints a link — only the button that says so does.
//   2. Wherever the address is shown, the sentence saying what it hands over is shown WITH it —
//      and it is the sentence of the kind actually selected.
//   3. Revoking asks first, and only revokes on a yes.
//   4. Each kind talks to its own link; switching never re-asks for one already fetched.

vi.mock('../../lib/viewLink', async (orig) => ({
  ...(await orig<typeof import('../../lib/viewLink')>()),
  fetchShareLink: vi.fn(),
  createShareLink: vi.fn(),
  revokeShareLink: vi.fn(),
  mintEinsatzLink: vi.fn(),
}))
// jsdom has no canvas, and the QR is decorative — the address below it is the real payload.
vi.mock('qrcode', () => ({ toDataURL: vi.fn(async () => 'data:image/png;base64,QQ==') }))

const confirmDialog = vi.fn()
vi.mock('../../lib/ui', () => ({ confirmDialog: (...a: unknown[]) => confirmDialog(...a), toast: vi.fn() }))

const C = appConfig.copy.preflight
const off = { enabled: false, token: null }
const on = { enabled: true, token: 'tok123' }

beforeEach(() => {
  vi.mocked(fetchShareLink).mockReset().mockResolvedValue(off)
  vi.mocked(createShareLink).mockReset().mockResolvedValue(on)
  vi.mocked(revokeShareLink).mockReset().mockResolvedValue(off)
  vi.mocked(mintEinsatzLink).mockReset().mockResolvedValue(on)
  confirmDialog.mockReset()
})
afterEach(cleanup)

describe('«Weitergeben» — der Einsatz-Link', () => {
  it('mints nothing on open: the address appears only after «Link erstellen»', async () => {
    render(<ShareIncident incidentId="i1" />)
    await screen.findByText(C.shareCreate)
    expect(createShareLink).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText(C.shareCreate))
    await waitFor(() => expect(screen.getByText(/\/l\/tok123$/)).toBeTruthy())
    expect(createShareLink).toHaveBeenCalledWith('i1', 'view')
  })

  it('shows what the link hands over wherever the address is shown', async () => {
    vi.mocked(fetchShareLink).mockResolvedValue(on)
    render(<ShareIncident incidentId="i1" />)
    await screen.findByText(/\/l\/tok123$/)
    expect(screen.getByText(C.shareWarn)).toBeTruthy()
  })

  it('asks before revoking, and keeps the link when the answer is no', async () => {
    vi.mocked(fetchShareLink).mockResolvedValue(on)
    confirmDialog.mockResolvedValue(false)
    render(<ShareIncident incidentId="i1" />)
    await screen.findByText(/\/l\/tok123$/)

    fireEvent.click(screen.getByText(C.shareRevoke))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled())
    expect(revokeShareLink).not.toHaveBeenCalled()
    expect(screen.getByText(/\/l\/tok123$/)).toBeTruthy()

    confirmDialog.mockResolvedValue(true)
    fireEvent.click(screen.getByText(C.shareRevoke))
    await waitFor(() => expect(screen.getByText(C.shareCreate)).toBeTruthy())
    expect(revokeShareLink).toHaveBeenCalledWith('i1', 'view')
  })
})

describe('… und «Nur Atemschutz – bedienen»', () => {
  it('opens on the kind the door meant, with that kind’s sentences', async () => {
    render(<ShareIncident incidentId="i1" initialKind="atemschutz" />)
    await screen.findByText(C.shareAsLede)
    expect(fetchShareLink).toHaveBeenCalledWith('i1', 'atemschutz')
    // ⚠️ the read-only link's warning must not be the one standing over an operable board
    expect(screen.queryByText(C.shareLede)).toBeNull()
  })

  it('mints the Atemschutz link, not the view link, from that side of the switch', async () => {
    render(<ShareIncident incidentId="i1" />)
    await screen.findByText(C.shareCreate)

    fireEvent.click(screen.getByText(C.shareKindAtem))
    await screen.findByText(C.shareAsLede)
    fireEvent.click(screen.getByText(C.shareCreate))

    await waitFor(() => expect(screen.getByText(C.shareAsWarn)).toBeTruthy())
    expect(createShareLink).toHaveBeenCalledWith('i1', 'atemschutz')
    expect(createShareLink).not.toHaveBeenCalledWith('i1', 'view')
  })

  // Switching back must be instant — a second «noch keiner» flash over a link that exists is
  // how somebody mints a second one by mistake.
  it('remembers each kind’s state instead of re-asking', async () => {
    render(<ShareIncident incidentId="i1" />)
    await screen.findByText(C.shareLede)
    fireEvent.click(screen.getByText(C.shareKindAtem))
    await screen.findByText(C.shareAsLede)
    fireEvent.click(screen.getByText(C.shareKindFull))
    await screen.findByText(C.shareLede)
    expect(vi.mocked(fetchShareLink).mock.calls).toEqual([['i1', 'view'], ['i1', 'atemschutz']])
  })
})

// The Teilen menu's «Einsatz-Link (nur lesen)». It mints on open — that is what the menu entry
// said it would do, and the address is derived, so asking twice is not a second link. The one
// thing it must never do is fail silently: a station that never set the Link-Schlüssel up has to
// be told where to set it up, because nobody can fix that from the Schadenplatz.
describe('«Einsatz-Link (nur lesen)»', () => {
  it('mints on open and shows the address to hand over, with what it discloses', async () => {
    render(<EinsatzLinkSheet incidentId="i1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/\/l\/tok123$/)).toBeTruthy())
    expect(mintEinsatzLink).toHaveBeenCalledWith('i1')
    expect(screen.getByText(C.shareStationWarn)).toBeTruthy()
    // …and nothing on it offers to revoke: the address ends with the Abschluss, not with a button
    expect(screen.queryByText(C.shareRevoke)).toBeNull()
  })

  it('sends the operator to der Verwaltung when the station has no Link-Schlüssel', async () => {
    // …and it keys on the backend's CODE, not on the bare 403 — see the next case for why.
    const e = new ApiError(403, 'Einsatz-Links deaktiviert')
    e.code = 'link_key_missing'
    vi.mocked(mintEinsatzLink).mockRejectedValue(e)
    render(<EinsatzLinkSheet incidentId="i1" onClose={() => {}} />)
    await screen.findByText(C.shareStationSetup)
    expect(screen.queryByText(C.shareStationFailed)).toBeNull()
  })

  it('does not send an unauthorised account to der Verwaltung — that screen cannot help it', async () => {
    vi.mocked(mintEinsatzLink).mockRejectedValue(new ApiError(403, 'Bearbeiter-Berechtigung erforderlich'))
    render(<EinsatzLinkSheet incidentId="i1" onClose={() => {}} />)
    await screen.findByText(C.shareStationDenied)
    expect(screen.queryByText(C.shareStationSetup)).toBeNull()
    expect(screen.queryByText(C.shareStationFailed)).toBeNull()
  })

  it('says «zu spät» on a finished Einsatz instead of offering an impossible retry', async () => {
    vi.mocked(mintEinsatzLink).mockRejectedValue(new ApiError(409, 'Einsatz ist abgeschlossen'))
    render(<EinsatzLinkSheet incidentId="i1" onClose={() => {}} />)
    await screen.findByText(C.shareStationClosed)
    expect(screen.queryByText(C.shareStationFailed)).toBeNull()
  })

  it('says «nochmals versuchen» for anything that is not that', async () => {
    vi.mocked(mintEinsatzLink).mockRejectedValue(new ApiError(0, 'offline'))
    render(<EinsatzLinkSheet incidentId="i1" onClose={() => {}} />)
    await screen.findByText(C.shareStationFailed)
  })
})

// The phone's way in (and the Einsatz-Karte's «Teilen»), where the Einsatzkopf's dropdown does
// not fit. It is a fork in the road, not a surface: it must offer the SAME three rows the
// dropdown does — a phone offered fewer links is the state this consolidation replaced — and it
// must never mint anything by being opened.
describe('«Teilen» — die Auswahl auf dem Handy', () => {
  const T = appConfig.copy.topBar

  it('offers the same three links as the Einsatzkopf, and mints none of them', () => {
    const onPick = vi.fn()
    render(<TeilenSheet onPick={onPick} onClose={() => {}} />)
    for (const label of [T.shareEinsatz, T.shareAtemschutz, T.shareRapport]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(mintEinsatzLink).not.toHaveBeenCalled()
    expect(createShareLink).not.toHaveBeenCalled()
    expect(fetchShareLink).not.toHaveBeenCalled()
  })

  it('hands the chosen door back instead of opening one itself', () => {
    const onPick = vi.fn()
    render(<TeilenSheet onPick={onPick} onClose={() => {}} />)
    fireEvent.click(screen.getByText(T.shareRapport))
    expect(onPick).toHaveBeenCalledWith('view')
  })

  it('offers only the Rapport-Link once the Einsatz is abgeschlossen', () => {
    // The other two die with the Einsatz (409 / 404), so offering them after the Abschluss is
    // offering an address that never worked. The Rapport-Link outlives it — and is the one
    // somebody comes back for days later — so the sheet stays, with that row alone.
    render(<TeilenSheet archived onPick={() => {}} onClose={() => {}} />)
    expect(screen.getByText(T.shareRapport)).toBeTruthy()
    expect(screen.queryByText(T.shareEinsatz)).toBeNull()
    expect(screen.queryByText(T.shareAtemschutz)).toBeNull()
  })
})
