// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PlanAlignmentReview } from './PlanAlignmentReview'
import { alignmentPreview, alignmentThumbnail, approveAlignment, loadAlignmentDetail, loadAlignmentQueue, rejectAlignment, undoAlignmentApproval, type AlignmentItem } from './planAlignmentApi'

vi.mock('./planAlignmentApi', () => ({ loadAlignmentQueue: vi.fn(), loadAlignmentDetail: vi.fn(), alignmentPreview: vi.fn(), alignmentThumbnail: vi.fn(), approveAlignment: vi.fn(), rejectAlignment: vi.fn(), undoAlignmentApproval: vi.fn(), retryAlignment: vi.fn() }))
vi.mock('./AlignmentPreview', () => ({ default: () => <div data-testid="preview" /> }))

const item: AlignmentItem = {
  id: 1, dataset_id: 'plan:object:modul2', plan_version: 3, page: 0, page_count: null, can_approve: false, object_name: 'Testobjekt', module: 'modul2', title: 'Modul 2', is_current: true,
  status: 'ready', edit_version: 5, pairs: [{ plan: { x: .1, y: .2 }, lngLat: { lng: 7.55, lat: 47.51 }, kind: 'auto' }, { plan: { x: .8, y: .9 }, lngLat: { lng: 7.552, lat: 47.509 }, kind: 'auto' }],
  aspect: .7, scale_m_per_u: 150, score: 4, coverage: .8, reason: null, created_at: '2026-09-09T09:00:00Z', updated_at: '2026-09-09T09:00:00Z', approved_at: null, reference_rings: [], reference_source: 'OSM', reference_at: '2026-09-09T08:00:00Z',
}
// the exact revision, as the detail endpoint answers it
const detail: AlignmentItem = { ...item, page_count: 1, can_approve: true }
const queue = (items: AlignmentItem[]) => ({ items, capability: { available: true, reason: null } })
const card = (name: string) => screen.getByRole('listitem', { name: new RegExp(`^${name}`) })

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() })
  vi.mocked(loadAlignmentQueue).mockResolvedValue(queue([{ ...item }]))
  vi.mocked(loadAlignmentDetail).mockResolvedValue(detail)
  vi.mocked(alignmentPreview).mockResolvedValue(new Blob(['png']))
  vi.mocked(alignmentThumbnail).mockResolvedValue(new Blob(['jpg']))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('alignment review wall', () => {
  it('approves from the card only through the exact revision – a summary row never publishes by itself', async () => {
    vi.mocked(loadAlignmentDetail).mockResolvedValueOnce({ ...detail, can_approve: false })
    render(<PlanAlignmentReview compact />)
    const yes = await within(await screen.findByRole('listitem', { name: /^Testobjekt/ })).findByRole('button', { name: '✓ Freigeben' })
    expect(loadAlignmentQueue).toHaveBeenCalledWith(true)
    fireEvent.click(yes)
    await screen.findByRole('alert')
    expect(approveAlignment).not.toHaveBeenCalled()
    vi.mocked(approveAlignment).mockResolvedValue({ ...detail, status: 'approved', edit_version: 6, approved_at: '2026-09-09T10:00:00Z' })
    fireEvent.click(within(card('Testobjekt')).getByRole('button', { name: '✓ Freigeben' }))
    await screen.findByRole('button', { name: 'Freigabe rückgängig' })
    expect(approveAlignment).toHaveBeenCalledWith(detail, detail.pairs)
  })
  it('lets a slow queue read finish instead of starting overlapping polls', async () => {
    let finish: ((next: ReturnType<typeof queue>) => void) | undefined
    vi.mocked(loadAlignmentQueue).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<PlanAlignmentReview compact />)
    expect(loadAlignmentQueue).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Aktualisieren' }))
    expect(loadAlignmentQueue).toHaveBeenCalledTimes(1)
    await act(async () => { finish?.(queue([item])) })
    await screen.findByRole('listitem', { name: /^Testobjekt/ })
  })
  it('keeps the wall filtered: unsupported sheets are not open work, a search hides cards and their decisions', async () => {
    vi.mocked(loadAlignmentQueue).mockResolvedValue(queue([item, { ...item, id: 2, object_name: 'Dokumentation', status: 'unsupported' }]))
    render(<PlanAlignmentReview compact />)
    await screen.findByRole('listitem', { name: /^Testobjekt/ })
    expect(screen.queryByRole('listitem', { name: /^Dokumentation/ })).toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'kein Treffer' } })
    expect(screen.queryByRole('button', { name: '✓ Freigeben' })).toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Alle' }))
    expect(screen.getByRole('listitem', { name: /^Dokumentation/ })).toBeTruthy()
    expect(approveAlignment).not.toHaveBeenCalled()
  })
  it('rejects from the card, says so, and undoes with the latest revision token', async () => {
    const rejected = { ...item, status: 'rejected' as const, edit_version: 6 }
    vi.mocked(rejectAlignment).mockResolvedValue(rejected)
    vi.mocked(undoAlignmentApproval).mockResolvedValue({ ...item, status: 'needs_review', edit_version: 7 })
    render(<PlanAlignmentReview compact />)
    fireEvent.click(await within(await screen.findByRole('listitem', { name: /^Testobjekt/ })).findByRole('button', { name: '✕ Von Hand' }))
    await screen.findByText('Vorschlag für «Testobjekt» abgelehnt – das Blatt wird von Hand ausgerichtet.')
    expect(rejectAlignment).toHaveBeenCalledWith(item)
    // decided sheets leave the open wall and wait under their own filter
    expect(screen.queryByRole('listitem', { name: /^Testobjekt/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Entschieden' }))
    fireEvent.click(within(card('Testobjekt')).getByRole('button', { name: 'Rückgängig' }))
    await waitFor(() => expect(undoAlignmentApproval).toHaveBeenCalledWith(rejected))
  })
  it('approves a whole section one sheet after the other and stops at the first refusal', async () => {
    const second = { ...item, id: 2, object_name: 'Zweites Objekt' }
    vi.mocked(loadAlignmentQueue).mockResolvedValue(queue([item, second]))
    vi.mocked(loadAlignmentDetail).mockImplementation(async id => id === 1 ? detail : { ...second, page_count: 1, can_approve: false })
    vi.mocked(approveAlignment).mockImplementation(async it => ({ ...it, status: 'approved', edit_version: it.edit_version + 1 }))
    render(<PlanAlignmentReview compact />)
    fireEvent.click(await screen.findByRole('button', { name: 'Alle 2 freigeben' }))
    await screen.findByText('1 von 2 Ausrichtungen freigegeben.')
    expect(approveAlignment).toHaveBeenCalledTimes(1)
    expect(approveAlignment).toHaveBeenCalledWith(detail, detail.pairs)
  })
  it('opens the full instrument in a modal from the thumbnail and blocks approval there without the exact preview', async () => {
    vi.mocked(alignmentPreview).mockRejectedValue(new Error('offline'))
    render(<PlanAlignmentReview compact />)
    fireEvent.click(await screen.findByRole('button', { name: 'Gross anzeigen: Testobjekt · Modul 2' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('Planvorschau konnte nicht geladen werden')
    expect(within(dialog).getByRole('button', { name: 'Ausrichtung freigeben' }).hasAttribute('disabled')).toBe(true)
    expect(approveAlignment).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('keeps an adjusted draft in the modal but prevents approval after another admin changes its revision', async () => {
    render(<PlanAlignmentReview compact />)
    fireEvent.click(await screen.findByRole('button', { name: 'Gross anzeigen: Testobjekt · Modul 2' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByTestId('preview')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ausrichtung anpassen' }))
    fireEvent.pointerDown(within(dialog).getAllByRole('button', { name: 'mehr' })[0], { button: 0, pointerId: 1 })
    fireEvent.pointerUp(within(dialog).getAllByRole('button', { name: 'mehr' })[0], { button: 0, pointerId: 1 })
    vi.mocked(loadAlignmentQueue).mockResolvedValue(queue([{ ...item, edit_version: 6 }]))
    vi.mocked(loadAlignmentDetail).mockResolvedValue({ ...detail, edit_version: 6 })
    fireEvent.click(screen.getByRole('button', { name: 'Aktualisieren' }))
    await within(dialog).findByText('Plan oder Ausrichtung wurde zwischenzeitlich geändert. Aktuellen Stand laden und erneut prüfen.')
    // the exact revision is re-read after the refresh; the button returns with it, still blocked
    const approve = await within(dialog).findByRole('button', { name: 'Ausrichtung freigeben' })
    expect(approve.hasAttribute('disabled')).toBe(true)
  })
})
