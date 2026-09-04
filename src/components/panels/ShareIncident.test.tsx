// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ShareIncident } from './ShareIncident'
import { appConfig } from '../../config/appConfig'
import { createShareLink, fetchShareLink, revokeShareLink, type ShareLink } from '../../lib/viewLink'

// «Teilen» is ONE surface with TWO doors, and its tabs are the chooser — there is no menu in
// front of it any more (03.09.). What is worth pinning is what makes handing a link out safe
// rather than what it looks like:
//   1. Opening the surface never mints a link — only the button that says so does.
//   2. Wherever the address is shown, the sentence saying what it hands over is shown WITH it —
//      and it is the sentence of the door actually selected.
//   3. Revoking asks first, and only revokes on a yes.
//   4. Each door talks to its own link; switching never re-asks for one already fetched.
//   5. A closed Einsatz is never offered the Atemschutz door: that link is dead (404).

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

describe('«Ganzer Einsatz – nur lesen»', () => {
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

  // ⚠️ This lede is the ONLY place the read-only link is explained, and since it replaced the
  // second read-only link it has to name both audiences and both lifetimes — the one before the
  // Abschluss and the one long after it. Somebody who reads only half of it used to reach for
  // the other link; there is no other link any more.
  it('names both audiences and both lifetimes, with a link and without one', async () => {
    render(<ShareIncident incidentId="i1" />)
    const before = await screen.findByText(C.shareLede)
    expect(before.textContent).toMatch(/Abschluss/)

    cleanup()
    vi.mocked(fetchShareLink).mockResolvedValue(on)
    render(<ShareIncident incidentId="i1" />)
    const after = await screen.findByText(C.shareLiveLede)
    expect(after.textContent).toMatch(/Abschluss/)
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
  it('opens on the door the entry point meant, with that door’s sentences', async () => {
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

  it('revokes the Atemschutz link from its own side of the switch', async () => {
    vi.mocked(fetchShareLink).mockResolvedValue(on)
    confirmDialog.mockResolvedValue(true)
    render(<ShareIncident incidentId="i1" initialKind="atemschutz" />)
    await screen.findByText(/\/l\/tok123$/)

    fireEvent.click(screen.getByText(C.shareRevoke))
    await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith('i1', 'atemschutz'))
  })

  // Switching must be instant in BOTH directions — a «noch keiner» flash over a link that exists
  // is how somebody mints a second one by mistake. Both doors are fetched once, on mount, and
  // no switch adds a call.
  it('remembers each door’s state instead of re-asking', async () => {
    render(<ShareIncident incidentId="i1" />)
    await screen.findByText(C.shareLede)
    fireEvent.click(screen.getByText(C.shareKindAtem))
    await screen.findByText(C.shareAsLede)
    fireEvent.click(screen.getByText(C.shareKindFull))
    await screen.findByText(C.shareLede)
    expect(vi.mocked(fetchShareLink).mock.calls).toEqual([['i1', 'view'], ['i1', 'atemschutz']])
  })

  /* ⚠️ The flash from the field (04.09.): the first switch swapped in a door nothing had been
   * asked about yet, so the sheet drew the whole «Link erstellen» block over a link that existed
   * and jumped to the QR a moment later. Beyond the ugliness, the button standing there MINTS —
   * a fast thumb in that window rotates an address somebody had already been given. */
  it('never falls back to «Link erstellen» when switching to a door that has one', async () => {
    vi.mocked(fetchShareLink).mockResolvedValue(on)
    render(<ShareIncident incidentId="i1" />)
    await screen.findByText(/\/l\/tok123$/)

    fireEvent.click(screen.getByText(C.shareKindAtem))
    expect(screen.getByText(C.shareAsLiveLede)).toBeTruthy()
    expect(screen.queryByText(C.shareCreate)).toBeNull()
    expect(createShareLink).not.toHaveBeenCalled()
  })

  /* ⚠️ …and the same trap through the OTHER door (04.09., field report): the sheet was reopened
   * and stood on «Link erstellen» although a link existed; creating again then produced the QR.
   * The mount fetch swallowed every rejection in a bare `.catch(() => {})`, so a door whose GET
   * failed kept an undefined cache entry — «nicht gefragt» forever, and the sheet either sat on
   * «wird geladen» or dropped to the create layout. Nothing about a failed GET says there is no
   * link, so neither layout may be drawn: the failure is stated and the question offered again. */
  it('never offers «Link erstellen» when the state could not be loaded at all', async () => {
    vi.mocked(fetchShareLink).mockRejectedValue(new Error('offline'))
    render(<ShareIncident incidentId="i1" />)

    await screen.findByText(C.shareLoadFailed)
    expect(screen.queryByText(C.shareCreate)).toBeNull()
    // …and it does not sit on the spinner either: that state promises an answer is coming
    expect(screen.queryByText(C.shareLoading)).toBeNull()
    expect(createShareLink).not.toHaveBeenCalled()
  })

  it('asks again on «Nochmals versuchen», and shows the link that was there all along', async () => {
    vi.mocked(fetchShareLink).mockRejectedValue(new Error('offline'))
    render(<ShareIncident incidentId="i1" />)
    await screen.findByText(C.shareLoadFailed)

    vi.mocked(fetchShareLink).mockResolvedValue(on)
    fireEvent.click(screen.getByText(C.shareRetry))

    await screen.findByText(/\/l\/tok123$/)
    // the failure leaves no trace once an answer lands
    expect(screen.queryByText(C.shareLoadFailed)).toBeNull()
    expect(createShareLink).not.toHaveBeenCalled()
  })

  // One door failing must not take the other one's answer down with it — they are separate
  // requests and the tabs are how somebody gets to the one that did work.
  it('keeps a door that loaded when the other one’s request failed', async () => {
    vi.mocked(fetchShareLink).mockImplementation(async (_id, kind) => {
      if (kind === 'atemschutz') throw new Error('offline')
      return on
    })
    render(<ShareIncident incidentId="i1" />)
    await screen.findByText(/\/l\/tok123$/)

    fireEvent.click(screen.getByText(C.shareKindAtem))
    expect(screen.getByText(C.shareLoadFailed)).toBeTruthy()
    fireEvent.click(screen.getByText(C.shareKindFull))
    expect(screen.getByText(/\/l\/tok123$/)).toBeTruthy()
  })

  it('offers nothing to press while a door’s state is still unknown', async () => {
    let answer!: (l: ShareLink) => void
    vi.mocked(fetchShareLink).mockReturnValue(new Promise<ShareLink>((r) => { answer = r }))
    render(<ShareIncident incidentId="i1" />)
    // «noch nicht gefragt» is not «gibt es keinen»: no mint button, no address, no claim either way
    expect(screen.getByText(C.shareLoading)).toBeTruthy()
    expect(screen.queryByText(C.shareCreate)).toBeNull()
    expect(screen.queryByText(C.shareLede)).toBeNull()

    answer(off)
    await screen.findByText(C.shareCreate)
  })
})

// The Atemschutz link dies with the Einsatz — a closed incident answers 404 — while the
// read-only one is precisely the one somebody comes back for days later. So after the Abschluss
// the sheet has one door, and it must not show a chooser leading to an address that never worked.
describe('nach dem Abschluss', () => {
  it('offers the read-only link alone, with no choice left to make', async () => {
    render(<ShareIncident incidentId="i1" archived />)
    await screen.findByText(C.shareLede)
    expect(screen.queryByText(C.shareKindAtem)).toBeNull()
    expect(screen.queryByText(C.shareKindFull)).toBeNull()
    expect(fetchShareLink).toHaveBeenCalledWith('i1', 'view')
    expect(fetchShareLink).not.toHaveBeenCalledWith('i1', 'atemschutz')
  })

  it('falls back to the read-only link even for a door that meant the Atemschutz one', async () => {
    // the QR beside the bell hands over `initialKind`; on a closed Einsatz there would be no
    // tabs to get back off a dead surface
    render(<ShareIncident incidentId="i1" initialKind="atemschutz" archived />)
    await screen.findByText(C.shareLede)
    expect(fetchShareLink).not.toHaveBeenCalledWith('i1', 'atemschutz')
  })
})
