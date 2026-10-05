// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fitPageHead, foldLevel, foldRanks, partRanks } from './pageHeadFit'
import { climbLadder, fitHead, HEAD_FIT_STEPS } from './useHeadFit'

/** A head in the shape the pages draw: titles (h2 + quiet line) and tiles carrying ranks. */
function head(html: string): HTMLElement {
  const el = document.createElement('header')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}
const TRUPPS = `
  <div><h2>Trupps</h2><span data-fold="1 8"><span class="fold-long">Gespeichert um 23:21</span><span class="fold-short">Gespeichert</span></span></div>
  <div>
    <button data-fold="5">⚠<span class="fold-long">4 Alarme</span><span class="fold-short">4</span></button>
    <button data-fold="2">▽<span class="fold-long">Reihenfolge</span></button>
    <button data-fold="3">▦<span class="fold-long">Überwachung abgeben</span></button>
    <button data-fold="6">🔔<span class="fold-long">Alarmton</span></button>
    <button data-fold="7">+<span class="fold-long">Trupp anmelden</span><span class="fold-short">Trupp</span></button>
  </div>`
const folded = (h: HTMLElement) => [...h.querySelectorAll<HTMLElement>('[data-fold]')]
  .filter((p) => p.dataset.folded).map((p) => `${p.dataset.fold}:${p.dataset.folded}`)

describe('the page head ladder (lib/pageHeadFit, 28.09.2026)', () => {
  it('one step per rank PRESENT, ascending — a missing tile costs no step', () => {
    expect(foldRanks([7, 1, 5, 1, 8, 3])).toEqual([1, 3, 5, 7, 8])
    expect(foldRanks([])).toEqual([])
    expect(partRanks('1 8')).toEqual([1, 8])
    expect(partRanks(undefined)).toEqual([])
  })

  it('a part folds once its rank has come, and a second time at its second rank', () => {
    const ranks = [1, 3, 5, 7, 8]
    expect(foldLevel(ranks, 0, [1, 8])).toBe(0)
    expect(foldLevel(ranks, 1, [1, 8])).toBe(1)   // «Gespeichert um 23:21» → «Gespeichert»
    expect(foldLevel(ranks, 4, [1, 8])).toBe(1)
    expect(foldLevel(ranks, 5, [1, 8])).toBe(2)   // → «✓»
    expect(foldLevel(ranks, 1, [3])).toBe(0)
    expect(foldLevel(ranks, 2, [3])).toBe(1)
    // the last step (the second row) keeps everything folded
    expect(foldLevel(ranks, 6, [7])).toBe(1)
  })

  it('the time goes first, then the words lowest rank first, the primary last, the row only after', () => {
    const h = head(TRUPPS)
    // «crowded» until N parts have folded: the stub stands in for the layout jsdom does not have
    let room = 0
    const crowded = () => folded(h).length < room
    expect(fitPageHead(h, crowded)).toBe(0)
    expect(h.dataset.fit).toBe('0')
    room = 1
    expect(fitPageHead(h, crowded)).toBe(1)
    expect(folded(h)).toEqual(['1 8:1'])
    room = 3
    fitPageHead(h, crowded)
    expect(folded(h)).toEqual(['1 8:1', '2:1', '3:1'])   // (DOM order) — the alarm's word still stands
    expect(h.hasAttribute('data-fit-wrap')).toBe(false)
  })

  it('then the tiles close up — and only when that is not enough either, a second row', () => {
    const h = head(TRUPPS)
    const last = foldRanks([1, 8, 5, 2, 3, 6, 7]).length
    let tries = 0
    // fits once it has closed up: every word folded, no second row
    expect(fitPageHead(h, () => ++tries <= last + 1)).toBe(last + 1)
    expect(h.hasAttribute('data-fit-tight')).toBe(true)
    expect(h.hasAttribute('data-fit-wrap')).toBe(false)
  })

  it('never crowded-free: every rank folds, the quiet line keeps its mark, and the tiles take a second row', () => {
    const h = head(TRUPPS)
    const steps = fitPageHead(h, () => true)
    expect(steps).toBe(foldRanks([1, 8, 5, 2, 3, 6, 7]).length + 2)
    // the second row has the room: the tiles open up again
    expect(h.hasAttribute('data-fit-tight')).toBe(false)
    expect(h.hasAttribute('data-fit-wrap')).toBe(true)
    expect(h.querySelector<HTMLElement>('[data-fold="1 8"]')!.dataset.folded).toBe('2')
    expect(h.querySelector<HTMLElement>('[data-fold="7"]')!.dataset.folded).toBe('1')
  })

  it('a head that got wider gives its words back (every fit starts from nothing)', () => {
    const h = head(TRUPPS)
    fitPageHead(h, () => true)
    expect(fitPageHead(h, () => false)).toBe(0)
    expect(folded(h)).toEqual([])
    expect(h.hasAttribute('data-fit-wrap')).toBe(false)
    expect(h.hasAttribute('data-fit-tight')).toBe(false)
  })

  it('a head with nothing to fold has two steps: closing up, then the second row', () => {
    const h = head('<div><h2>Material</h2><p>3 Positionen</p></div><div></div>')
    expect(fitPageHead(h, () => true)).toBe(2)
    expect(h.hasAttribute('data-fit-wrap')).toBe(true)
  })
})

describe('the shared ladder (lib/useHeadFit · climbLadder)', () => {
  it('climbs from 0 until it fits or the steps run out', () => {
    const seen: number[] = []
    expect(climbLadder(4, (s) => seen.push(s), () => seen.length < 3)).toBe(2)
    expect(seen).toEqual([0, 1, 2])
    expect(climbLadder(2, () => {}, () => true)).toBe(2)
  })

  it('the top bar still steps its fit-N classes the same way', () => {
    const bar = document.createElement('div')
    bar.classList.add('fit-9')
    let n = 0
    expect(fitHead(bar, () => n++ < 2)).toBe(2)
    expect([...bar.classList]).toEqual(['fit-1', 'fit-2'])
    expect(fitHead(bar, () => false)).toBe(0)
    expect(bar.className).toBe('')
    expect(fitHead(bar, () => true)).toBe(HEAD_FIT_STEPS.length)
  })

  // sweep K2 (29.09.2026): the tablet's Eintrag keeps its word at 820px and gives it up LAST
  it('«Eintrag» is the last word the top bar gives up', () => {
    expect(HEAD_FIT_STEPS[HEAD_FIT_STEPS.length - 1]).toBe('eintrag-word')
  })
})
