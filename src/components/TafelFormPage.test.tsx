// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { StrictMode, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TafelFormPage } from './TafelFormPage'
import { newFormPage, type BoardFormData } from '../lib/boardForm'
import { BUNDLED_TEMPLATES } from '../lib/boardTemplates'

afterEach(cleanup)

const FKS = BUNDLED_TEMPLATES[0]
const EF = FKS.pages.find((p) => p.id === 'ef')!

/** the page with its own state, the way the Whiteboard holds it — and every commit counted,
 *  because a commit is a ↶ step */
function Harness({ onCommit }: { onCommit: (d: BoardFormData) => void }) {
  const [data, setData] = useState(() => newFormPage(FKS, EF, { vehicles: ['TLF 1'] }, '2026-10-10T09:24:00.000Z'))
  return (
    <TafelFormPage data={data} readOnly={false} isPhone={false} onRemove={() => {}}
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
    const row = commits.at(-1)!.values.massnahmen.rows![0]
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
    const wann = screen.getAllByLabelText('Wann')[1] as HTMLTextAreaElement // Mittel's first row (TLF 1)
    act(() => { wann.focus() })
    type('1124'); key('Tab')
    expect(commits.at(-1)!.values.mittel.rows![0].cells.wann).toBe('11:24')
    const auftrag = screen.getAllByLabelText('Auftrag/Wo')[0] as HTMLTextAreaElement
    act(() => { auftrag.focus() })
    type('Riegel'); key('Escape')
    expect(auftrag.value).toBe('')
  })

  it('the Abspracherapport is a fixed list: its Signaturen are pictures, only «Ort» is typed', () => {
    render(<Harness onCommit={() => {}} />)
    const abs = document.querySelector('[data-sec="absprachen"]')!
    expect(abs.querySelectorAll('svg').length).toBe(6)
    expect(abs.querySelectorAll('textarea').length).toBe(6)
    expect(abs.textContent).toContain('Sammelstelle Unverletzte')
    expect(abs.textContent).not.toContain('Wasserbezug') // a station switch, off in the FKS poster
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
