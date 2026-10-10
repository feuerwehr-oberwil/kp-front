// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { StrictMode, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TafelFormPage } from './TafelFormPage'
import { newFormPage, putRow, type BoardFormData } from '../lib/boardForm'
import { BUNDLED_TEMPLATES } from '../lib/boardTemplates'
import { getLocaleId } from '../config/copy'

afterEach(cleanup)

const FKS = BUNDLED_TEMPLATES[0]
const EF = FKS.pages.find((p) => p.id === 'ef')!

/** the page with its own state, the way the Whiteboard holds it — and every commit counted,
 *  because a commit is a ↶ step */
function Harness({ onCommit, vehicles = ['TLF 1'] }: { onCommit: (d: BoardFormData) => void; vehicles?: string[] }) {
  const [data, setData] = useState(() => newFormPage(FKS, EF, { vehicles }, '2026-10-10T09:24:00.000Z'))
  return (
    <TafelFormPage pageKey="fm-test" data={data} readOnly={false} isPhone={false} onRemove={() => {}}
      inset={{ top: 0, left: 0, right: 0, bottom: 0 }}
      onChange={(d) => { onCommit(d); setData(d) }} />
  )
}

const active = () => document.activeElement as HTMLTextAreaElement
const box = (id: string) => document.querySelector(`[data-box="${id}"]`)!
const type = (text: string) => fireEvent.change(active(), { target: { value: text } })
const key = (k: string, opts: Partial<KeyboardEventInit> = {}) => act(() => { fireEvent.keyDown(active(), { key: k, ...opts }) })

