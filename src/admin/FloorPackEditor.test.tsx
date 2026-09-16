// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FloorPackEditor } from './FloorPackEditor'
import { alignmentPagePreview, type AlignmentItem } from './planAlignmentApi'

// The editor never saves – the full-screen editor around it does – so the draft it hands up
// through `onDraft` is what every assertion here reads.
vi.mock('./planAlignmentApi', () => ({
  alignmentPagePreview: vi.fn(() => new Promise<Blob>(() => { /* never resolves – the sheet shows its loading line */ })),
}))

// Wyss Gartencenter Modul 6: page 1 = 2. OG … page 3 = EG / ZWG, page 4 = UG
const item: AlignmentItem = {
  id: 7, dataset_id: 'plan:wyss:modul6', plan_version: 2, page: 0, page_count: 4, floors: [], can_approve: false, object_name: 'Wyss Gartencenter', object_lng: 7.5554, object_lat: 47.5112, module: 'modul6', title: null, is_current: true,
  status: 'unsupported', edit_version: 3, pairs: [], aspect: 1.4, scale_m_per_u: null, score: null, coverage: null, reason: 'multi_page_document',
  created_at: '2026-09-14T08:00:00Z', updated_at: '2026-09-14T08:00:00Z', approved_at: null, reference_rings: [], reference_source: null, reference_at: null, marker_notes: null,
}
// the sheet's raster never arrives unless a test asks for it – nothing here needs the picture
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(alignmentPagePreview).mockImplementation(() => new Promise<Blob>(() => { /* pending */ }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('FloorPackEditor', () => {
  it('one tap says which page is level 0; the indices follow and the draft carries the whole list', () => {
    const onDraft = vi.fn()
    render(<FloorPackEditor item={item} view="edit" onDraft={onDraft} />)
    const tiles = () => screen.getAllByRole('listitem').map(el => el.getAttribute('aria-label'))
    expect(tiles()).toEqual(['0 · EG', '−1 · 1. UG', '−2 · 2. UG', '−3 · 3. UG']) // PDF order, page 1 = 0 – one tap away
    // what concerns the whole list lives in the column's kebab, not in every row
    expect(screen.getByRole('button', { name: 'Geschosse ordnen' })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('listitem')[2])
    fireEvent.click(screen.getByRole('button', { name: '−2 · Diese Seite ist Ebene 0' }))
    expect(tiles()).toEqual(['+2 · 2. OG', '+1 · 1. OG', '0 · EG', '−1 · 1. UG'])
    fireEvent.change(screen.getByLabelText('Standardname: EG'), { target: { value: 'EG / ZWG' } })
    expect(onDraft.mock.lastCall?.[0]).toMatchObject({
      dirty: true,
      fitPage: undefined, // no explicit fit page → the server measures on level 0
      floors: [
        { page: 0, index: 2, name: null, clip: null, join: null }, { page: 1, index: 1, name: null, clip: null, join: null },
        { page: 2, index: 0, name: 'EG / ZWG', clip: null, join: null }, { page: 3, index: -1, name: null, clip: null, join: null },
      ],
    })
  })
  it('a page that is no floor goes to the tray and comes back; an approved fit cannot be moved from here', () => {
    const approved = { ...item, status: 'approved' as const, page: 2, floors: [{ page: 0, index: 1, name: null }, { page: 2, index: 0, name: null }] }
    render(<FloorPackEditor item={approved} view="edit" />)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Seite 2 · Als Geschoss' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Seite 2 · Als Geschoss' }))
    expect(screen.getAllByRole('listitem').map(el => el.getAttribute('aria-label'))).toEqual(['+1 · 1. OG', '0 · EG', '−1 · 1. UG'])
    // approved: no row offers to move the fit, and the open one says why
    for (const row of screen.getAllByRole('listitem')) fireEvent.click(row)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText(/Die Ausrichtung ist freigegeben/)).toBeTruthy()
    // the ✕ in the OPEN row's head: the page goes back to the Ablage, it is not deleted
    fireEvent.click(screen.getByRole('button', { name: 'Geschoss entfernen' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Seite 2 · Als Geschoss' })).toBeTruthy()
  })
  // ⚠️ `stack.fitPage` is a PAGE, not a floor: every floor on the fit page is measured on it, so
  // a pack that lives on one page has nothing to choose and says so instead of showing a toggle.
  it('the fit is one setting per page: a sentence on a one-page pack, the toggle on a multi-page one', () => {
    const onDraft = vi.fn()
    const { unmount } = render(<FloorPackEditor item={{ ...item, page_count: 1, floors: [{ page: 0, index: 0, name: null }] }} view="edit" />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText('Die Karte wird auf Seite 1 ausgerichtet – die Passung gilt für alle Geschosse.')).toBeTruthy()
    unmount()
    const twoPages = { ...item, page: 1, page_count: 2, floors: [{ page: 0, index: 1, name: null }, { page: 1, index: 0, name: null }] }
    render(<FloorPackEditor item={twoPages} view="edit" onDraft={onDraft} />)
    const fitBox = () => screen.getByRole('checkbox', { name: /Ausrichtung auf dieser Seite/ }) as HTMLInputElement
    fireEvent.click(screen.getAllByRole('listitem')[1]) // level 0, on page 2 – where the fit is measured today
    expect(fitBox().checked).toBe(true)
    expect(fitBox().disabled).toBe(true) // the one page it IS on; another row is how it moves
    fireEvent.click(screen.getAllByRole('listitem')[0])
    expect(fitBox().checked).toBe(false)
    fireEvent.click(fitBox())
    expect(onDraft.mock.lastCall?.[0]).toMatchObject({ dirty: true, fitPage: 0 })
    expect(fitBox().disabled).toBe(true)
  })
})

// ONE row (15.09.2026): the editor's tabs, the sheet's zoom and the floors column's head stand in
// it together. The zoom is the SHEET's control, so it exists only where a sheet is being worked
// on – the Karte tab has the map's own zoom, the Vorschau nothing to zoom.
describe('the editor\'s one bar', () => {
  it('carries the tabs always, and the zoom cluster and the column head only on Geschosse', () => {
    const tabs = <button type="button">Vorschau</button>
    const zoom = () => screen.queryByRole('button', { name: 'Vergrössern' })
    const { rerender } = render(<FloorPackEditor item={item} view="edit" tabs={tabs} />)
    expect(zoom()).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Geschosse ordnen' })).toBeTruthy()
    for (const view of ['map', 'preview'] as const) {
      rerender(<FloorPackEditor item={item} view={view} tabs={tabs} />)
      expect(screen.getByRole('button', { name: 'Vorschau' })).toBeTruthy() // the tabs stay
      expect(zoom()).toBeNull()
      expect(screen.queryByRole('button', { name: 'Geschosse ordnen' })).toBeNull()
    }
  })
})

// The Vorschau is where the preparation is CHECKED, so the storeys have to read like the
// building: highest on top, Untergeschoss at the bottom, beside the map rather than wrapped into
// a grid of rows (Bastian, 16.09.2026).
describe('the Vorschau', () => {
  it('stacks the storeys highest-first, whatever order the pack hands over', () => {
    const jumbled = {
      ...item,
      page: 0,
      page_count: 1,
      floors: [
        { page: 0, index: -1, name: null }, { page: 0, index: 2, name: null },
        { page: 0, index: 0, name: null }, { page: 0, index: 1, name: null },
      ],
    }
    const { container } = render(<FloorPackEditor item={jumbled} view="preview" />)
    const caps = [...container.querySelectorAll('.adm-floor-tile-cap')].map((el) => el.textContent)
    expect(caps).toEqual(['+2' + '2. OG', '+1' + '1. OG', '0' + 'EG', '−1' + '1. UG'])
  })
})

describe('regions of one sheet', () => {
  it('a drag on the sheet becomes the selected floor\'s rectangle; two floors are joined by one point each; the draft carries it', () => {
    const onDraft = vi.fn()
    const a0 = { ...item, page_count: 1 }
    const { container } = render(<FloorPackEditor item={a0} view="edit" onDraft={onDraft} />)
    const sheet = container.querySelector('.adm-floors-sheet') as HTMLElement
    sheet.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700, x: 0, y: 0, toJSON: () => ({}) })
    const drag = (x0: number, y0: number, x1: number, y1: number) => {
      fireEvent.pointerDown(sheet, { clientX: x0, clientY: y0, pointerId: 1 }); fireEvent.pointerMove(sheet, { clientX: x1, clientY: y1, pointerId: 1 }); fireEvent.pointerUp(sheet, { clientX: x1, clientY: y1, pointerId: 1 })
    }
    const tap = (x: number, y: number) => { fireEvent.pointerDown(sheet, { clientX: x, clientY: y, pointerId: 1 }); fireEvent.pointerUp(sheet, { clientX: x, clientY: y, pointerId: 1 }) }
    // the first drawing – alone on the page, nothing to join yet
    fireEvent.click(screen.getAllByRole('listitem')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Bereich zeichnen' }))
    drag(20, 20, 350, 315)
    expect(screen.getAllByRole('listitem')[0].textContent).not.toContain('Nicht verbunden')
    // the second – added at the FOOT of the list, and the rectangle hands over to the join:
    // my staircase, then theirs
    fireEvent.click(screen.getByRole('button', { name: 'Geschoss hinzufügen' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    drag(400, 20, 980, 350)
    expect(screen.getAllByRole('listitem')[1].textContent).toContain('Nicht verbunden')
    expect(onDraft.mock.lastCall?.[0].complete).toBe(false) // an unjoined drawing is no pack yet
    tap(430, 320) // in the second drawing
    tap(50, 280) // the same point in the first
    expect(screen.getAllByRole('listitem')[1].textContent).toContain('Verbunden')
    expect(container.querySelectorAll('.adm-floors-joins line')).toHaveLength(1)
    expect(onDraft.mock.lastCall?.[0]).toMatchObject({
      complete: true,
      fitPage: undefined,
      floors: [
        { page: 0, index: 0, name: null, clip: [0.02, 0.0286, 0.35, 0.45], join: null },
        { page: 0, index: -1, name: null, clip: [0.4, 0.0286, 0.98, 0.5], join: { to: 0, at: [0.43, 0.4571], there: [0.05, 0.4] } },
      ],
    })
    // ⚠️ a press ON a join point drags THAT point – the drawing under it must stay where it is
    fireEvent.pointerDown(sheet, { clientX: 430, clientY: 320, pointerId: 1 })
    fireEvent.pointerMove(sheet, { clientX: 500, clientY: 330, pointerId: 1 })
    fireEvent.pointerUp(sheet, { clientX: 500, clientY: 330, pointerId: 1 })
    expect(onDraft.mock.lastCall?.[0].floors[1]).toMatchObject({
      clip: [0.4, 0.0286, 0.98, 0.5], join: { to: 0, at: [0.5, 0.4714], there: [0.05, 0.4] },
    })
  })
})

describe('«Geschoss hinzufügen»', () => {
  it('the dashed row at the foot adds the next storey BELOW the lowest, on that floor\'s page', () => {
    const onDraft = vi.fn()
    const twoPages = { ...item, page_count: 2, floors: [{ page: 0, index: 1, name: null }, { page: 1, index: 0, name: null }] }
    render(<FloorPackEditor item={twoPages} view="edit" onDraft={onDraft} />)
    fireEvent.click(screen.getByRole('button', { name: 'Geschoss hinzufügen' }))
    expect(screen.getAllByRole('listitem').map(el => el.getAttribute('aria-label'))).toEqual(['+1 · 1. OG', '0 · EG', '−1 · 1. UG'])
    expect(onDraft.mock.lastCall?.[0].floors.at(-1)).toMatchObject({ page: 1, index: -1 }) // the lowest floor's page
  })
  it('on a fresh single page the first drawing IS level 0 and the next stacks under it', () => {
    const onDraft = vi.fn()
    const a0 = { ...item, page_count: 1 }
    const { container } = render(<FloorPackEditor item={a0} view="edit" onDraft={onDraft} />)
    const sheet = container.querySelector('.adm-floors-sheet') as HTMLElement
    sheet.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700, x: 0, y: 0, toJSON: () => ({}) })
    const draw = (x0: number, y0: number, x1: number, y1: number) => {
      fireEvent.click(screen.getByRole('button', { name: 'Geschoss hinzufügen' }))
      fireEvent.pointerDown(sheet, { clientX: x0, clientY: y0, pointerId: 1 }); fireEvent.pointerMove(sheet, { clientX: x1, clientY: y1, pointerId: 1 }); fireEvent.pointerUp(sheet, { clientX: x1, clientY: y1, pointerId: 1 })
    }
    const tap = (x: number, y: number) => { fireEvent.pointerDown(sheet, { clientX: x, clientY: y, pointerId: 1 }); fireEvent.pointerUp(sheet, { clientX: x, clientY: y, pointerId: 1 }) }
    draw(400, 20, 980, 350) // the ground floor drawing
    expect(screen.getAllByRole('listitem').map(el => el.getAttribute('aria-label'))).toEqual(['0 · EG'])
    draw(20, 20, 350, 315) // the storey below – joined to the ground floor at the staircase
    expect(screen.getAllByRole('listitem').map(el => el.getAttribute('aria-label'))).toEqual(['0 · EG', '−1 · 1. UG'])
    expect(onDraft.mock.calls[onDraft.mock.calls.length - 1][0].complete).toBe(false)
    tap(50, 280); tap(430, 320)
    const last = onDraft.mock.calls[onDraft.mock.calls.length - 1][0]
    expect(last).toMatchObject({ dirty: true, complete: true })
    expect(last.floors.map((f: { index: number; clip: unknown; join: unknown }) => [f.index, !!f.clip, !!f.join])).toEqual([[0, true, false], [-1, true, true]])
  })
})

// ⚠️ the loupe exists to HIT the same staircase on two drawings – anywhere else it only covers
// the paper being worked on
describe('the loupe', () => {
  it('rides the pointer only while a join point is being set', async () => {
    vi.mocked(alignmentPagePreview).mockResolvedValue(new Blob(['png']))
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:sheet'), revokeObjectURL: vi.fn() })
    const twoPages = { ...item, page_count: 2, floors: [{ page: 0, index: 0, name: null }, { page: 1, index: 1, name: null }] }
    const { container } = render(<FloorPackEditor item={twoPages} view="edit" />)
    await waitFor(() => expect(container.querySelector('.adm-floors-sheet img')).not.toBeNull())
    const sheet = container.querySelector('.adm-floors-sheet') as HTMLElement
    sheet.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerMove(sheet, { clientX: 200, clientY: 150, pointerId: 1 })
    expect(container.querySelector('.adm-floors-loupe')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Verbinden' }))
    fireEvent.pointerMove(sheet, { clientX: 200, clientY: 150, pointerId: 1 })
    expect(container.querySelector('.adm-floors-loupe')).not.toBeNull()
  })
})

describe('cross-page joins', () => {
  it('keeps the first point while selecting another whole-page floor and records its corresponding point', () => {
    const onDraft = vi.fn()
    const twoPages = { ...item, page_count: 2, floors: [{ page: 0, index: 0, name: null }, { page: 1, index: 1, name: null }] }
    const historyRef = createRef<{ undo: () => void }>()
    const { container } = render(<FloorPackEditor item={twoPages} view="edit" onDraft={onDraft} historyRef={historyRef} />)
    const sheet = container.querySelector<HTMLElement>('.adm-floors-sheet')!
    sheet.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) })
    const tap = (x: number, y: number) => {
      fireEvent.pointerDown(sheet, { clientX: x, clientY: y, pointerId: 1 })
      fireEvent.pointerUp(sheet, { clientX: x, clientY: y, pointerId: 1 })
    }
    // Sorted top-down: first row +1, second row EG. Both whole-page floors can join.
    fireEvent.click(screen.getByRole('button', { name: 'Verbinden' }))
    tap(200, 150)
    expect(container.querySelector('.adm-floors-joins circle.pending')).not.toBeNull()
    fireEvent.click(screen.getAllByRole('listitem')[0])
    expect(container.querySelector('.adm-floors-joins circle.pending')).toBeNull() // source mark never moves to target page
    tap(650, 350)
    expect(onDraft.mock.lastCall?.[0].floors).toEqual([
      { page: 1, index: 1, part: 0, name: null, clip: null, join: null },
      { page: 0, index: 0, part: 0, name: null, clip: null, join: { to: 1, at: [0.2, 0.3], there: [0.65, 0.7] } },
    ])
    expect(container.querySelectorAll('.adm-floors-joins circle')).toHaveLength(1)
    expect(container.querySelectorAll('.adm-floors-joins line')).toHaveLength(0)
    act(() => historyRef.current!.undo()) // the full-screen editor's header owns undo
    expect(onDraft.mock.lastCall?.[0].floors.every((floor: { join: unknown }) => floor.join == null)).toBe(true)
    expect(onDraft.mock.lastCall?.[0].dirty).toBe(false)
  })

  it('cancels a crop move without a later pointer release committing it', () => {
    const onDraft = vi.fn()
    const clipped = { ...item, page_count: 1, floors: [{ page: 0, index: 0, name: null, clip: [0.1, 0.1, 0.5, 0.5] as [number, number, number, number] }] }
    const { container } = render(<FloorPackEditor item={clipped} view="edit" onDraft={onDraft} />)
    const sheet = container.querySelector<HTMLElement>('.adm-floors-sheet')!
    sheet.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerDown(sheet, { clientX: 200, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(sheet, { clientX: 400, clientY: 200, pointerId: 1 })
    expect(container.querySelector('.adm-floors-box.moving')).not.toBeNull()
    fireEvent.pointerCancel(sheet, { pointerId: 1 })
    fireEvent.pointerUp(sheet, { clientX: 400, clientY: 200, pointerId: 1 })
    expect(container.querySelector('.adm-floors-box.moving')).toBeNull()
    expect(onDraft.mock.lastCall?.[0].dirty).toBe(false)
  })
})

// A Geschoss out of several drawings (16.09.2026): ONE storey row, its drawings as small rows
// under it. The list stays a list of Geschosse – a wing is not a storey and never gets an index.
describe('a storey drawn in several pieces', () => {
  const wings = {
    ...item, page_count: 2, page: 1,
    floors: [
      { page: 0, index: 1, part: 0, name: 'Westflügel', clip: [0.02, 0.05, 0.45, 0.95] as [number, number, number, number], join: { to: 0, at: [0.1, 0.5] as [number, number], there: [0.2, 0.5] as [number, number] } },
      { page: 0, index: 1, part: 1, name: 'Ostflügel', clip: [0.5, 0.05, 0.95, 0.95] as [number, number, number, number], join: { to: 0, at: [0.6, 0.5] as [number, number], there: [0.8, 0.5] as [number, number] } },
      { page: 1, index: 0, part: 0, name: null },
    ],
  }
  it('is one row with its drawings under it, and the name being typed is the drawing\'s own', () => {
    const onDraft = vi.fn()
    render(<FloorPackEditor item={wings} view="edit" onDraft={onDraft} />)
    expect(screen.getAllByRole('listitem').map((el) => el.getAttribute('aria-label'))).toEqual(['+1 · 1. OG', '0 · EG'])
    fireEvent.click(screen.getAllByRole('listitem')[0])
    expect(screen.getByText('2 Zeichnungen')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '+1 · Ostflügel' }))
    const field = screen.getByRole('textbox') as HTMLInputElement
    expect(field.value).toBe('Ostflügel')
    fireEvent.change(field, { target: { value: 'Verwaltung' } })
    expect(onDraft.mock.lastCall?.[0].floors.map((f: { index: number; part: number; name: string | null }) => [f.index, f.part, f.name]))
      .toEqual([[1, 0, 'Westflügel'], [1, 1, 'Verwaltung'], [0, 0, null]])
  })
  it('«Weitere Zeichnung» adds a piece to THAT storey and blocks the save until it has a rectangle', () => {
    const onDraft = vi.fn()
    render(<FloorPackEditor item={wings} view="edit" onDraft={onDraft} />)
    fireEvent.click(screen.getAllByRole('listitem')[1]) // the EG
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Zeichnung' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(2) // still two Geschosse
    expect(onDraft.mock.lastCall?.[0].floors.map((f: { index: number; part: number }) => [f.index, f.part]))
      .toEqual([[1, 0], [1, 1], [0, 0], [0, 1]])
    expect(onDraft.mock.lastCall?.[0].complete).toBe(false)
    // …and it is removed on its own, without taking its storey with it
    fireEvent.click(screen.getByRole('button', { name: 'Zeichnung entfernen' }))
    expect(onDraft.mock.lastCall?.[0].floors.map((f: { index: number; part: number }) => [f.index, f.part]))
      .toEqual([[1, 0], [1, 1], [0, 0]])
  })
})
