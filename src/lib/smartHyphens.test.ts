// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseHyphens, smartHyphens } from './smartHyphens'

describe('chooseHyphens', () => {
  it('keeps whole words when hyphenating saves no line («Löschwasserrückhalt / Trinkwasser»)', () => {
    expect(chooseHyphens({ wholeWords: 42, hyphenated: 42, wordOverflows: false })).toBe('manual')
  })
  it('hyphenates when that saves a line', () => {
    expect(chooseHyphens({ wholeWords: 63, hyphenated: 42, wordOverflows: false })).toBe('auto')
  })
  it('hyphenates a word wider than the line on its own, even at the same line count', () => {
    expect(chooseHyphens({ wholeWords: 42, hyphenated: 42, wordOverflows: true })).toBe('auto')
  })
  it('reads a sub-pixel difference as the same line count', () => {
    expect(chooseHyphens({ wholeWords: 41.6, hyphenated: 41.2, wordOverflows: false })).toBe('manual')
  })
})

describe('smartHyphens (ref)', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** jsdom has no layout: a title whose height depends on its `hyphens`, like a real one */
  function title(heights: { manual: number; auto: number }) {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    const el = document.createElement('span')
    el.textContent = 'Löschwasserrückhalt / Trinkwasser'
    el.style.setProperty('-webkit-line-clamp', '2')
    document.body.append(el)
    vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() =>
      ({ width: 200, height: el.style.getPropertyValue('hyphens') === 'auto' ? heights.auto : heights.manual }) as DOMRect)
    return el
  }

  it('measures before the paint and keeps whole words when that costs no line', async () => {
    const el = title({ manual: 42, auto: 42 })
    const cleanup = smartHyphens(el)
    await Promise.resolve()
    expect(el.dataset.hyphens).toBe('manual')
    expect(el.style.getPropertyValue('hyphens')).toBe('')
    // the probe's styles are put back: the clamp stays, nothing else is left inline
    expect(el.style.getPropertyValue('-webkit-line-clamp')).toBe('2')
    expect(el.style.getPropertyValue('display')).toBe('')
    cleanup?.()
  })

  it('sets hyphens: auto inline when hyphenating saves a line', async () => {
    const el = title({ manual: 63, auto: 42 })
    const cleanup = smartHyphens(el)
    await Promise.resolve()
    expect(el.dataset.hyphens).toBe('auto')
    expect(el.style.getPropertyValue('hyphens')).toBe('auto')
    cleanup?.()
  })
})
