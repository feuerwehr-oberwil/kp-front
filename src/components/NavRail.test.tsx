// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
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

  // (the object-switch footer item is gone from this rail for good: it went to the incident
  // dropdown in 2026-07-14 and from there onto the Plan surface — see Whiteboard · .wb-object)

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

// ── the PHONE bar folds every plan document into ONE «Pläne» tile (18.09.2026) ──
describe('folded plan tile', () => {
  const tile = () => screen.getByRole('button', { name: /^Pläne/ })

  it('replaces the per-document tiles and names the loaded document', () => {
    setup({ fold: true, activePlanId: 'modul5-rwa' })
    expect(screen.queryByRole('button', { name: 'Modul 1' })).toBeNull()
    expect(tile().getAttribute('aria-label')).toBe('Pläne · RWA')
  })

  // ⚠️ ONE glyph and ONE word, like every tile beside it (18.09.2026). The glyph IS the loaded
  // document — the same chip/icon its own tile wears on the vertical rail — and the word is the
  // generic «Pläne». It used to stack chip + «Pläne» + the code, three lines in a 46px tile.
  it('wears the loaded document as its glyph, and «Pläne» as its only word', () => {
    setup({ fold: true, activePlanId: 'modul5-rwa' })
    expect(tile().querySelector('.nav-mono-chip')?.textContent).toBe('RWA')
    expect(tile().querySelector('.nav-label')?.textContent).toBe('Pläne')
    expect(tile().querySelector('.nav-sub')).toBeNull()
  })

  it('takes the icon of an icon-document just as the rail does', () => {
    setup({ fold: true, activePlanId: 'tafel' })
    // the Tafel is an icon doc, so there is no monogram chip at all — only its pen glyph
    expect(tile().querySelector('.nav-mono-chip')).toBeNull()
    expect(tile().querySelector('.nav-glyph svg')).toBeTruthy()
  })

  it('is absent with no plan document at all', () => {
    setup({ fold: true, planDocs: [] })
    expect(screen.queryByRole('button', { name: /^Pläne/ })).toBeNull()
  })

  it('a first tap from another surface opens the last-used plan — no chooser', () => {
    const p = setup({ fold: true, mode: 'map', activePlanId: 'tafel' })
    fireEvent.click(tile())
    expect(p.onSelectPlan).toHaveBeenCalledWith('tafel')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a second tap — the tile is already the surface — opens the chooser', () => {
    const p = setup({ fold: true, mode: 'plans', activePlanId: 'tafel' })
    fireEvent.click(tile())
    expect(p.onSelectPlan).not.toHaveBeenCalled()
    expect(screen.getByRole('option', { name: /Übersicht/ })).toBeTruthy()
  })

  it('picking a row switches the document and closes the chooser', () => {
    const p = setup({ fold: true, mode: 'plans', activePlanId: 'tafel' })
    fireEvent.click(tile())
    fireEvent.click(screen.getByRole('option', { name: /Übersicht/ }))
    expect(p.onSelectPlan).toHaveBeenCalledWith('modul1')
    expect(screen.queryByRole('option', { name: /Übersicht/ })).toBeNull()
  })

  // …and the hold is the second door into the list, from wherever you are standing (the app's
  // own useLongPress: 500 ms, cancelled by any movement)
  it('a hold on the tile opens the chooser without switching surface', () => {
    vi.useFakeTimers()
    try {
      const p = setup({ fold: true, mode: 'map', activePlanId: 'tafel' })
      const btn = tile() // …held on to: the open sheet marks the rail behind it inert
      fireEvent.pointerDown(btn, { clientX: 10, clientY: 10 })
      act(() => { vi.advanceTimersByTime(600) })
      expect(screen.getByRole('option', { name: /Übersicht/ })).toBeTruthy()
      // the click the browser still delivers on release must not ALSO be taken as the tap
      fireEvent.click(btn)
      expect(p.onSelectPlan).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  // ── five tiles on the phone: Karte · Pläne · Checkliste · Trupps · Rapport (18.09.2026) ──
  // Anwesenheit and Material gave up their tiles and became tabs of the Rapport; the vertical
  // rail keeps all seven.
  it('leaves Anwesenheit and Material off the bar, and keeps them on the rail', () => {
    setup({ fold: true })
    expect(screen.queryByRole('button', { name: /^Anwesenheit/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Material/ })).toBeNull()
    cleanup()
    setup()
    expect(screen.getByRole('button', { name: /^Anwesenheit/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Material/ })).toBeTruthy()
  })

  it('a single document never offers a chooser', () => {
    const p = setup({ fold: true, mode: 'plans', planDocs: [docs[0]], activePlanId: 'modul1' })
    fireEvent.click(tile())
    expect(screen.queryByRole('option')).toBeNull()
    expect(p.onSelectPlan).not.toHaveBeenCalled()
  })
})

// The head count was the one number the Anwesenheit tile stated just by existing. With that tile
// folded away it rides on the «Rapport» tile — as a COUNT, not a dot, so it can still be read.
describe('the head count on the Rapport tile', () => {
  const rapport = () => screen.getByRole('button', { name: /^Rapport/ })

  it('states the number, and says it out loud too', () => {
    setup({ fold: true, presentCount: 12 })
    expect(rapport().querySelector('.nav-count')?.textContent).toBe('12')
    expect(rapport().getAttribute('aria-label')).toBe('Rapport · 12 anwesend')
  })

  // a standing «0 anwesend» on a fresh Einsatz is a badge that teaches you to stop reading badges
  it('paints nothing while nobody is on scene', () => {
    setup({ fold: true, presentCount: 0 })
    expect(rapport().querySelector('.nav-count')).toBeNull()
    expect(rapport().getAttribute('aria-label')).toBe('Rapport')
  })

  // on a tablet the Anwesenheit still has its own tile, and its own head line, right there
  it('is a phone badge only — the vertical rail still carries the Anwesenheit itself', () => {
    setup({ presentCount: 12 })
    expect(rapport().querySelector('.nav-count')).toBeNull()
  })

  it('caps a three-figure crew so the badge stays a badge', () => {
    setup({ fold: true, presentCount: 140 })
    expect(rapport().querySelector('.nav-count')?.textContent).toBe('99+')
  })
})
