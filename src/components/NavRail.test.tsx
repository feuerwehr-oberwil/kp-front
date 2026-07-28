// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { NavRail } from './NavRail'
import type { PlanDocument } from '../types'

afterEach(cleanup)

const docs: PlanDocument[] = [
  { id: 'modul1', code: 'Modul 1', title: 'Übersicht', subtitle: '', imageUrl: '', orientation: 'portrait' },
  { id: 'modul5-rwa', code: 'RWA', title: 'RWA', subtitle: '', imageUrl: '', orientation: 'landscape' },
  { id: 'tafel', code: 'Tafel', title: 'Leeres Blatt', subtitle: '', imageUrl: '', orientation: 'landscape', icon: 'pen' },
]

function props(over: Partial<React.ComponentProps<typeof NavRail>> = {}) {
  return {
    mode: 'map' as const, onMode: vi.fn(), planDocs: docs, activePlanId: 'modul1',
    onSelectPlan: vi.fn(), ...over,
  }
}

function setup(over: Partial<React.ComponentProps<typeof NavRail>> = {}) {
  const p = props(over)
  render(<NavRail {...p} />)
  return p
}

/** setup() that can re-render with new props — for the async arrival of the plan tiles. */
function renderRail(over: Partial<React.ComponentProps<typeof NavRail>> = {}) {
  const view = render(<NavRail {...props(over)} />)
  return {
    rerender: (next: Partial<React.ComponentProps<typeof NavRail>>) =>
      view.rerender(<NavRail {...props(next)} />),
  }
}

describe('NavRail', () => {
  it('clicking Karte calls onMode("map")', () => {
    const p = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Karte' }))
    expect(p.onMode).toHaveBeenCalledWith('map')
  })

  it('clicking a plan item calls onSelectPlan with its id', () => {
    const p = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Modul 1' }))
    expect(p.onSelectPlan).toHaveBeenCalledWith('modul1')
  })

  it('clicking Checkliste calls onMode("checklists")', () => {
    const p = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Checkliste' }))
    expect(p.onMode).toHaveBeenCalledWith('checklists')
  })

  it('reflects the active surface via aria-pressed', () => {
    setup({ mode: 'plans', activePlanId: 'modul1' })
    expect(screen.getByRole('button', { name: 'Karte' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Modul 1' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Tafel' }).getAttribute('aria-pressed')).toBe('false')
  })

  // (the object-switch footer item moved to the incident dropdown's «Objekt: …» row —
  // covered by the IncidentSwitcher, 2026-07-14)

  it('labels are hidden in compact and revealed by the expand toggle', () => {
    setup()
    // compact: the rail is not .expanded, so labels are display:none via CSS — assert the
    // toggle flips the rail into the expanded state (where the CSS reveals labels)
    const nav = screen.getByRole('navigation')
    expect(nav.className).not.toContain('expanded')
    fireEvent.click(screen.getByRole('button', { name: 'Ausklappen' }))
    expect(nav.className).toContain('expanded')
  })
})

// The chip lives in a 46px column and must fit inside it WITH its border — a three-letter
// acronym at the single-digit size pushed its own border off the rail. CSS can't count
// characters, so the letter count is stamped on the glyph and picks the size from there.
describe('monogram chip sizing', () => {
  it('stamps the letter count so the stylesheet can shrink a long monogram', () => {
    setup()
    const rwa = screen.getByRole('button', { name: 'RWA' })
    expect(rwa.querySelector('.nav-glyph.mono')?.getAttribute('data-mono-len')).toBe('3')
  })

  it('leaves a single-digit module at its full size', () => {
    setup()
    const modul1 = screen.getByRole('button', { name: 'Modul 1' })
    expect(modul1.querySelector('.nav-glyph.mono')?.getAttribute('data-mono-len')).toBe('1')
  })
})

// A reload restores the surface from prefs, but the plan tiles are fetched afterwards — so on the
// first pass the active item is often not in the DOM yet, and once it arrives it lands in the
// middle of the list. The reveal effect therefore has to run again when planDocs change, or the
// bar stays parked at its start with the active item off screen.
describe('revealing the active surface', () => {
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    scrollIntoView.mockClear()
    // jsdom has no scrollIntoView at all
    Element.prototype.scrollIntoView = scrollIntoView
  })

  it('reveals the active item on mount, without animating it', () => {
    setup({ mode: 'mittel' })
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }))
  })

  it('looks again when the plan tiles arrive after boot', () => {
    const { rerender } = renderRail({ mode: 'plans', activePlanId: 'modul1', planDocs: [] })
    scrollIntoView.mockClear()
    rerender({ mode: 'plans', activePlanId: 'modul1', planDocs: docs })
    expect(scrollIntoView).toHaveBeenCalled()
  })
})