describe('a Tafel page by keyboard, like a spreadsheet', () => {
  it('Enter writes line after line in a box; Enter on its empty line moves on to Massnahmen', () => {
    const commits: BoardFormData[] = []
    render(<StrictMode><Harness onCommit={(d) => commits.push(d)} /></StrictMode>)
    act(() => { box('front').querySelector<HTMLTextAreaElement>('[data-kn]')!.focus() })
    for (const t of ['Rettungen Haus 19', 'Rettungen Haus 21']) { type(t); key('Enter') }
    expect(commits).toHaveLength(2) // one ↶ step per committed line
    expect(commits[1].values.problem.lines?.front?.map((l) => l.text)).toEqual(['Rettungen Haus 19', 'Rettungen Haus 21'])
    expect(active().getAttribute('data-kn')).toBe('problem|front|+new|')
    key('Enter')
    expect(active().getAttribute('aria-label')).toBe('Was/Wo')
    expect(commits).toHaveLength(2) // leaving an empty line writes nothing
  })

  it('Tab goes across the columns; Enter stamps an empty «Wann» and goes down in the same column', () => {
    const commits: BoardFormData[] = []
    render(<Harness onCommit={(d) => commits.push(d)} />)
    const was = screen.getAllByLabelText('Was/Wo')[0] as HTMLTextAreaElement
    act(() => { was.focus() })
    type('Personensuche 1. OG'); key('Tab')
    expect(active().getAttribute('aria-label')).toBe('Wer')
    type('AS Trupp 1'); key('Enter')
    expect(active().getAttribute('aria-label')).toBe('Wer')
    expect(active().getAttribute('data-kn')).toBe('massnahmen||+new|wer')
    const row = commits[commits.length - 1].values.massnahmen.rows![0]
    expect(row.cells.was).toBe('Personensuche 1. OG')
    expect(row.cells.wer).toBe('AS Trupp 1')
    expect(row.cells.wann).toMatch(/^\d\d:\d\d$/)
    key('Tab', { shiftKey: true })
    expect(active().getAttribute('aria-label')).toBe('Was/Wo')
    key('Tab', { shiftKey: true })
    expect(active().getAttribute('aria-label')).toBe('Wann') // the row above, last column
  })

  it('«1124» in a Wann is 11:24; Esc puts the stored value back', () => {
    const commits: BoardFormData[] = []
    render(<Harness onCommit={(d) => commits.push(d)} />)
    const mittel = document.querySelector('[data-sec="mittel"]')!
    const wann = mittel.querySelectorAll<HTMLTextAreaElement>('[aria-label="Wann"]')[0] // Mittel's first row (TLF 1)
    act(() => { wann.focus() })
    type('1124'); key('Tab')
    expect(commits[commits.length - 1].values.mittel.rows![0].cells.wann).toBe('11:24')
    const auftrag = mittel.querySelectorAll<HTMLTextAreaElement>('[aria-label="Auftrag/Wo"]')[0]
    act(() => { auftrag.focus() })
    type('Riegel'); key('Escape')
    expect(auftrag.value).toBe('')
  })

  it('the Abspracherapport: six printed rows with their Signaturen (only «Ort» typed), and a row under them that types the rest', () => {
    const commits: BoardFormData[] = []
    render(<Harness onCommit={(d) => commits.push(d)} />)
    const abs = document.querySelector('[data-sec="absprachen"]')!
    expect(abs.querySelectorAll('svg').length).toBe(6)
    expect(abs.querySelectorAll('textarea[aria-label="Ort"]').length).toBe(7)
    // every box drawn is writable: the row under «Warteraum» names itself (owner, round 2)
    const bez = abs.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Bezeichnung"]')
    expect(bez.length).toBe(1)
    expect(abs.textContent?.replace(/\u00ad/g, '')).toContain('Sammelstelle Unverletzte')
    expect(abs.textContent).not.toContain('Wasserbezug') // a station switch, off in the FKS poster
    act(() => { bez[0].focus() })
    type('Helikopterlandeplatz'); key('Tab')
    type('Sportplatz'); key('Enter')
    const row = commits[commits.length - 1].values.absprachen.rows!.find((r) => !r.id.startsWith('patienten') && r.cells.bez)!
    expect(row.cells).toEqual({ bez: 'Helikopterlandeplatz', ort: 'Sportplatz' })
  })

  it('every ruled empty row of a table is a live row', () => {
    render(<Harness onCommit={() => {}} />)
    const mass = document.querySelector('[data-sec="massnahmen"]')!
    // 11 rulings on the poster: the trailing row and the empty ones under it are all inputs
    expect(mass.querySelectorAll('textarea[aria-label="Was/Wo"]').length).toBe(11)
    expect(mass.querySelectorAll('[aria-hidden="true"][role="row"]').length).toBe(0)
  })

  it('a focused cell that was only passed through never writes its old text back over a remote change', () => {
    const commits: BoardFormData[] = []
    const { rerender } = render(<Harness onCommit={(d) => commits.push(d)} />)
    void rerender
    const was = document.querySelector<HTMLTextAreaElement>('[data-sec="massnahmen"] [data-kn$="|was"]')!
    act(() => { was.focus() })
    key('Tab') // nothing typed: no write
    key('Tab', { shiftKey: true })
    act(() => { (document.activeElement as HTMLElement).blur() })
    expect(commits).toHaveLength(0)
  })

  it('every write carries its edit time — a typed line and a trend tap alike (what settles a two-device clash)', () => {
    const commits: BoardFormData[] = []
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      render(<Harness onCommit={(d) => commits.push(d)} />)
      act(() => { box('front').querySelector<HTMLTextAreaElement>('[data-kn]')!.focus() })
      type('Rauch'); key('Enter')
      const id = commits[0].values.problem.lines!.front![0].id
      const atom = `l|problem|front|${id}`
      expect(commits[0].t).toEqual({ [atom]: 1_000_000 })
      now.mockReturnValue(1_005_000)
      act(() => { fireEvent.click(box('front').querySelector('[data-trend]')!) })
      const last = commits[commits.length - 1]
      expect(last.values.problem.lines!.front![0].trend).toBe('up')
      expect(last.t).toEqual({ [atom]: 1_005_000 })
    } finally { now.mockRestore() }
  })

  it('the page carries the deployment locale, so typed words hyphenate like the language they are in', () => {
    render(<Harness onCommit={() => {}} />)
    expect(document.querySelector('[data-testid="tafel-page"]')!.getAttribute('lang')).toBe(getLocaleId())
  })

  it('a row typed on the 8th ruling stays there (owner, staging round 2), and Enter goes to the 9th', () => {
    const commits: BoardFormData[] = []
    render(<Harness vehicles={['TLF', 'ADF', 'MTF']} onCommit={(d) => commits.push(d)} />)
    const formation = () => [...document.querySelectorAll<HTMLTextAreaElement>('[data-sec="mittel"] textarea[aria-label="Formation"]')]
    expect(formation().slice(0, 3).map((t) => t.value)).toEqual(['TLF', 'ADF', 'MTF'])
    act(() => { formation()[7].focus() })
    type('Test 1'); key('Enter')
    expect(formation().map((t) => t.value).slice(0, 9)).toEqual(['TLF', 'ADF', 'MTF', '', '', '', '', 'Test 1', ''])
    expect(active()).toBe(formation()[8]) // directly below the row just written, same column
    type('Test 2'); key('Enter')
    expect(formation().map((t) => t.value).slice(3, 10)).toEqual(['', '', '', '', 'Test 1', 'Test 2', ''])
    expect(active()).toBe(formation()[9])
    // an empty ruling ABOVE written rows is a row like any other: Enter there goes on down
    act(() => { formation()[4].focus() })
    key('Enter')
    expect(active()).toBe(formation()[5])
  })

  it('a Problemerfassung line emptied in the middle leaves an empty line; the lines below stay', () => {
    const commits: BoardFormData[] = []
    render(<Harness onCommit={(d) => commits.push(d)} />)
    act(() => { box('front').querySelector<HTMLTextAreaElement>('[data-kn]')!.focus() })
    for (const t of ['Rauch', 'Rettung', 'Dach']) { type(t); key('Enter') }
    const lines = () => [...box('front').querySelectorAll<HTMLTextAreaElement>('textarea')].map((t) => t.value)
    expect(lines()).toEqual(['Rauch', 'Rettung', 'Dach', ''])
    act(() => { box('front').querySelectorAll<HTMLTextAreaElement>('textarea')[0].focus() })
    type(''); key('Enter')
    expect(lines()).toEqual(['', 'Rettung', 'Dach', ''])
  })

  it('beside a taller neighbour a table gets more rulings of the standard height — live rows, never a stretched one', () => {
    // the browser's layout, as jsdom has none: the Verbindungen' leftover is 240px, a ruling 45px
    class RO { constructor(private cb: () => void) {} observe() {} disconnect() {} }
    vi.stubGlobal('ResizeObserver', RO)
    const ch = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.fill === 'verbindungen' ? 240 : this.dataset.fill ? 20 : 0
    })
    const oh = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => 45)
    try {
      const commits: BoardFormData[] = []
      render(<Harness onCommit={(d) => commits.push(d)} />)
      const fillBox = document.querySelector('[data-fill="verbindungen"]')!
      const kanal = fillBox.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Kanal"]')
      expect(kanal.length).toBe(5) // 240 / 45 → five whole rulings
      // less than one ruling left: plain space, no row
      expect(document.querySelector('[data-fill="massnahmen"]')!.children.length).toBe(0)
      // no row anywhere is given a height of its own
      expect([...document.querySelectorAll<HTMLElement>('[role="row"]')].every((r) => !r.style.height && !r.style.minHeight)).toBe(true)
      // …and a ruling of the leftover is written ON its ruling, below the box's twelve
      act(() => { kanal[0].focus() })
      type('K1'); key('Enter')
      const row = commits[commits.length - 1].values.verbindungen.rows!.find((r) => r.cells.kanal === 'K1')!
      expect(row.slot).toBe(12)
    } finally { ch.mockRestore(); oh.mockRestore(); vi.unstubAllGlobals() }
  })

  it('«Drucken» sits next to the delete: this page — and with more pages, «Alle Seiten» too', () => {
    const printed: boolean[] = []
    const data = newFormPage(FKS, EF, {}, '2026-10-10T09:24:00.000Z')
    const props = { pageKey: 'p', data, readOnly: true, isPhone: false, onChange: () => {}, onRemove: () => {}, inset: { top: 0, left: 0, right: 0, bottom: 0 }, onPrint: (all: boolean) => printed.push(all) }
    const { rerender } = render(<TafelFormPage {...props} pageCount={1} />)
    // on a closed Einsatz too: the paper is a reading
    act(() => { fireEvent.click(screen.getByRole('button', { name: /Drucken/ })) })
    expect(printed).toEqual([false])
    rerender(<TafelFormPage {...props} pageCount={3} />)
    act(() => { fireEvent.click(screen.getByRole('button', { name: /Drucken/ })) })
    act(() => { fireEvent.click(screen.getByRole('menuitem', { name: 'Alle Seiten (3)' })) })
    expect(printed).toEqual([false, true])
  })

  it('a cell holds 2000 characters and says so calmly when it is full (re-review of #338)', () => {
    render(<Harness onCommit={() => {}} />)
    const was = document.querySelector<HTMLTextAreaElement>('[data-sec="massnahmen"] [data-kn$="|was"]')!
    expect(was.maxLength).toBe(2000)
    act(() => { was.focus() })
    type('x'.repeat(2000))
    expect(screen.getByRole('status').textContent).toMatch(/2000 Zeichen/)
  })

  it('typing over a value another device wrote meanwhile: the later stands, and it is said (re-review of #338)', () => {
    const base = putRow(newFormPage(FKS, EF, {}, '2026-10-10T09:24:00.000Z'), 'massnahmen', 'm1', { cells: { was: 'Riegel' } })
    const clashes: string[][] = []
    const props = { pageKey: 'p', readOnly: false, isPhone: false, onRemove: () => {}, inset: { top: 0, left: 0, right: 0, bottom: 0 }, onChange: () => {}, onConflict: (w: string, k: string, l: string) => clashes.push([w, k, l]) }
    const { rerender } = render(<TafelFormPage {...props} data={base} />)
    const was = () => document.querySelector<HTMLTextAreaElement>('[data-sec="massnahmen"] [data-k="massnahmen||m1|was"]')!
    act(() => { was().focus() })
    type('Riegel Seite C')
    // …meanwhile the other tablet's «Riegel Seite B» lands for the same cell
    rerender(<TafelFormPage {...props} data={putRow(base, 'massnahmen', 'm1', { cells: { was: 'Riegel Seite B' } })} />)
    key('Enter')
    expect(clashes).toEqual([['Massnahmen · Was/Wo', 'Riegel Seite C', 'Riegel Seite B']])
    // a cell nobody else touched writes quietly
    act(() => { was().focus() })
    type('Riegel Seite D'); key('Enter')
    expect(clashes).toHaveLength(1)
  })

  it('Alt+Enter is a line break inside the cell, not a move', () => {
    render(<Harness onCommit={() => {}} />)
    act(() => { box('ordnung').querySelector<HTMLTextAreaElement>('[data-kn]')!.focus() })
    type('R-Achse')
    const el = active()
    el.setSelectionRange(7, 7)
    key('Enter', { altKey: true })
    expect(active()).toBe(el)
    expect(el.value).toBe('R-Achse\n')
  })
})
