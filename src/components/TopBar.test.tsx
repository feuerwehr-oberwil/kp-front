// @vitest-environment jsdom
import { afterEach, beforeAll, describe, it, expect, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TopBar, windArrowRotation } from './TopBar'
import type { Incident } from '../types'

// The bar's own «Teilen» button was removed on 06.09. — the Einsatz-Karte's «Teilen» row
// (panels/IncidentSwitcher) is now the one door to the share sheet on every width.

// The wind arrow's one piece of maths, kept here since WindBadge (its old home) was deleted as
// dead code on 05.09. — it aims the arrow DOWNWIND, and it has to follow the map's rotation.
describe('windArrowRotation', () => {
  it('rotates by the FROM bearing on a north-up map (aims the arrow downwind)', () => {
    expect(windArrowRotation(225)).toBe(225)
    expect(windArrowRotation(0)).toBe(0)
  })

  it('follows the map rotation by subtracting the bearing (like the compass needle)', () => {
    // map rotated 90° clockwise → the same wind reads 90° less on screen
    expect(windArrowRotation(225, 90)).toBe(135)
    expect(windArrowRotation(45, 45)).toBe(0)
    expect(windArrowRotation(10, 40)).toBe(-30)
  })
})

// ── the Lagemeldung chip (F3) ─────────────────────────────────────────────────────────────────

describe('TopBar · Lagemeldung chip', () => {
  beforeAll(() => {
    // jsdom has neither: a tablet (not a phone) and a bar that is never measured too narrow
    window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })
  const incident = { type: 'Brand', title: 'Brand MFH', address: 'Hauptstrasse 12' } as Incident
  const bar = (lage: { dueAt: number | null; off: boolean; onOpen: () => void }) => render(
    <TopBar incident={incident} recording={false} recStartedAt={null} journalOpen={false} onToggleJournal={() => {}}
      onUndo={() => {}} onRedo={() => {}} canUndo={false} canRedo={false} lage={lage} />,
  )
  it('counts down, turns due, and opens the composer on a tap', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-09T19:30:00Z') })
    let opened = 0
    bar({ dueAt: Date.parse('2026-10-09T19:34:00Z'), off: false, onOpen: () => { opened++ } })
    const chip = screen.getByRole('button', { name: 'Lagemeldung – Lage · in 4′' })
    fireEvent.click(chip)
    expect(opened).toBe(1)
    cleanup()
    bar({ dueAt: Date.parse('2026-10-09T19:28:00Z'), off: false, onOpen: () => {} })
    expect(screen.getByRole('button', { name: 'Lagemeldung – Lage fällig' }).className).toContain('due')
  })
  it('idle before anything is due: the plain door', () => {
    bar({ dueAt: null, off: false, onOpen: () => {} })
    expect(screen.getByRole('button', { name: 'Lagemeldung – Lage' }).className).toContain('idle')
  })
})
