// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addPerson, composerFoundLink, composerRowSuffix, emptySuche, personenViews, suggestSuchePersonen, type SucheCx } from '../../lib/suche'
import { HEAD_FIT_STEPS } from '../../lib/useHeadFit'
import { floorLabel } from '../../lib/whiteboard'
import { JournalComposer } from '../JournalComposer'

// The final walk-through on staging (25.09.2026): the composer's group chip in real sentences, and
// the head at 360 px.

afterEach(cleanup)
let n = 0
const cx = (): SucheCx => ({ at: '2026-09-25T19:10:00.000Z', newId: (p) => `${p}${++n}`, floorName: floorLabel, stack: 'k1' })
function world() {
  let d = addPerson(emptySuche(), { name: 'Klasse 4b', count: 5 }, cx()).doc
  d = addPerson(d, { name: 'Eva Beispiel' }, cx()).doc
  d = addPerson(d, { name: 'Klasse 4c', count: 3 }, cx()).doc
  return personenViews(d)
}
const hit = (text: string) => suggestSuchePersonen(text, world()).map((v) => v.label)
const count = (text: string) => {
  const v = suggestSuchePersonen(text, world())[0]
  const l = v && composerFoundLink(text, v)
  return l && l.kind === 'gefunden' ? l.n : undefined
}

describe('R2 · a group is found by its name ANYWHERE in the sentence, with the count the sentence says', () => {
  it.each([
    ['Klasse 4b', 1],
    ['Klasse 4b: 3 gefunden', 3],
    ['3 von Klasse 4b gefunden', 3],
    ['2 Kinder der Klasse 4b am Sammelplatz', 2],
    ['zwei Kinder der Klasse 4b beim Hauswart', 2],
    ['Klasse 4b – Rest (4) im Treppenhaus', 4],
    ['klasse 4B, 1 Kind', 1],
  ])('«%s» → Klasse 4b, %i gefunden', (text, want) => {
    expect(hit(text)[0]).toBe('Klasse 4b')
    expect(count(text)).toBe(want)
  })

  it('a count larger than what is missing is not a count for this group; the group\'s own digits never are', () => {
    expect(count('Klasse 4b: 12 gefunden')).toBe(1)
    expect(count('Klasse 4b')).toBe(1)
  })

  it('names that are not all in the sentence are not offered; typing still is', () => {
    expect(hit('Kinder der Klasse am Sammelplatz')).toEqual([])
    expect(hit('eva im Keller')).toEqual([])
    expect(hit('Eva Beispiel am Sammelplatz')).toEqual(['Eva Beispiel'])
    expect(hit('eva bei')).toEqual(['Eva Beispiel'])
    // the one the sentence NAMES comes first
    expect(hit('Klasse 4c')[0]).toBe('Klasse 4c')
  })

  it('the composer offers the chip for a real sentence and names the count', () => {
    render(<JournalComposer onSubmit={vi.fn()} onClose={vi.fn()} suchePersonen={world()} sucheLink={null} onSucheLink={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '3 von Klasse 4b gefunden' } })
    expect(screen.getByRole('button', { name: /Klasse 4b · 3 von 5 gefunden/ })).toBeTruthy()
  })
})

describe('R1 · the head drops ↷ before any chip gives, and no chip ever loses its icon', () => {
  const css = readFileSync(`${process.cwd()}/src/styles/10-journal.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const stepOf = (sel: string) => Number(new RegExp(`\\.topbar\\.fit-(\\d+)[^{]*${sel}`).exec(css)?.[1])

  it('↷ and the gaps go before the Suche\'s words and the alarm\'s name', () => {
    expect(stepOf('tb-act-redo')).toBeLessThan(stepOf('tb-suche-full'))
    expect(stepOf('tb-act-redo')).toBeLessThan(stepOf('tb-az-name'))
    expect(HEAD_FIT_STEPS.indexOf('redo')).toBeLessThan(HEAD_FIT_STEPS.indexOf('vermisst-words'))
    expect(HEAD_FIT_STEPS.indexOf('gaps')).toBeLessThan(HEAD_FIT_STEPS.indexOf('vermisst-words'))
  })

  it('no step hides a chip\'s icon, and a chip is at least a tap wide', () => {
    expect(css).not.toMatch(/\.topbar\.fit-\d+[^{]*:is\(\.tb-suche, \.tb-az\) > \.i \{\s*display:\s*none/)
    expect(css).not.toMatch(/\.topbar\.fit-\d+[^{]*\.tb-(suche|az)[^{]*> \.i[^{]*\{\s*display:\s*none/)
    expect(css).toMatch(/\.topbar :is\(\.tb-az, \.tb-suche\) \{ min-width: var\(--tap\)/)
  })
})

describe('the Verlauf row says the change once', () => {
  const link = (text: string) => { const v = suggestSuchePersonen(text, world())[0]; return composerFoundLink(text, v) }
  it.each([
    ['3 von Klasse 4b gefunden', ''],
    ['Klasse 4b: drei gefunden', ''],
    ['Klasse 4b: 3 gefunden, Rest noch im Keller', ''],
    ['3 Kinder der Klasse 4b am Sammelplatz', ' · Suche: 3 von Klasse 4b gefunden'],
    ['Klasse 4b gefunden', ' · Suche: 1 von Klasse 4b gefunden'],
    ['Eva Beispiel gefunden', ''],
    ['Eva Beispiel am Sammelplatz', ' · Suche: Eva Beispiel gefunden'],
  ])('«%s» → «%s»', (text, suffix) => {
    expect(composerRowSuffix(text, link(text))).toBe(suffix)
  })

  it('a new person reported in the sentence is not reported twice', () => {
    expect(composerRowSuffix('Hauswart meldet: Tim Muster vermisst', { kind: 'neu', name: 'Tim Muster' })).toBe('')
  })
})
