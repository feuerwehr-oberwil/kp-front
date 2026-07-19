import { describe, it, expect } from 'vitest'
import { clampRailWidth, snapExpanded, planGlyph } from './navRail'
import type { PlanDocument } from '../types'

// a minimal PlanDocument factory — only the fields planGlyph reads matter
const doc = (over: Partial<PlanDocument>): PlanDocument => ({
  id: 'x', code: '', title: '', subtitle: '', imageUrl: '', orientation: 'portrait', ...over,
})

describe('clampRailWidth', () => {
  it('clamps below the minimum', () => expect(clampRailWidth(10)).toBe(60))
  it('clamps above the maximum', () => expect(clampRailWidth(400)).toBe(216))
  it('passes an in-range value through', () => expect(clampRailWidth(120)).toBe(120))
  it('honours custom bounds', () => expect(clampRailWidth(5, 40, 100)).toBe(40))
})

describe('snapExpanded', () => {
  it('stays collapsed below the snap point', () => expect(snapExpanded(100)).toBe(false))
  it('expands above the snap point', () => expect(snapExpanded(180)).toBe(true))
  it('is false exactly at the boundary', () => expect(snapExpanded(138)).toBe(false))
})

describe('planGlyph', () => {
  it('maps modul1 → bare 1 monogram (no M prefix)', () => expect(planGlyph(doc({ id: 'modul1' }))).toEqual({ mono: '1' }))
  it('maps modul6 → bare 6 monogram (no M prefix)', () => expect(planGlyph(doc({ id: 'modul6' }))).toEqual({ mono: '6' }))
  it('maps a combined modul2-3 → fractional 2/3 monogram', () => expect(planGlyph(doc({ id: 'modul2-3' }))).toEqual({ mono: '2/3' }))
  it('maps the floor-stack → its (layers) icon, not a bare G', () => expect(planGlyph(doc({ id: 'gebaeude', floorStack: true, icon: 'layers' }))).toEqual({ icon: 'layers' }))
  it('maps the blank Tafel → its pen icon', () => expect(planGlyph(doc({ id: 'tafel', icon: 'pen' }))).toEqual({ icon: 'pen' }))
  it('defaults the Tafel glyph to pen when no icon is set', () => expect(planGlyph(doc({ id: 'tafel' }))).toEqual({ icon: 'pen' }))
  it('falls back to the doc icon for a generic plan', () => expect(planGlyph(doc({ id: 'osm', icon: 'map' }))).toEqual({ icon: 'map' }))
  it('falls back to the doc icon when none is set', () => expect(planGlyph(doc({ id: 'other' }))).toEqual({ icon: 'doc' }))
})
