// @vitest-environment jsdom
//
// The Rapport group's page switcher (PHONE only). Rapport · Anwesenheit · Material are three
// ordinary separate pages that share ONE tile on the folded bottom bar, so this is how the
// other two are reached from inside the group — and it is a switcher, not a tab strip: the
// pages stay pages (the embedded-tabs version of 18.09.2026 was rejected for stacking three
// navigations on one 360px screen).
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageSwitcher } from './PageSwitcher'

afterEach(cleanup)

const seg = () => [...document.querySelectorAll<HTMLElement>('.pgsw .useg-btn')]
const words = () => seg().map((b) => b.firstChild?.textContent)
const on = () => seg().find((b) => b.getAttribute('aria-pressed') === 'true')

function setup(over: Partial<React.ComponentProps<typeof PageSwitcher>> = {}) {
  const p = { mode: 'rapport' as const, onMode: vi.fn(), ...over }
  render(<PageSwitcher {...p} />)
  return p
}

describe('PageSwitcher', () => {
  // ⚠️ the rail's own words — these are the same three destinations the vertical rail names with
  // three tiles, and one thing gets one word on every form factor
  it('names the three pages in the rail\'s words, Rapport first', () => {
    setup()
    expect(words()).toEqual(['Rapport', 'Anwesenheit', 'Material'])
  })

  it('marks the page that is standing', () => {
    setup({ mode: 'mittel' })
    expect(on()?.textContent).toContain('Material')
  })

  it('switches page on a tap', () => {
    const p = setup({ mode: 'rapport' })
    fireEvent.click(screen.getByRole('button', { name: /Anwesenheit/ }))
    expect(p.onMode).toHaveBeenCalledWith('anwesenheit')
  })

  // The head count is on the bar's «Rapport» tile — but from inside the group that tile is
  // behind this control, so the number is said again on the segment that leads to it.
  it('carries the head count on Anwesenheit, and says it out loud', () => {
    setup({ presentCount: 12 })
    const anw = screen.getByRole('button', { name: /Anwesenheit/ })
    expect(anw.querySelector('.pgsw-count')?.textContent).toBe('12')
    expect(anw.getAttribute('title')).toBe('Anwesenheit · 12 anwesend')
  })

  // a standing «0 anwesend» on a fresh Einsatz is a badge that teaches you to stop reading badges
  it('paints no count while nobody is on scene', () => {
    setup()
    expect(document.querySelector('.pgsw-count')).toBeNull()
  })

  it('caps a three-figure crew so the badge stays a badge', () => {
    setup({ presentCount: 140 })
    expect(document.querySelector('.pgsw-count')?.textContent).toBe('99+')
  })

  // «noch offen» is a yes/no here — the Rapport's own head names every open Mindestangabe the
  // moment you are on it, so a figure would be the same answer twice
  it('flags the Rapport while a Mindestangabe is still open', () => {
    setup({ openCount: 3 })
    const rap = screen.getByRole('button', { name: /Rapport/ })
    expect(rap.querySelector('.pgsw-dot')).toBeTruthy()
    expect(rap.getAttribute('title')).toBe('Rapport – offen')
  })

  it('is silent once nothing is open', () => {
    setup({ openCount: 0 })
    expect(document.querySelector('.pgsw-dot')).toBeNull()
  })

  // …and the badges belong to their own segment only
  it('puts each badge on exactly one segment', () => {
    setup({ presentCount: 4, openCount: 2 })
    expect(screen.getByRole('button', { name: /Material/ }).querySelector('.pgsw-count, .pgsw-dot')).toBeNull()
    expect(screen.getByRole('button', { name: /Rapport/ }).querySelector('.pgsw-count')).toBeNull()
    expect(screen.getByRole('button', { name: /Anwesenheit/ }).querySelector('.pgsw-dot')).toBeNull()
  })
})
