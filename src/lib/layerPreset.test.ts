import { describe, expect, it } from 'vitest'
import { layerPreset } from './layerPreset'
import type { LayerDef } from '../types'

const L = (id: string, visible: boolean, base = false) => ({ id, visible, base, group: 'g', label: id, icon: 'map' }) as LayerDef
const defaults = [L('osm', true, true), L('sat', false, true), L('lage', true), L('hydranten', true), L('gefahren', false)]

describe('layerPreset', () => {
  it('is «standard» for the Einsatz default, whatever a slider did', () => {
    expect(layerPreset(defaults, defaults)).toBe('standard')
    expect(layerPreset(defaults.map((l) => ({ ...l, opacity: 40 })), defaults)).toBe('standard')
  })
  it('is «all» / «none» when every overlay is on / off, the Basiskarte aside', () => {
    expect(layerPreset([L('osm', false, true), L('sat', true, true), L('lage', true), L('hydranten', true), L('gefahren', true)], defaults)).toBe('all')
    expect(layerPreset([L('osm', true, true), L('sat', false, true), L('lage', false), L('hydranten', false), L('gefahren', false)], defaults)).toBe('none')
  })
  it('prefers «standard» when the default is itself everything on', () => {
    const allOn = [L('osm', true, true), L('lage', true)]
    expect(layerPreset(allOn, allOn)).toBe('standard')
  })
  it('is «custom» for a hand-switched set, or the default overlays on another Basiskarte', () => {
    expect(layerPreset([L('osm', true, true), L('sat', false, true), L('lage', true), L('hydranten', false), L('gefahren', false)], defaults)).toBe('custom')
    expect(layerPreset([L('osm', false, true), L('sat', true, true), L('lage', true), L('hydranten', true), L('gefahren', false)], defaults)).toBe('custom')
  })
  it('is «custom» while the radar is on — «Standard» and «Alle aus» switch it off, «Alle ein» leaves it', () => {
    expect(layerPreset(defaults, defaults, true)).toBe('custom')
    const allOff = [L('osm', true, true), L('sat', false, true), L('lage', false), L('hydranten', false), L('gefahren', false)]
    expect(layerPreset(allOff, defaults, true)).toBe('custom')
    expect(layerPreset(defaults, defaults, false)).toBe('standard')
  })
})
