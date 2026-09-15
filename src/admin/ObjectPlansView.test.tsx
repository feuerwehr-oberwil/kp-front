// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { webcrypto } from 'node:crypto'
import { ObjectPlansView } from './ObjectPlansView'
import { listObjects, type ObjectWithPlans } from '../lib/incidents'
import { loadAlignmentQueue, type AlignmentItem } from './planAlignmentApi'
import type { AlignmentQueueSource } from './PlanAlignmentReview'

// jsdom ships a Crypto without `subtle`; creating an object derives its id with real WebCrypto.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
}

vi.mock('../lib/incidents', () => ({ listObjects: vi.fn() }))
vi.mock('./planAlignmentApi', () => ({ loadAlignmentQueue: vi.fn() }))
vi.mock('./PlanAlignmentReview', () => ({
  PlanAlignmentEditor: ({ item, onClose }: { item: AlignmentItem; onClose: () => void }) => <div role="dialog">Editor {item.id}<button onClick={onClose}>Back</button></div>,
  // the review wall itself is exercised in PlanAlignmentReview.test.tsx; here only that the tab
  // mounts it, in the compact + embedded shape the page owes it
  PlanAlignmentReview: (props: { compact?: boolean; embedded?: boolean; source?: AlignmentQueueSource }) =>
    <div data-testid="wall">{`wall ${props.compact} ${props.embedded} items:${props.source?.queue?.items.length ?? 'own'}`}</div>,
}))
// ⚠️ ObjectEditor is NOT mocked: the detail page IS the editor now, and the plan rows the
// assertions below reach for («Vorbereiten», the kebab, the status badge) are rendered
// THROUGH it. Only its two network doors are stubbed.
// ⚠️ Plain functions, not vi.fn(): `vi.resetAllMocks()` below would strip a mocked
// implementation and `apiGet` would answer `undefined`, which is not a promise.
let saveObjectImpl: (id: string, body: unknown) => Promise<unknown> = () => Promise.reject(new Error('not stubbed'))
vi.mock('./stationDataApi', async () => {
  const actual = await vi.importActual<typeof import('./stationDataApi')>('./stationDataApi')
  return {
    ...actual,
    saveObject: (id: string, body: unknown) => saveObjectImpl(id, body),
    uploadPlan: () => Promise.reject(new Error('not stubbed')),
  }
})
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, apiGet: () => Promise.reject(new Error('not stubbed')) }
})
const plan = { id: 'p1', object_id: 'o1', module: 'modul6', kind: 'pdf', title: 'Gebäudeplan', source_type: 'upload', source_note: null, content_type: 'application/pdf', size_bytes: 10, feature_count: null, current_version: 2, updated_at: '' }
const object: ObjectWithPlans = { id: 'o1', name: 'Testhaus', address: 'Testweg 12', lat: null, lng: null, source_note: null, updated_at: '', plans: [plan], distance_m: null }
const item: AlignmentItem = { id: 8, dataset_id: 'p1', plan_version: 2, page: 0, page_count: null, floors: [], can_approve: false, object_name: 'Testhaus', object_lng: null, object_lat: null, module: 'modul6', title: null, is_current: true, status: 'ready', edit_version: 1, pairs: [], aspect: null, scale_m_per_u: null, score: null, coverage: null, reason: null, created_at: '', updated_at: '', approved_at: null, reference_rings: [], reference_source: null, reference_at: null }
const mount = () => render(<ObjectPlansView modules={[{ id: 'modul6', title: 'Modul 6', alignment: 'manual' }]} overview={() => <div>Catalogue overview</div>} />)
/** the row's own control — one button spanning the name cell, no «Öffnen» beside it */
const row = (name = 'Testhaus') => screen.getByRole('button', { name: new RegExp(`^${name}`) })
/** the same grammar one level down: a plan row's control is the button spanning its Modul cell */
const planRow = (short = 'M6') => screen.getByRole('button', { name: new RegExp(`^${short}`) })
beforeEach(() => { vi.resetAllMocks(); vi.mocked(listObjects).mockResolvedValue([object]); vi.mocked(loadAlignmentQueue).mockResolvedValue({ items: [item], capability: { available: true, reason: null } }) })
afterEach(cleanup)

