import { describe, expect, it } from 'vitest'
import { NEW, navTarget, type NavSection } from './boardFormNav'

// the Erste Führung, as the keyboard sees it: two boxes written in, an empty map (no cells), a
// table with one row, a fixed list, and the trailing rows that wear ids p1…p6 right now
const layout: NavSection[] = [
  { kind: 'quad', id: 'problem', boxes: [
    { id: 'front', lines: ['f1', 'f2'], newId: 'p1' },
    { id: 'ordnung', lines: ['o1'], newId: 'p2' },
    { id: 'sanitaet', lines: [], newId: 'p3' },
    { id: 'spezial', lines: [], newId: 'p4' },
  ] },
  { kind: 'table', id: 'massnahmen', cols: ['was', 'wer', 'wann'], rows: ['m1'], adds: true, newId: 'p5' },
  { kind: 'table', id: 'absprachen', cols: ['ort'], rows: ['psst', 'shst', 'warteraum'], adds: false },
]

describe('Enter goes DOWN', () => {
  it('to the next line of the same box, then its empty line', () => {
    expect(navTarget(layout, { sec: 'problem', box: 'front', row: 'f1' }, 'enter', false)).toEqual({ sec: 'problem', box: 'front', row: 'f2' })
    expect(navTarget(layout, { sec: 'problem', box: 'front', row: 'f2' }, 'enter', false)).toEqual({ sec: 'problem', box: 'front', row: NEW })
  })
  it('a written trailing line becomes a line — Enter opens the next empty one', () => {
    expect(navTarget(layout, { sec: 'problem', box: 'front', row: 'p1' }, 'enter', false)).toEqual({ sec: 'problem', box: 'front', row: NEW })
  })
  it('Enter on the EMPTY trailing line leaves the list for the next section (you cannot get stuck)', () => {
    expect(navTarget(layout, { sec: 'problem', box: 'front', row: 'p1' }, 'enter', true)).toEqual({ sec: 'massnahmen', row: 'm1', col: 'was' })
  })
  it('in a table: the next row, SAME column', () => {
    expect(navTarget(layout, { sec: 'massnahmen', row: 'm1', col: 'wer' }, 'enter', false)).toEqual({ sec: 'massnahmen', row: NEW, col: 'wer' })
    expect(navTarget(layout, { sec: 'massnahmen', row: 'p5', col: 'wer' }, 'enter', false)).toEqual({ sec: 'massnahmen', row: NEW, col: 'wer' })
    expect(navTarget(layout, { sec: 'absprachen', row: 'psst', col: 'ort' }, 'enter', false)).toEqual({ sec: 'absprachen', row: 'shst', col: 'ort' })
  })
  it('a fixed list ends at its last row, and the last section lets go', () => {
    expect(navTarget(layout, { sec: 'absprachen', row: 'warteraum', col: 'ort' }, 'enter', false)).toBe('blur')
    expect(navTarget(layout, { sec: 'massnahmen', row: 'p5', col: 'was' }, 'enter', true)).toEqual({ sec: 'absprachen', row: 'psst', col: 'ort' })
  })
  it('a row that is emptied on this commit is left by its id — the next row is still the next row', () => {
    expect(navTarget(layout, { sec: 'problem', box: 'front', row: 'f1' }, 'enter', true)).toEqual({ sec: 'problem', box: 'front', row: 'f2' })
  })
})

