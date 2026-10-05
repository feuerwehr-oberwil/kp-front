// @vitest-environment jsdom
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ChecklistsView } from './ChecklistsView'
import { warmTemplates, type ChecklistTemplate } from '../lib/checklists'
import { useMediaQuery } from '../lib/useIsPhone'
import { appConfig } from '../config/appConfig'

vi.mock('../lib/checklists', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/checklists')>(),
  warmTemplates: vi.fn(),
}))
vi.mock('../lib/useIsPhone', () => ({ useMediaQuery: vi.fn() }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Checklist chooser loading', () => {
  it.each([true, false])('shows one loader in the visible rail (narrow: %s) until templates settle', async narrow => {
    vi.mocked(useMediaQuery).mockReturnValue(narrow)
    let resolve!: (templates: ChecklistTemplate[]) => void
    vi.mocked(warmTemplates).mockReturnValue({ list: new Promise(done => { resolve = done }), newer: null })
    const noop = () => {}
    const { container } = render(<ChecklistsView checklists={{}} canTick divera={{}}
      onTick={noop} onBranch={noop} onAction={noop} />)
    expect(within(screen.getByRole('navigation')).getByRole('status').textContent).toBe(appConfig.copy.loading)
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(container.querySelector('.no-hits')).toBeNull()
    if (narrow) expect(container.querySelector('main')).toBeNull()
    await act(async () => resolve([]))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText(appConfig.copy.checklists.none)).toBeTruthy()
  })
})

// 05.10.2026 (owner, iPhone): the open list's chooser row carries no 🔍 and says the list's «n/m»
// (no progress row of its own), and a list closed onto the chooser reopens where it was left.
describe('Checklist chooser row and reading position', () => {
  const tpl = (id: string, title: string) => ({
    id, kind: 'action', title,
    phases: [{ id: `${id}-p`, title: 'Vor Ort', items: [{ id: `${id}-1`, text: 'Eins' }, { id: `${id}-2`, text: 'Zwei' }] }],
  }) as unknown as ChecklistTemplate
  // jsdom keeps no scroll offset of its own — a plain stored number is enough here
  const offsets = new WeakMap<Element, number>()
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get() { return offsets.get(this) ?? 0 },
    set(v: number) { offsets.set(this, v) },
  })
  afterAll(() => { if (desc) Object.defineProperty(Element.prototype, 'scrollTop', desc) })

  it('shows the open list with its own glyph and «n/m», and keeps each list’s scroll offset', async () => {
    vi.mocked(useMediaQuery).mockReturnValue(true)
    vi.mocked(warmTemplates).mockReturnValue({ list: Promise.resolve([tpl('a', 'Aufgaben FU'), tpl('b', 'Lagerapport')]), newer: null })
    const noop = () => {}
    const { container } = render(<ChecklistsView checklists={{ a: { ticks: { 'a-1': { t: '2026-10-05T10:00:00.000Z' } } } }}
      canTick divera={{}} onTick={noop} onBranch={noop} onAction={noop} scrollKey="inc-1" />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: /Aufgaben FU/ }))
    const toggle = screen.getByRole('button', { name: appConfig.copy.checklists.showList })
    expect(toggle.textContent).toContain('1/2')
    expect(toggle.querySelector('use[href="#search"]')).toBeNull()
    // no progress row under the chooser: no bar anywhere
    expect(container.querySelector('[class*="cl-bar"]')).toBeNull()

    const main = container.querySelector('main')!
    main.scrollTop = 300
    fireEvent.scroll(main)
    fireEvent.click(toggle) // back to the chooser…
    expect(container.querySelector('main')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Aufgaben FU/ })) // …and the same list again
    expect(container.querySelector('main')!.scrollTop).toBe(300)
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.checklists.showList }))
    fireEvent.click(screen.getByRole('button', { name: /Lagerapport/ })) // another list starts at the top
    expect(container.querySelector('main')!.scrollTop).toBe(0)
  })

  // 05.10.2026 (owner): «I also meant scrolling the original list (i.e. to quickly go through
  // potentially similar checklists)» — the chooser comes back where it was left
  it('brings the chooser back at the offset it was left at, after a list was opened from it', async () => {
    vi.mocked(useMediaQuery).mockReturnValue(true)
    vi.mocked(warmTemplates).mockReturnValue({ list: Promise.resolve([tpl('a', 'Aufgaben FU'), tpl('b', 'Lagerapport')]), newer: null })
    const noop = () => {}
    const { container } = render(<ChecklistsView checklists={{}} canTick divera={{}}
      onTick={noop} onBranch={noop} onAction={noop} scrollKey="inc-2" />)
    await act(async () => {})
    const nav = container.querySelector('nav')!
    nav.scrollTop = 520
    fireEvent.scroll(nav)
    fireEvent.click(screen.getByRole('button', { name: /Lagerapport/ }))
    expect(container.querySelector('nav')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.checklists.showList }))
    expect(container.querySelector('nav')!.scrollTop).toBe(520)
  })

  // 05.10.2026 (owner): «selected checklists don't persist and on every tab change they disappear»
  it('keeps the open list across a tab change (unmount → mount) and falls back when it is gone', async () => {
    vi.mocked(useMediaQuery).mockReturnValue(true)
    const lists = [tpl('a', 'Aufgaben FU'), tpl('b', 'Lagerapport')]
    vi.mocked(warmTemplates).mockReturnValue({ list: Promise.resolve(lists), newer: null })
    const noop = () => {}
    const view = () => <ChecklistsView checklists={{}} canTick divera={{}}
      onTick={noop} onBranch={noop} onAction={noop} scrollKey="inc-3" />
    const first = render(view())
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: /Lagerapport/ }))
    first.unmount() // another tab
    const { container } = render(view())
    await act(async () => {})
    expect(container.querySelector('nav')).toBeNull() // the list, not the chooser
    expect(screen.getByRole('button', { name: appConfig.copy.checklists.showList }).textContent).toContain('Lagerapport')
    cleanup()
    // the remembered list was removed from the station's set → the first list, as with no pick
    vi.mocked(warmTemplates).mockReturnValue({ list: Promise.resolve([lists[0]]), newer: null })
    render(view())
    await act(async () => {})
    expect(screen.getByRole('button', { name: appConfig.copy.checklists.showList }).textContent).toContain('Aufgaben FU')
  })
})
