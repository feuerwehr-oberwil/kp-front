// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError } from '../lib/api'
import { PlanAlignmentEditor, PlanAlignmentReview } from './PlanAlignmentReview'
import { alignmentPreview, alignmentThumbnail, approveAlignment, loadAlignmentDetail, loadAlignmentOutline, loadAlignmentQueue, rejectAlignment, undoAlignmentApproval, savePlanFloors, alignmentPagePreview, type AlignmentItem, type AlignmentListItem } from './planAlignmentApi'

vi.mock('./planAlignmentApi', () => ({ savePlanFloors: vi.fn(), alignmentPagePreview: vi.fn(), loadAlignmentQueue: vi.fn(), loadAlignmentDetail: vi.fn(), loadAlignmentOutline: vi.fn(), alignmentPreview: vi.fn(), alignmentThumbnail: vi.fn(), approveAlignment: vi.fn(), rejectAlignment: vi.fn(), undoAlignmentApproval: vi.fn(), retryAlignment: vi.fn() }))
vi.mock('./AlignmentPreview', () => ({ default: () => <div data-testid="preview" /> }))
// the by-hand half is the field's pairing mode (AlignmentPairing); the stub stands in for its
// board + map and hands two pairs to the draft the way the mode's admin sink would
vi.mock('./AlignmentPairing', () => ({ default: (props: { onPairs: (p: unknown[]) => void; onDone: () => void }) =>
  <div data-testid="pairing"><button type="button" onClick={() => props.onPairs([{ plan: { x: .2, y: .2 }, lngLat: { lng: 7.55, lat: 47.51 }, kind: 'gesetzt' }, { plan: { x: .8, y: .8 }, lngLat: { lng: 7.552, lat: 47.509 }, kind: 'gesetzt' }])}>pairs</button><button type="button" onClick={props.onDone}>fertig</button></div> }))