describe('Tab goes ACROSS', () => {
  it('box to box, keeping the line, wrapping Ordnung → Sanität, and on to the next section', () => {
    expect(navTarget(layout, { sec: 'problem', box: 'front', row: 'f1' }, 'tab', false)).toEqual({ sec: 'problem', box: 'ordnung', row: 'o1' })
    // Ordnung has one line: the second line of Front lands on its empty one
    expect(navTarget(layout, { sec: 'problem', box: 'front', row: 'f2' }, 'tab', false)).toEqual({ sec: 'problem', box: 'ordnung', row: NEW })
    expect(navTarget(layout, { sec: 'problem', box: 'ordnung', row: 'o1' }, 'tab', false)).toEqual({ sec: 'problem', box: 'sanitaet', row: NEW })
    expect(navTarget(layout, { sec: 'problem', box: 'spezial', row: 'p4' }, 'tab', true)).toEqual({ sec: 'massnahmen', row: 'm1', col: 'was' })
  })
  it('column to column inside a row — a trailing row is named by its own id, never by NEW', () => {
    expect(navTarget(layout, { sec: 'massnahmen', row: 'm1', col: 'was' }, 'tab', false)).toEqual({ sec: 'massnahmen', row: 'm1', col: 'wer' })
    expect(navTarget(layout, { sec: 'massnahmen', row: 'p5', col: 'was' }, 'tab', false)).toEqual({ sec: 'massnahmen', row: 'p5', col: 'wer' })
  })
  it('from the last column to the next row, first column', () => {
    expect(navTarget(layout, { sec: 'massnahmen', row: 'm1', col: 'wann' }, 'tab', false)).toEqual({ sec: 'massnahmen', row: NEW, col: 'was' })
    expect(navTarget(layout, { sec: 'massnahmen', row: 'p5', col: 'wann' }, 'tab', false)).toEqual({ sec: 'massnahmen', row: NEW, col: 'was' })
    expect(navTarget(layout, { sec: 'massnahmen', row: 'p5', col: 'wann' }, 'tab', true)).toEqual({ sec: 'absprachen', row: 'psst', col: 'ort' })
  })
  it('Shift+Tab is the way back, into the previous section’s last cell', () => {
    expect(navTarget(layout, { sec: 'massnahmen', row: 'm1', col: 'wer' }, 'shift-tab', false)).toEqual({ sec: 'massnahmen', row: 'm1', col: 'was' })
    expect(navTarget(layout, { sec: 'massnahmen', row: 'p5', col: 'was' }, 'shift-tab', false)).toEqual({ sec: 'massnahmen', row: 'm1', col: 'wann' })
    expect(navTarget(layout, { sec: 'massnahmen', row: 'm1', col: 'was' }, 'shift-tab', false)).toEqual({ sec: 'problem', box: 'spezial', row: NEW })
    expect(navTarget(layout, { sec: 'problem', box: 'sanitaet', row: 'p3' }, 'shift-tab', false)).toEqual({ sec: 'problem', box: 'ordnung', row: 'o1' })
    expect(navTarget(layout, { sec: 'absprachen', row: 'psst', col: 'ort' }, 'shift-tab', false)).toEqual({ sec: 'massnahmen', row: NEW, col: 'wann' })
  })
  it('before the first cell there is nowhere to go: stay', () => {
    expect(navTarget(layout, { sec: 'problem', box: 'front', row: 'f1' }, 'shift-tab', false)).toBeNull()
  })
})

describe('text sections and sections with nothing to type', () => {
  const page: NavSection[] = [
    { kind: 'text', id: 'auftrag', fields: ['text'] },
    { kind: 'table', id: 'leer', cols: ['x'], rows: [], adds: false },
    { kind: 'text', id: 'v1', fields: ['text', 'plus', 'minus'] },
  ]
  it('walks field by field and skips a section without cells', () => {
    expect(navTarget(page, { sec: 'auftrag', col: 'text' }, 'enter', false)).toEqual({ sec: 'v1', col: 'text' })
    expect(navTarget(page, { sec: 'v1', col: 'text' }, 'tab', false)).toEqual({ sec: 'v1', col: 'plus' })
    expect(navTarget(page, { sec: 'v1', col: 'text' }, 'shift-tab', false)).toEqual({ sec: 'auftrag', col: 'text' })
    expect(navTarget(page, { sec: 'v1', col: 'minus' }, 'enter', false)).toBe('blur')
  })
})