it('opens only the selected object and its current plan; returning preserves search', async () => {
  mount()
  await screen.findByText('Testhaus')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Testweg' } })
  fireEvent.click(row())
  expect(screen.queryByRole('searchbox')).toBeNull()
  fireEvent.click(planRow())
  expect(screen.getByRole('dialog').textContent).toContain('Editor 8')
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  fireEvent.click(screen.getByRole('button', { name: 'Objekte' }))
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('Testweg')
})
it('never presents an older approved PDF revision as approved or editable', async () => {
  vi.mocked(loadAlignmentQueue).mockResolvedValue({ items: [{ ...item, plan_version: 1, status: 'approved' }], capability: { available: true, reason: null } })
  const open = vi.fn()
  vi.stubGlobal('open', open)
  mount(); await screen.findByText('Testhaus')
  fireEvent.click(row())
  expect(screen.getByText('Vorbereitung ausstehend')).toBeTruthy()
  // nothing to prepare ⇒ the row opens the PDF itself, and there is no primary button at all
  expect(screen.queryByRole('button', { name: 'PDF ersetzen' })).toBeNull()
  fireEvent.click(planRow())
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(open).toHaveBeenCalledWith('/api/reference/p1?v=2', '_blank', 'noopener')
  vi.unstubAllGlobals()
})
it('keeps objects accessible when preparation loading fails and does not claim approval', async () => {
  vi.mocked(loadAlignmentQueue).mockRejectedValue(new Error('offline'))
  mount(); await screen.findByText('Testhaus')
  expect(screen.getByRole('alert')).toBeTruthy()
  fireEvent.click(row())
  // the queue is unreadable, so nothing may be prepared – the PDF is still reachable, through
  // the row and through its kebab
  expect(screen.queryByRole('button', { name: 'PDF ersetzen' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Weitere Aktionen · M6' })).toBeTruthy()
  expect(screen.getByText('Vorbereitung ausstehend')).toBeTruthy()
})
it('keeps the overview out of the object list until explicitly selected', async () => {
  mount(); await screen.findByText('Testhaus')
  expect(screen.queryByText('Catalogue overview')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Übersicht' }))
  expect(screen.getByText('Catalogue overview')).toBeTruthy()
  expect(screen.queryByText('Testhaus')).toBeNull()
})
it('keeps an approved map fit with missing floors in Handlungsbedarf', async () => {
  vi.mocked(loadAlignmentQueue).mockResolvedValue({ items: [{ ...item, status: 'approved' }], capability: { available: true, reason: null } })
  mount(); await screen.findByText('Testhaus')
  fireEvent.click(screen.getByRole('button', { name: 'Freigegeben' }))
  expect(screen.queryByText('Testhaus')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Handlungsbedarf' }))
  fireEvent.click(row())
  expect(screen.getByText('Geschosse vorbereiten')).toBeTruthy()
})

it.each([undefined, 'none'] as const)('opens M6 floor preparation when map alignment is %s', async alignment => {
  vi.mocked(loadAlignmentQueue).mockResolvedValue({ items: [{ ...item, status: 'unsupported' }], capability: { available: true, reason: null } })
  render(<ObjectPlansView modules={[{ id: 'modul6', title: 'Gebäudepläne', viewer: true, alignment }]} overview={() => null} />)
  await screen.findByText('Testhaus')
  fireEvent.click(screen.getByRole('button', { name: 'Handlungsbedarf' }))
  fireEvent.click(row())
  expect(screen.getByText('Geschosse vorbereiten')).toBeTruthy()
  fireEvent.click(planRow())
  expect(screen.getByRole('dialog').textContent).toContain('Editor 8')
})

it('renders the object list without waiting for the preparation queue', async () => {
  vi.mocked(loadAlignmentQueue).mockReturnValue(new Promise(() => {}))
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /^Testhaus/ }))
  expect(screen.getByText('Vorbereitung ausstehend')).toBeTruthy()
})

it('makes the ROW the control: one button in the name cell, and the whole row for the finger', async () => {
  mount()
  const open = await screen.findByRole('button', { name: /^Testhaus/ })
  // a real <button> — so Enter and ␣ reach it without the row hand-rolling key handling
  expect(open.tagName).toBe('BUTTON')
  expect(screen.queryByRole('button', { name: /Öffnen/ })).toBeNull()
  fireEvent.click(open)
  expect(planRow()).toBeTruthy()
})

it('opens an object from anywhere on its row, not only from its name', async () => {
  mount()
  const name = await screen.findByText('Testhaus')
  fireEvent.click(name.closest('tr') as HTMLElement)
  expect(planRow()).toBeTruthy()
})

it('keeps «PDF öffnen» and «PDF ersetzen» in the row’s kebab, never as a second and third button', async () => {
  const open = vi.fn()
  vi.stubGlobal('open', open)
  mount()
  await screen.findByText('Testhaus')
  fireEvent.click(screen.getByRole('button', { name: /^Testhaus/ }))
  expect(screen.queryByRole('button', { name: 'PDF öffnen' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'PDF öffnen' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'PDF ersetzen' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Weitere Aktionen · M6' }))
  expect(screen.getByRole('menuitem', { name: 'PDF ersetzen' })).toBeTruthy()
  fireEvent.click(await screen.findByRole('menuitem', { name: 'PDF öffnen' }))
  expect(open).toHaveBeenCalledWith('/api/reference/p1?v=2', '_blank', 'noopener')
  vi.unstubAllGlobals()
})

it('a module without a PDF is the row that picks one: no kebab, and the press opens the file picker', async () => {
  const pick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
  render(<ObjectPlansView
    modules={[{ id: 'modul1', title: 'Übersicht', alignment: 'auto' }, { id: 'modul6', title: 'Modul 6', alignment: 'manual' }]}
    overview={() => null} />)
  await screen.findByText('Testhaus')
  fireEvent.click(row())
  const empty = planRow('M1')
  const cells = empty.closest('tr') as HTMLElement
  // the kebab exists only where there IS a PDF; this row keeps its 34px slot empty
  expect(within(cells).queryByRole('button', { name: /^Weitere Aktionen/ })).toBeNull()
  expect(within(cells).getByText('PDF wählen')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Weitere Aktionen · M6' })).toBeTruthy()
  fireEvent.click(empty)
  expect(pick).toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  pick.mockRestore()
})

it('offers the staging wall as its own tab, counted, and off when there is nothing to decide', async () => {
  mount()
  await screen.findByText('Testhaus')
  fireEvent.click(screen.getByRole('button', { name: 'Vorschläge (1)' }))
  // ⚠️ ONE list request for the whole page: the tab hands the wall the queue it already holds
  expect(screen.getByTestId('wall').textContent).toBe('wall true true items:1')
  expect(loadAlignmentQueue).toHaveBeenCalledTimes(1)
  cleanup()
  vi.mocked(loadAlignmentQueue).mockResolvedValue({ items: [{ ...item, status: 'approved' }], capability: { available: true, reason: null } })
  mount()
  await screen.findByText('Testhaus')
  expect(screen.getByRole('button', { name: 'Vorschläge (0)' })).toHaveProperty('disabled', true)
})

it('creates an object on the detail page itself — fields first, plan slots once it exists', async () => {
  saveObjectImpl = () => Promise.resolve({ id: 'o2', name: 'Neubau', address: null, lat: null, lng: null, source_note: null, updated_at: '' })
  mount()
  await screen.findByText('Testhaus')
  fireEvent.click(screen.getByRole('button', { name: 'Objekt hinzufügen' }))
  // no modal, and no plan half before the object has an id to store a plan under
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: /^M6/ })).toBeNull()
  fireEvent.change(screen.getByPlaceholderText('schulhaus-dorfmatt'), { target: { value: 'neubau' } })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Neubau' } })
  // ⚠️ CREATE keeps its one explicit commit — the object's id has to exist before a plan can be
  // stored under it, so typing a name must not mint an object on its own.
  fireEvent.blur(screen.getByLabelText('Name'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Objekt erstellen' })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: 'Objekt erstellen' }))
  // an empty slot IS the row that picks a PDF – the Plan cell says so, there is no button
  expect(await screen.findByRole('button', { name: /^M6/ })).toBeTruthy()
  expect(screen.getByText('PDF wählen')).toBeTruthy()
})

it('writes a corrected field of an EXISTING object when it is left — no «Speichern»', async () => {
  const written = { ...object, address: 'Testweg 14' }
  saveObjectImpl = () => Promise.resolve(written)
  mount()
  await screen.findByText('Testhaus')
  fireEvent.click(row())
  expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull()
  const address = screen.getByLabelText('Adresse')
  fireEvent.change(address, { target: { value: 'Testweg 14' } })
  fireEvent.blur(address)
  expect(await screen.findByText('Gespeichert.')).toBeTruthy()
})

it('names every plan by its short form, never by its storage key, in the order they are bound in', async () => {
  const pv = { ...plan, id: 'p2', module: 'modul5-pv', title: 'PV-Anlage' }
  vi.mocked(listObjects).mockResolvedValue([{ ...object, plans: [plan, pv] }])
  render(<ObjectPlansView
    modules={[
      { id: 'modul5', title: 'Spezialpläne', family: true },
      { id: 'modul6', title: 'Gebäudepläne', alignment: 'manual' },
    ]}
    overview={() => null}
  />)
  await screen.findByText('Testhaus')
  // the list's «Pläne» column — M5 PV before M6, whatever order the server listed them in …
  expect([...document.querySelectorAll('.aop-code')].map(el => el.textContent)).toEqual(['M5 PV', 'M6'])
  expect(screen.queryByText(/modul5-pv/)).toBeNull()
  // … and the Modulpläne table rows, each prefixed by the same short form
  fireEvent.click(row())
  expect(screen.getAllByText('M6')).toHaveLength(1)
  expect(screen.getByText('Gebäudepläne')).toBeTruthy()
  expect(screen.queryByText(/modul5-pv/)).toBeNull()
})
