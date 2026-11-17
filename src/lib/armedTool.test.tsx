// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { armedReadout, armedToolIcon, armedToolName } from './armedTool'
import { appConfig } from '../config/appConfig'

describe('armedToolName – the readout tile\'s word', () => {
  const map = appConfig.copy.mapTools
  const plan = appConfig.copy.planTools

  it('names the rail\'s tools by their own tile label', () => {
    expect(armedToolName('circle', map)).toBe('Absperrkreis')
    expect(armedToolName('team', map)).toBe('Trupp')
    expect(armedToolName('measure', plan)).toBe('Messen')
  })

  it('a two-state tile answers for its second state (Mehrfach)', () => {
    expect(armedToolName('lasso', map)).toBe('Mehrfach')
    expect(armedToolName('lasso', plan)).toBe('Mehrfach')
  })

  it('the glyph is the rail tile\'s icon', () => {
    expect(armedToolIcon('line', map)).toBe('pen')
    expect(armedToolIcon('lasso', plan)).toBe('marquee')
    expect(armedToolIcon('scale', map)).toBeNull() // a Plan tool the Karte's rail does not carry
  })
})

// owner pick 14 (17.11.2026): «Linie», not «Linie · Freihand» – the lit toggle beside it says the mode
describe('armedReadout', () => {
  const map = appConfig.copy.mapTools

  it('names a Linie by the tool alone', () => {
    expect(armedReadout('line', map, {})?.name).toBe('Linie')
  })

  it('a symbol wears its own drawing, sanitised, and its own name', () => {
    const r = armedReadout('symbol', map, { symbol: 'Unfall', svg: '<svg><script>x()</script><circle r="2"/></svg>' })!
    expect(r.name).toBe('Unfall')
    const { container } = render(<>{r.glyph}</>)
    expect(container.querySelector('.wb-dock-sym circle')).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
  })

  it('names nothing before a symbol or a Form is picked', () => {
    expect(armedReadout('symbol', map, { symbol: null })).toBeNull()
    expect(armedReadout('shape', map, { shape: null })).toBeNull()
  })
})
