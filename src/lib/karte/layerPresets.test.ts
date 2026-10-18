import { describe, expect, it } from 'vitest'
import type { LayerDef } from '../../types'
import { applyLayerPreset, karteLayerPreset, presetFlips, type PresetRow } from './layerPresets'

// Synthetic layers: two bases, three overlays; the viewer's default = Carto + hydrants on.
const L = (id: string, visible: boolean, base = false, opacity?: number) => ({ id, label: id, group: base ? 'Grundkarte' : 'Wasser', visible, base, opacity }) as unknown as LayerDef
const DEFAULTS = [L('carto', true, true), L('osm', false, true), L('hydranten', true), L('leitungen', false), L('fahrzeuge', true)]
const vis = (ls: LayerDef[]) => Object.fromEntries(ls.map((l) => [l.id, l.visible]))
const rows = (objects: boolean, cat = true): PresetRow[] => [{ id: 'karte:objekte', visible: objects }, { id: 'karte:kat:pv', visible: cat }]

describe('Karte & Objekte · Ebenen quick-taps', () => {
  it('«Standard» is the viewer\'s default set with every station row on', () => {
    expect(karteLayerPreset(DEFAULTS, DEFAULTS, rows(true))).toBe('standard')
    expect(karteLayerPreset(DEFAULTS, DEFAULTS, rows(false))).toBe('custom')
    expect(karteLayerPreset(DEFAULTS, DEFAULTS, [{ id: 'x', visible: false, standard: false }])).toBe('standard')
  })
  it('«Alle ein» / «Alle aus» count the station rows as overlays, never the Basiskarte', () => {
    const all = applyLayerPreset(DEFAULTS, DEFAULTS, 'all')
    expect(vis(all)).toEqual({ carto: true, osm: false, hydranten: true, leitungen: true, fahrzeuge: true })
    expect(karteLayerPreset(all, DEFAULTS, rows(true))).toBe('all')
    expect(karteLayerPreset(all, DEFAULTS, rows(true, false))).toBe('custom')
    const none = applyLayerPreset(DEFAULTS, DEFAULTS, 'none')
    expect(vis(none)).toEqual({ carto: true, osm: false, hydranten: false, leitungen: false, fahrzeuge: false })
    expect(karteLayerPreset(none, DEFAULTS, rows(false, false))).toBe('none')
    expect(karteLayerPreset(none, DEFAULTS, rows(true, false))).toBe('custom')
  })
  it('«Standard» brings back the default Basiskarte and keeps a transparency set by hand', () => {
    const mine = [L('carto', false, true), L('osm', true, true), L('hydranten', false, false, 40), L('leitungen', true), L('fahrzeuge', true)]
    const back = applyLayerPreset(mine, DEFAULTS, 'standard')
    expect(vis(back)).toEqual(vis(DEFAULTS))
    expect(back.find((l) => l.id === 'hydranten')?.opacity).toBe(40)
    expect(karteLayerPreset(back, DEFAULTS, [])).toBe('standard')
  })
  it('never leaves the map without a Basiskarte', () => {
    const noBase = [L('osm', true, true), L('hydranten', true)]
    expect(applyLayerPreset(noBase, DEFAULTS, 'standard').filter((l) => l.base && l.visible)).toHaveLength(1)
  })
  it('names the rows a chip has to flip — whatever rows the panel has', () => {
    expect(presetFlips(rows(true, false), 'none')).toEqual(['karte:objekte'])
    expect(presetFlips(rows(true, false), 'all')).toEqual(['karte:kat:pv'])
    expect(presetFlips(rows(false, false), 'standard')).toEqual(['karte:objekte', 'karte:kat:pv'])
    expect(presetFlips([{ id: 'x', visible: true, standard: false }], 'standard')).toEqual(['x'])
  })
  it('the radar on lights no chip (the Einsatz\'s rule)', () => {
    expect(karteLayerPreset(DEFAULTS, DEFAULTS, rows(true), true)).toBe('custom')
  })
})
