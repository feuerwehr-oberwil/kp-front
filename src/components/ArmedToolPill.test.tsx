// @vitest-environment jsdom
// The armed tool's pill row folds instead of ellipsising (sweep 30.10.2026 #8): the name first,
// then the dock tiles' words – measured, so a wider screen gives the words back. Beside the pill a
// symbol's «Mehrere» and ✕ are dock tiles (button sweep CHROME.3/.4, owner pick 11, 17.11.2026).
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { appConfig } from '../config/appConfig'
import { loadPrefs, savePrefs } from '../lib/prefs'
import { fitArmedPill } from '../lib/armedPillFit'
import { ArmedToolPill } from './ArmedToolPill'

const row = (lock = true) => render(
  <ArmedToolPill glyph={<svg />} name="Fahrzeug" lock={lock ? { on: false, onToggle: () => {} } : undefined} onClose={() => {}} />,
).container.querySelector<HTMLElement>('.armed-pill-row')!

afterEach(() => {
  cleanup()
  savePrefs({ ...loadPrefs(), railLabels: undefined, railLabelsChosen: undefined })
})

const lockTile = (el: HTMLElement) => el.querySelector<HTMLElement>(`[aria-label="${appConfig.copy.keepPlacing}"]`)!
const words = (el: HTMLElement) => [...el.querySelectorAll('.wb-dock-word')].map((w) => w.textContent)

describe('ArmedToolPill · the symbol\'s «Mehrere» and ✕', () => {
  it('are the dock\'s tiles, worded like the dock, the ✕ last', () => {
    const el = row()
    expect(el.querySelector('.armed-pill-dock')!.className).toContain('worded')
    expect(words(el)).toEqual([appConfig.copy.keepPlacingShort, appConfig.copy.cancel])
    expect(lockTile(el).className).toContain('wb-dock-tog')
    expect(el.querySelector('.armed-pill-dock')!.lastElementChild!.className).toBe('wb-dock-x')
    expect(screen.getByRole('button', { name: appConfig.copy.keepPlacing }).getAttribute('aria-pressed')).toBe('false')
  })

  it('go bare together with «Beschriftung» off, and the ladder then only folds the name', () => {
    savePrefs({ ...loadPrefs(), railLabels: 'off', railLabelsChosen: true })
    const el = row()
    expect(words(el)).toEqual([])
    expect(fitArmedPill(el, fitsAt(5))).toBe(1)
  })
})

/** a row that fits once it has folded `need` steps */
const fitsAt = (need: number) => (el: HTMLElement) => Number(el.dataset.fit ?? 0) < need

describe('fitArmedPill', () => {
  it('keeps every word when the row fits', () => {
    const el = row()
    expect(fitArmedPill(el, fitsAt(0))).toBe(0)
    expect(el.dataset.fit).toBeUndefined()
  })

  it('folds the name first; the tiles keep their words and need no hold', () => {
    const el = row()
    expect(fitArmedPill(el, fitsAt(1))).toBe(1)
    expect(el.dataset.fit).toBe('1')
    expect(el.querySelector('.armed-pill')!.getAttribute('aria-label')).toBe('Fahrzeug')
    expect(lockTile(el).hasAttribute('data-holdexplain')).toBe(false)
  })

  it('then the tiles fold to their glyphs, and a hold says each word', () => {
    const el = row()
    expect(fitArmedPill(el, fitsAt(2))).toBe(2)
    for (const b of el.querySelectorAll('.armed-pill-dock > button')) expect(b.hasAttribute('data-holdexplain')).toBe(true)
    expect(lockTile(el).getAttribute('aria-label')).toBe(appConfig.copy.keepPlacing)
  })

  it('gives the words back when the row fits again', () => {
    const el = row()
    fitArmedPill(el, fitsAt(2))
    expect(fitArmedPill(el, fitsAt(0))).toBe(0)
    expect(el.dataset.fit).toBeUndefined()
    expect(lockTile(el).hasAttribute('data-holdexplain')).toBe(false)
  })

  it('without the tiles, the name is the only step', () => {
    const el = render(<ArmedToolPill glyph={<svg />} name="Linie" />).container.querySelector<HTMLElement>('.armed-pill-row')!
    expect(fitArmedPill(el, fitsAt(5))).toBe(1)
  })
})
