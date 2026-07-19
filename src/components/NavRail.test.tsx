// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { NavRail } from './NavRail'
import type { PlanDocument } from '../types'

afterEach(cleanup)

const docs: PlanDocument[] = [
  { id: 'modul1', code: 'Modul 1', title: 'Übersicht', subtitle: '', imageUrl: '', orientation: 'portrait' },
  { id: 'tafel', code: 'Tafel', title: 'Leeres Blatt', subtitle: '', imageUrl: '', orientation: 'landscape', icon: 'pen' },
]

function setup(over: Partial<React.ComponentProps<typeof NavRail>> = {}) {
  const props = {
    mode: 'map' as const, onMode: vi.fn(), planDocs: docs, activePlanId: 'modul1',
    onSelectPlan: vi.fn(), ...over,
  }
  render(<NavRail {...props} />)
  return props
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
