import { describe, it, expect } from 'vitest'
import { SYMBOL_SCALE, clampSymbolScale, legacySymbolMul, symbolScales, type Prefs } from './prefs'

// The Symbolgrösse rework: one global S/M/L pref became one multiplier PER SURFACE (Karte /
// Module). Two things have to hold — the bands the sliders offer, and that nobody's stored
// setting is lost on the way over.

describe('SYMBOL_SCALE bands', () => {
  it('keeps 1 (the tuned default) at the exact midpoint of both sliders', () => {
    for (const r of Object.values(SYMBOL_SCALE)) {
      expect((r.min + r.max) / 2).toBeCloseTo(r.default)
      expect(r.default).toBe(1)
    }
  })

  it('lets the board go meaningfully below the old S — the reason for the rework', () => {
    expect(SYMBOL_SCALE.board.min).toBeLessThan(legacySymbolMul('S'))
    // the map keeps the old S as its floor and the old L stays reachable on both surfaces
    expect(SYMBOL_SCALE.map.min).toBe(legacySymbolMul('S'))
    expect(SYMBOL_SCALE.map.max).toBeGreaterThan(legacySymbolMul('L'))
    expect(SYMBOL_SCALE.board.max).toBeGreaterThan(legacySymbolMul('L'))
  })
})

describe('clampSymbolScale', () => {
  it('snaps to the step without float dust', () => {
    expect(clampSymbolScale('map', 0.71)).toBe(0.7)
    expect(clampSymbolScale('map', 1.23)).toBe(1.25)
    expect(clampSymbolScale('board', 0.42)).toBe(0.4)
  })

  it('clamps into each surface’s own band', () => {
    expect(clampSymbolScale('map', 0.1)).toBe(SYMBOL_SCALE.map.min)
    expect(clampSymbolScale('map', 9)).toBe(SYMBOL_SCALE.map.max)
    // 0.45 is a legal board size but below the map floor
    expect(clampSymbolScale('board', 0.45)).toBe(0.45)
    expect(clampSymbolScale('map', 0.45)).toBe(SYMBOL_SCALE.map.min)
  })

  it('falls back to the default for anything unusable', () => {
    expect(clampSymbolScale('map', undefined)).toBe(1)
    expect(clampSymbolScale('board', NaN)).toBe(1)
    expect(clampSymbolScale('board', 'M' as unknown as number)).toBe(1)
  })
})

describe('symbolScales migration', () => {
  it('defaults to 1 on both surfaces when nothing is stored', () => {
    expect(symbolScales({})).toEqual({ map: 1, board: 1 })
  })

  it('carries a legacy S/M/L pref over to BOTH surfaces unchanged', () => {
    expect(symbolScales({ symbolSize: 'S' })).toEqual({ map: 0.6, board: 0.6 })
    expect(symbolScales({ symbolSize: 'M' })).toEqual({ map: 1, board: 1 })
    expect(symbolScales({ symbolSize: 'L' })).toEqual({ map: 1.3, board: 1.3 })
  })

  it('prefers an explicit per-surface value over the legacy one, surface by surface', () => {
    const p: Prefs = { symbolSize: 'L', symbolScaleBoard: 0.45 }
    // the board was moved by hand, the map still rides the old pref
    expect(symbolScales(p)).toEqual({ map: 1.3, board: 0.45 })
  })

  it('is lossless: resolving never touches the stored prefs object', () => {
    const p: Prefs = { symbolSize: 'S' }
    symbolScales(p)
    expect(p).toEqual({ symbolSize: 'S' })
  })
})