const item: AlignmentItem = {
  id: 1, dataset_id: 'plan:object:modul2', plan_version: 3, page: 0, page_count: null, floors: [], can_approve: false, object_name: 'Testobjekt', object_lng: 7.55, object_lat: 47.51, module: 'modul2', title: 'Modul 2', is_current: true,
  status: 'ready', edit_version: 5, pairs: [{ plan: { x: .1, y: .2 }, lngLat: { lng: 7.55, lat: 47.51 }, kind: 'auto' }, { plan: { x: .8, y: .9 }, lngLat: { lng: 7.552, lat: 47.509 }, kind: 'auto' }],
  aspect: .7, scale_m_per_u: 150, score: 4, coverage: .8, reason: null, created_at: '2026-09-09T09:00:00Z', updated_at: '2026-09-09T09:00:00Z', approved_at: null, reference_rings: [], reference_source: 'OSM', reference_at: '2026-09-09T08:00:00Z', marker_notes: null,
}
/** what the outline endpoint answers – the list never carries these */
const RINGS = [[{ lng: 7.55, lat: 47.51 }, { lng: 7.551, lat: 47.51 }, { lng: 7.551, lat: 47.509 }]]
// the exact revision, as the detail endpoint answers it
const detail: AlignmentItem = { ...item, page_count: 1, can_approve: true }
const queue = (items: AlignmentListItem[]) => ({ items, capability: { available: true, reason: null } })
const card = (name: string) => screen.getByRole('listitem', { name: new RegExp(`^${name}`) })

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() })
  vi.mocked(loadAlignmentQueue).mockResolvedValue(queue([{ ...item }]))
  vi.mocked(loadAlignmentDetail).mockResolvedValue(detail)
  vi.mocked(alignmentPreview).mockResolvedValue(new Blob(['png']))
  vi.mocked(alignmentPagePreview).mockResolvedValue(new Blob(['png']))
  vi.mocked(alignmentThumbnail).mockResolvedValue(new Blob(['jpg']))
  vi.mocked(loadAlignmentOutline).mockResolvedValue({ reference_rings: RINGS, reference_source: 'OSM', reference_at: null, pairs: item.pairs })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('alignment review wall', () => {
  it('applies the wall through the exact revision – a summary row never publishes by itself', async () => {
    vi.mocked(loadAlignmentDetail).mockResolvedValueOnce({ ...detail, can_approve: false })
    render(<PlanAlignmentReview compact />)
    // a ready sheet is pre-marked yes; nothing is sent until «Übernehmen»
    const yes = await within(await screen.findByRole('listitem', { name: /^Testobjekt/ })).findByRole('button', { name: 'Freigeben' })
    expect(yes.getAttribute('aria-pressed')).toBe('true')
    expect(loadAlignmentQueue).toHaveBeenCalledWith()
    expect(approveAlignment).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen (1)' }))
    await screen.findByRole('alert')
    expect(approveAlignment).not.toHaveBeenCalled()
    vi.mocked(approveAlignment).mockResolvedValue({ ...detail, status: 'approved', edit_version: 6, approved_at: '2026-09-09T10:00:00Z' })
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen (1)' }))
    await screen.findByText('1 freigegeben, 0 von Hand – 1 Blätter übernommen.')
    expect(approveAlignment).toHaveBeenCalledWith(detail, detail.pairs)
  })
  it('draws its outlines per tile: the queue carries no reference rings', async () => {
    render(<PlanAlignmentReview compact />)
    await screen.findByRole('listitem', { name: /^Testobjekt/ })
    await waitFor(() => expect(loadAlignmentOutline).toHaveBeenCalledTimes(1))
    expect(vi.mocked(loadAlignmentOutline).mock.calls[0][0]).toBe(item.id)
    await waitFor(() => expect(document.querySelector('.adm-card-pic polygon')).toBeTruthy())
  })
  it('asks for no outline where there is no fit to draw one through', async () => {
    vi.mocked(loadAlignmentQueue).mockResolvedValue(queue([{ ...item, status: 'no_match', pairs: [], reason: 'low_coverage' }]))
    render(<PlanAlignmentReview compact />)
    await screen.findByRole('listitem', { name: /^Testobjekt/ })
    await waitFor(() => expect(alignmentThumbnail).toHaveBeenCalled())
    expect(loadAlignmentOutline).not.toHaveBeenCalled()
  })
  it('reads the page\'s queue when it is handed one – no second list request, decisions go back up', async () => {
    const update = vi.fn()
    vi.mocked(approveAlignment).mockResolvedValue({ ...detail, status: 'approved', edit_version: 6 })
    render(<PlanAlignmentReview compact embedded source={{ queue: queue([item]), update, reload: vi.fn(async () => {}) }} />)
    await screen.findByRole('listitem', { name: /^Testobjekt/ })
    expect(loadAlignmentQueue).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen (1)' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: item.id, status: 'approved' })))
    expect(loadAlignmentQueue).not.toHaveBeenCalled()
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
    expect(screen.queryByRole('button', { name: 'Freigeben' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Übernehmen/ })).toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Alle' }))
    expect(screen.getByRole('listitem', { name: /^Dokumentation/ })).toBeTruthy()
    expect(approveAlignment).not.toHaveBeenCalled()
  })
  it('flips a card to «von Hand», applies it as a rejection, and undoes with the latest revision token', async () => {
    const rejected = { ...item, status: 'rejected' as const, edit_version: 6 }
    vi.mocked(rejectAlignment).mockResolvedValue(rejected)
    vi.mocked(undoAlignmentApproval).mockResolvedValue({ ...item, status: 'needs_review', edit_version: 7 })
    render(<PlanAlignmentReview compact />)
    fireEvent.click(await within(await screen.findByRole('listitem', { name: /^Testobjekt/ })).findByRole('button', { name: 'Von Hand' }))
    expect(within(card('Testobjekt')).getByRole('button', { name: 'Freigeben' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen (1)' }))
    await screen.findByText('0 freigegeben, 1 von Hand – 1 Blätter übernommen.')
    expect(rejectAlignment).toHaveBeenCalledWith(item)
    expect(approveAlignment).not.toHaveBeenCalled()
    // decided sheets leave the open wall and wait under their own filter
    expect(screen.queryByRole('listitem', { name: /^Testobjekt/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Entschieden' }))
    fireEvent.click(within(card('Testobjekt')).getByRole('button', { name: 'Rückgängig' }))
    await waitFor(() => expect(undoAlignmentApproval).toHaveBeenCalledWith(rejected))
  })
  it('applies the marked wall one sheet after the other and stops at the first refusal', async () => {
    const second = { ...item, id: 2, object_name: 'Zweites Objekt' }
    vi.mocked(loadAlignmentQueue).mockResolvedValue(queue([item, second]))
    vi.mocked(loadAlignmentDetail).mockImplementation(async id => id === 1 ? detail : { ...second, page_count: 1, can_approve: false, reference_rings: RINGS })
    vi.mocked(approveAlignment).mockImplementation(async it => ({ ...it, reference_rings: RINGS, status: 'approved', edit_version: it.edit_version + 1 }))
    render(<PlanAlignmentReview compact />)
    fireEvent.click(await screen.findByRole('button', { name: 'Übernehmen (2)' }))
    await screen.findByRole('alert')
    expect(approveAlignment).toHaveBeenCalledTimes(1)
    expect(approveAlignment).toHaveBeenCalledWith(detail, detail.pairs)
    await screen.findByText('1 freigegeben, 0 von Hand – 2 Blätter übernommen.')
  })
  it('an approved sheet opens in its points too, and «Fertig» hands over to the overlay', async () => {
    const approved = { ...item, status: 'approved' as const, can_approve: false, approved_at: '2026-09-09T10:00:00Z' }
    vi.mocked(loadAlignmentQueue).mockResolvedValue(queue([approved]))
    vi.mocked(loadAlignmentDetail).mockResolvedValue({ ...approved, page_count: 1 })
    render(<PlanAlignmentReview compact />)
    fireEvent.click(screen.getByRole('button', { name: 'Entschieden' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Gross anzeigen: Testobjekt · 2' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByTestId('pairing')
    fireEvent.click(within(dialog).getByRole('button', { name: 'fertig' }))
    await within(dialog).findByTestId('preview')
    // the way back into the points is the tab, which is why the footer's «Punkte bearbeiten» went
    fireEvent.click(within(dialog).getByRole('button', { name: 'Karte ausrichten' }))
    await within(dialog).findByTestId('pairing')
  })
  it('a proposal opens in its points, says nothing the card already said, and offers no «Neu berechnen»', async () => {
    const single = { status: 'no_match' as const, pairs: [], reason: 'low_coverage', plan_version: 1, page: 0 }
    vi.mocked(loadAlignmentQueue).mockResolvedValue(queue([{ ...item, ...single }]))
    vi.mocked(loadAlignmentDetail).mockResolvedValue({ ...detail, ...single })
    render(<PlanAlignmentReview compact />)
    fireEvent.click(await screen.findByRole('button', { name: 'Gross anzeigen: Testobjekt · 2' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByTestId('pairing')
    // the reason is the card's job; by hand is what this modal IS, and a fresh run cannot help
    expect(within(dialog).queryByText(/ausreichender Sicherheit/)).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Neu berechnen' })).toBeNull()
    // a single-page first revision has no «Stand 1 · Seite 1» to read
    expect(within(dialog).queryByText(/^Stand /)).toBeNull()
  })
  it('keeps the reason and «Neu berechnen» where hand-aligning cannot help', async () => {
    const unreachable = { status: 'failed' as const, pairs: [], reason: 'reference_unreachable' }
    vi.mocked(loadAlignmentQueue).mockResolvedValue(queue([{ ...item, ...unreachable }]))
    vi.mocked(loadAlignmentDetail).mockResolvedValue({ ...detail, ...unreachable })
    render(<PlanAlignmentReview compact />)
    fireEvent.click(await screen.findByRole('button', { name: 'Gross anzeigen: Testobjekt · 2' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText(/Gebäudedaten waren nicht erreichbar/)
    expect(within(dialog).getByRole('button', { name: 'Neu berechnen' })).toBeTruthy()
  })
  it('opens the full instrument in a modal from the thumbnail and blocks approval there without the exact preview', async () => {
    vi.mocked(alignmentPreview).mockRejectedValue(new Error('offline'))
    render(<PlanAlignmentReview compact />)
    fireEvent.click(await screen.findByRole('button', { name: 'Gross anzeigen: Testobjekt · 2' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('Planvorschau konnte nicht geladen werden')
    expect(within(dialog).getByRole('button', { name: 'Ausrichtung freigeben' }).hasAttribute('disabled')).toBe(true)
    expect(approveAlignment).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('aligns a sheet without a proposal by hand: the modal opens in the field pairing, a stale revision blocks approval', async () => {
    vi.mocked(loadAlignmentQueue).mockResolvedValue(queue([{ ...item, status: 'no_match', pairs: [], reason: 'low_coverage' }]))
    vi.mocked(loadAlignmentDetail).mockResolvedValue({ ...detail, status: 'no_match', pairs: [], reason: 'low_coverage' })
    render(<PlanAlignmentReview compact />)
    fireEvent.click(await within(await screen.findByRole('listitem', { name: /^Testobjekt/ })).findByRole('button', { name: 'Von Hand ausrichten' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByTestId('pairing')
    expect(within(dialog).queryByTestId('preview')).toBeNull()
    const approve = within(dialog).getByRole('button', { name: 'Ausrichtung freigeben' })
    expect(approve.hasAttribute('disabled')).toBe(true) // no pairs yet
    fireEvent.click(within(dialog).getByRole('button', { name: 'pairs' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Ausrichtung freigeben' }).hasAttribute('disabled')).toBe(false))
    // «Fertig» in the field instrument: the modal shows the fit as the field would, and the way
    // back into the points is the tab – the footer that used to hold both buttons is gone
    fireEvent.click(within(dialog).getByRole('button', { name: 'fertig' }))
    await within(dialog).findByTestId('preview')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Karte ausrichten' }))
    await within(dialog).findByTestId('pairing')
    vi.mocked(loadAlignmentQueue).mockResolvedValue(queue([{ ...item, status: 'no_match', pairs: [], edit_version: 6 }]))
    vi.mocked(loadAlignmentDetail).mockResolvedValue({ ...detail, status: 'no_match', pairs: [], edit_version: 6 })
    // Emulate the queue's background refresh; the underlying button is now correctly hidden from keyboard/AT.
    fireEvent.click(screen.getByText('Aktualisieren'))
    await within(dialog).findByText('Plan oder Ausrichtung wurde zwischenzeitlich geändert. Aktuellen Stand laden und erneut prüfen.')
    const blocked = await within(dialog).findByRole('button', { name: 'Ausrichtung freigeben' })
    expect(blocked.hasAttribute('disabled')).toBe(true)
  })
})


describe('full-screen plan editor', () => {
  it('keeps a floor draft across all tabs and protects it when leaving', async () => {
    const floorItem: AlignmentItem = { ...detail, module: 'modul6', status: 'unsupported', pairs: [], floors: [{ page: 0, index: 0, name: null }] }
    vi.mocked(loadAlignmentDetail).mockResolvedValue(floorItem)
    const onClose = vi.fn()
    const onChange = vi.fn()
    vi.mocked(savePlanFloors).mockResolvedValue({ ...floorItem, edit_version: 6, floors: [{ page: 0, index: 0, name: 'Halle' }] })
    render(<PlanAlignmentEditor item={floorItem} onClose={onClose} onChange={onChange} onConflict={vi.fn()} />)
    const name = await screen.findByRole('textbox', { name: 'Standardname: EG' })
    fireEvent.change(name, { target: { value: 'Halle' } })
    fireEvent.click(screen.getByRole('button', { name: 'Karte ausrichten' }))
    await screen.findByTestId('pairing')
    fireEvent.click(screen.getByRole('button', { name: 'Vorschau' }))
    expect(approveAlignment).not.toHaveBeenCalled()
    expect(savePlanFloors).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Geschosse' }))
    expect((screen.getByRole('textbox', { name: 'Standardname: EG' }) as HTMLInputElement).value).toBe('Halle')
    fireEvent.click(screen.getByRole('button', { name: 'Zum Objekt' }))
    const warning = await screen.findByRole('alertdialog')
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(within(warning).getByRole('button', { name: 'Abbrechen' }))
    expect((screen.getByRole('textbox', { name: 'Standardname: EG' }) as HTMLInputElement).value).toBe('Halle')
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(savePlanFloors).toHaveBeenCalledWith(floorItem, [{ page: 0, index: 0, part: 0, name: 'Halle', clip: null, join: null }], undefined)
  })

  // The Vorschau is a picture, not a page of prose: the map relationship first and full-width,
  // then one tile per floor in BUILDING order – top storey first, the way the list reads.
  it('shows the Vorschau as the map tile and then the floors top-down, with nothing said in words', async () => {
    const floorItem: AlignmentItem = { ...detail, module: 'modul6', status: 'ready', page_count: 2,
      floors: [{ page: 0, index: 0, name: 'Erdgeschoss' }, { page: 1, index: 1, name: 'Dachstock' }] }
    vi.mocked(loadAlignmentDetail).mockResolvedValue(floorItem)
    render(<PlanAlignmentEditor item={floorItem} onClose={vi.fn()} onChange={vi.fn()} onConflict={vi.fn(async () => {})} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Vorschau' }))
    // the editor is an overlay, so the grid lives in the portal rather than the render container
    const grid = await waitFor(() => {
      const el = document.body.querySelector<HTMLElement>('.adm-floor-preview')
      if (!el) throw new Error('no grid yet')
      return el
    })
    // the fit stands (two pairs), so its tile heads the grid
    await within(grid).findByTestId('preview')
    expect((grid.firstElementChild as HTMLElement).className).toBe('adm-floor-preview-map')
    expect(within(grid).getAllByRole('img').map(el => el.getAttribute('aria-label'))).toEqual(['+1 · Dachstock', '0 · Erdgeschoss'])
    // no sentences: neither the old preview hint nor the «noch keine Ausrichtung» line
    expect(within(grid).queryByText(/Rahmen und Massstab/)).toBeNull()
    expect(screen.queryByText(/Noch keine Geschosse zugeordnet/)).toBeNull()
  })
})


it('reloads a conflicting revision only after the admin agrees to discard the floor draft', async () => {
  const floorItem: AlignmentItem = { ...detail, module: 'modul6', status: 'unsupported', pairs: [], floors: [{ page: 0, index: 0, name: null }] }
  vi.mocked(loadAlignmentDetail).mockResolvedValue(floorItem)
  vi.mocked(savePlanFloors).mockRejectedValue(new ApiError(409, 'conflict'))
  render(<PlanAlignmentEditor item={floorItem} onClose={vi.fn()} onChange={vi.fn()} onConflict={vi.fn(async () => {})} />)
  fireEvent.change(await screen.findByRole('textbox', { name: 'Standardname: EG' }), { target: { value: 'Local' } })
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Aktualisieren' }))
  const warning = await screen.findByRole('alertdialog')
  expect(loadAlignmentDetail).toHaveBeenCalledTimes(1)
  fireEvent.click(within(warning).getByRole('button', { name: 'Abbrechen' }))
  expect(screen.getByDisplayValue('Local')).toBeTruthy()
  vi.mocked(loadAlignmentDetail).mockResolvedValue({ ...floorItem, edit_version: 6, floors: [{ page: 0, index: 0, name: 'Remote' }] })
  fireEvent.click(screen.getByRole('button', { name: 'Aktualisieren' }))
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Verwerfen' }))
  await screen.findByDisplayValue('Remote')
  expect(loadAlignmentDetail).toHaveBeenCalledTimes(2)
})

// «Ungespeichert» used to be a trap: verwerfen or abbrechen, then walk to the header and back in.
it('offers the editor\'s own save as the third way out and closes behind it', async () => {
  const floorItem: AlignmentItem = { ...detail, module: 'modul6', status: 'unsupported', pairs: [], floors: [{ page: 0, index: 0, name: null }] }
  vi.mocked(loadAlignmentDetail).mockResolvedValue(floorItem)
  vi.mocked(savePlanFloors).mockResolvedValue({ ...floorItem, edit_version: 6, floors: [{ page: 0, index: 0, name: 'Halle' }] })
  const onClose = vi.fn()
  render(<PlanAlignmentEditor item={floorItem} onClose={onClose} onChange={vi.fn()} onConflict={vi.fn(async () => {})} />)
  fireEvent.change(await screen.findByRole('textbox', { name: 'Standardname: EG' }), { target: { value: 'Halle' } })
  fireEvent.click(screen.getByRole('button', { name: 'Zum Objekt' }))
  const warning = await screen.findByRole('alertdialog')
  fireEvent.click(within(warning).getByRole('button', { name: 'Speichern' }))
  await waitFor(() => expect(onClose).toHaveBeenCalled())
  expect(savePlanFloors).toHaveBeenCalledWith(floorItem, [{ page: 0, index: 0, part: 0, name: 'Halle', clip: null, join: null }], undefined)
})

// The §-marker diagnosis (16.09.2026): a marked export that prepared nothing must say WHY, in
// German, from the codes the backend wrote onto the row – not in a server log nobody reads.
it('turns the marker warning codes into German sentences under the editor header', async () => {
  const floorItem: AlignmentItem = {
    ...detail, module: 'modul6', status: 'ready', page_count: 2, floors: [],
    marker_notes: {
      warnings: [
        { code: 'corner_missing', storey: 4, tag: '§4OG]', have: '§[4OG', side: 'br', page: 1 },
        { code: 'region_off_page', storey: 0, tag: '§[EG', page: 1, axis: 'x', value: -0.001 },
        { code: 'geo_single', page: 1 },
      ],
      storeys_found: 5, storeys_written: 0, geo_pairs: 0,
    },
  }
  vi.mocked(loadAlignmentDetail).mockResolvedValue(floorItem)
  render(<PlanAlignmentEditor item={floorItem} onClose={vi.fn()} onChange={vi.fn()} onConflict={vi.fn(async () => {})} />)
  await screen.findByText('§4OG]: Ecke unten rechts fehlt – §[4OG hat kein Gegenstück.')
  // the coordinate keeps a real minus sign – it is read, not computed with
  expect(screen.getByText('§[EG (Seite 1): eine Ecke liegt ausserhalb der Seite (x −0.0010).')).toBeTruthy()
  expect(screen.getByText('Kartenfit: nur ein §GEO auf der Ausrichtungsseite (Seite 1) – zwei sind nötig.')).toBeTruthy()
  // …and the one line that says where the fix belongs: in the PDF, not on this page
  expect(screen.getByText('Im PDF korrigieren und neu exportieren – der nächste Import liest es automatisch.')).toBeTruthy()
  // the Geschosse column points at that note instead of repeating the generic empty line
  expect(screen.getByText('Keine Geschosse – die Marker im PDF sind unvollständig (siehe Hinweis oben).')).toBeTruthy()
  expect(screen.queryByText(/Noch keine Geschosse zugeordnet/)).toBeNull()
})
