// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ShareIncident } from './ShareIncident'
import { appConfig } from '../../config/appConfig'
import { createShareLink, fetchShareLink, revokeShareLink } from '../../lib/viewLink'

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
