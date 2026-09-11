// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PlanAlignmentReview } from './PlanAlignmentReview'
import { alignmentPreview, approveAlignment, loadAlignmentDetail, loadAlignmentQueue, undoAlignmentApproval, type AlignmentItem } from './planAlignmentApi'

vi.mock('./planAlignmentApi', () => ({ loadAlignmentQueue: vi.fn(), loadAlignmentDetail: vi.fn(), alignmentPreview: vi.fn(), approveAlignment: vi.fn(), undoAlignmentApproval: vi.fn(), retryAlignment: vi.fn() }))
vi.mock('./AlignmentPreview', () => ({ default: () => <div data-testid="preview" /> }))

const item: AlignmentItem = {
  id: 1, dataset_id: 'plan:object:modul2', plan_version: 3, page: 0, page_count: 1, can_approve: true, object_name: 'Testobjekt', module: 'modul2', title: 'Modul 2', is_current: true,
  status: 'ready', edit_version: 5, pairs: [{ plan: { x: .1, y: .2 }, lngLat: { lng: 7.55, lat: 47.51 }, kind: 'auto' }, { plan: { x: .8, y: .9 }, lngLat: { lng: 7.552, lat: 47.509 }, kind: 'auto' }],
  aspect: .7, scale_m_per_u: 150, score: 4, coverage: .8, reason: null, created_at: '2026-09-09T09:00:00Z', updated_at: '2026-09-09T09:00:00Z', approved_at: null, reference_rings: [], reference_source: 'OSM', reference_at: '2026-09-09T08:00:00Z',
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() })
  vi.mocked(loadAlignmentQueue).mockResolvedValue({ items: [{ ...item }], capability: { available: true, reason: null } })
  vi.mocked(loadAlignmentDetail).mockResolvedValue(item)
  vi.mocked(alignmentPreview).mockResolvedValue(new Blob(['png']))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('alignment review publication', () => {
  it('never enables summary-row approval before exact revision metadata arrives', async () => {
    vi.mocked(loadAlignmentQueue).mockResolvedValue({ items: [{ ...item, page_count: null, can_approve: false }], capability: { available: true, reason: null } })
    let finish: ((next: AlignmentItem) => void) | undefined
    vi.mocked(loadAlignmentDetail).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<PlanAlignmentReview compact />)
    await screen.findByRole('button', { name: 'Testobjekt' })
    expect(loadAlignmentQueue).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('button', { name: 'Ausrichtung freigeben' })).toBeNull()
    await act(async () => { finish?.(item) })
    const approve = await screen.findByRole('button', { name: 'Ausrichtung freigeben' })
    await waitFor(() => expect(approve.hasAttribute('disabled')).toBe(false))
    expect(approveAlignment).not.toHaveBeenCalled()
  })
  it('lets a slow queue read finish instead of starting overlapping polls', async () => {
    let finish: ((queue: Awaited<ReturnType<typeof loadAlignmentQueue>>) => void) | undefined
    vi.mocked(loadAlignmentQueue).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<PlanAlignmentReview compact />)
    expect(loadAlignmentQueue).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Aktualisieren' }))
    expect(loadAlignmentQueue).toHaveBeenCalledTimes(1)
    await act(async () => { finish?.({ items: [item], capability: { available: true, reason: null } }) })
    await screen.findByTestId('preview')
  })
  it('keeps the compact review selection inside its filtered table and omits unsupported plans from open work', async () => {
    vi.mocked(loadAlignmentQueue).mockResolvedValue({ items: [item, { ...item, id: 2, object_name: 'Dokumentation', status: 'unsupported', can_approve: false }], capability: { available: true, reason: null } })
    render(<PlanAlignmentReview compact />)
    await screen.findByTestId('preview')
    expect(screen.queryByRole('button', { name: 'Dokumentation' })).toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'kein Treffer' } })
    expect(screen.queryByRole('button', { name: 'Ausrichtung freigeben' })).toBeNull()
    expect(approveAlignment).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Alle' }))
    expect(screen.getByRole('button', { name: 'Dokumentation' })).toBeTruthy()
  })
  it('does not publish on selection; approval and undo use the latest revision token', async () => {
    const approved = { ...item, status: 'approved' as const, can_approve: false, edit_version: 6, approved_at: '2026-09-09T10:00:00Z' }
    vi.mocked(approveAlignment).mockResolvedValue(approved)
    vi.mocked(undoAlignmentApproval).mockResolvedValue({ ...item, edit_version: 7 })
    render(<PlanAlignmentReview />)
    const approve = await screen.findByRole('button', { name: 'Ausrichtung freigeben' })
    await waitFor(() => expect(approve.hasAttribute('disabled')).toBe(false))
    expect(approveAlignment).not.toHaveBeenCalled()
    fireEvent.click(approve)
    await screen.findByRole('button', { name: 'Freigabe rückgängig' })
    expect(approveAlignment).toHaveBeenCalledWith(item, item.pairs)
    fireEvent.click(screen.getByRole('button', { name: 'Freigabe rückgängig' }))
    await waitFor(() => expect(undoAlignmentApproval).toHaveBeenCalledWith(approved))
  })
  it('blocks approval when the exact preview cannot be loaded', async () => {
    vi.mocked(alignmentPreview).mockRejectedValue(new Error('offline'))
    render(<PlanAlignmentReview />)
    await screen.findByText('Planvorschau konnte nicht geladen werden')
    expect(screen.getByRole('button', { name: 'Ausrichtung freigeben' }).hasAttribute('disabled')).toBe(true)
    expect(approveAlignment).not.toHaveBeenCalled()
  })
  it('keeps an adjusted draft but prevents approval after another admin changes its revision', async () => {
    render(<PlanAlignmentReview />)
    await screen.findByTestId('preview')
    fireEvent.click(screen.getByRole('button', { name: 'Ausrichtung anpassen' }))
    fireEvent.pointerDown(screen.getAllByRole('button', { name: 'mehr' })[0], { button: 0, pointerId: 1 })
    fireEvent.pointerUp(screen.getAllByRole('button', { name: 'mehr' })[0], { button: 0, pointerId: 1 })
    vi.mocked(loadAlignmentQueue).mockResolvedValue({ items: [{ ...item, edit_version: 6 }], capability: { available: true, reason: null } })
    fireEvent.click(screen.getByRole('button', { name: 'Aktualisieren' }))
    await screen.findByText('Plan oder Ausrichtung wurde zwischenzeitlich geändert. Aktuellen Stand laden und erneut prüfen.')
    expect(screen.getByRole('button', { name: 'Ausrichtung freigeben' }).hasAttribute('disabled')).toBe(true)
  })
})
