// @vitest-environment jsdom
// The armed tool's pill row folds instead of ellipsising (sweep 30.10.2026 #8): the name first,
// then «Mehrere platzieren»'s word – measured, so a wider screen gives the words back.
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fitArmedPill } from '../lib/armedPillFit'
import { ArmedToolPill } from './ArmedToolPill'

const row = (lock = true) => render(
  <ArmedToolPill glyph={<svg />} name="Fahrzeug" lock={lock ? { on: false, onToggle: () => {} } : undefined} onClose={() => {}} />,
).container.querySelector<HTMLElement>('.armed-pill-row')!

/** a row that fits once it has folded `need` steps */
const fitsAt = (need: number) => (el: HTMLElement) => Number(el.dataset.fit ?? 0) < need

describe('fitArmedPill', () => {
  it('keeps every word when the row fits', () => {
    const el = row()
    expect(fitArmedPill(el, fitsAt(0))).toBe(0)
    expect(el.dataset.fit).toBeUndefined()
  })

  it('folds the name first; the toggle keeps its word and needs no hold', () => {
    const el = row()
    expect(fitArmedPill(el, fitsAt(1))).toBe(1)
    expect(el.dataset.fit).toBe('1')
    expect(el.querySelector('.armed-pill')!.getAttribute('aria-label')).toBe('Fahrzeug')
    expect(el.querySelector('.armed-pill-lock')!.hasAttribute('data-holdexplain')).toBe(false)
  })

  it('then the toggle folds to its glyph, and a hold says its word', () => {
    const el = row()
    expect(fitArmedPill(el, fitsAt(2))).toBe(2)
    expect(el.querySelector('.armed-pill-lock')!.hasAttribute('data-holdexplain')).toBe(true)
    expect(el.querySelector('.armed-pill-lock')!.getAttribute('aria-label')).toBe('Mehrere platzieren')
  })

  it('gives the words back when the row fits again', () => {
    const el = row()
    fitArmedPill(el, fitsAt(2))
    expect(fitArmedPill(el, fitsAt(0))).toBe(0)
    expect(el.dataset.fit).toBeUndefined()
    expect(el.querySelector('.armed-pill-lock')!.hasAttribute('data-holdexplain')).toBe(false)
  })

  it('without the toggle, the name is the only step', () => {
    expect(fitArmedPill(row(false), fitsAt(5))).toBe(1)
  })
})
