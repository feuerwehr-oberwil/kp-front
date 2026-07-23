import { describe, expect, it } from 'vitest'
import { resolveLinePreset } from './lineStyle'

// resolveLinePreset is the ONE preset bundle both drawing surfaces (Lage map + Plan whiteboard)
// apply — this pins the coercion so they can't drift. The default presets are the app's stock
// freihand / pfeil / rettungsachse (appConfig.drawing.linePresets).
describe('resolveLinePreset', () => {
  it('clears arrow/marker/distance for Freihand (empty flags → undefined, not false/"")', () => {
    // switching back to Freihand must REMOVE a previous preset's arrow/marker, not persist falsy noise
    expect(resolveLinePreset('freihand')).toEqual({
      arrow: undefined,
      marker: undefined,
      showDistance: undefined,
      dashed: undefined,
    })
  })

  it('sets the arrow for Pfeil and leaves marker/distance cleared', () => {
    const p = resolveLinePreset('pfeil')
    expect(p.arrow).toBe(true)
    expect(p.marker).toBeUndefined()
    expect(p.showDistance).toBeUndefined()
    expect(p.dashed).toBe(false)
  })

  it('carries the R marker + dash for Rettungsachse', () => {
    const p = resolveLinePreset('rettungsachse')
    expect(p.arrow).toBe(true)
    expect(p.marker).toBe('R')
    expect(p.dashed).toBe(true)
  })

  it('falls back to the current dash when the preset does not own dashed (Freihand)', () => {
    // Freihand carries no `dashed`, so the line/dock value is kept…
    expect(resolveLinePreset('freihand', true).dashed).toBe(true)
    expect(resolveLinePreset('freihand', false).dashed).toBe(false)
    // …but a preset that DOES own dashed wins over the current value
    expect(resolveLinePreset('rettungsachse', false).dashed).toBe(true)
    expect(resolveLinePreset('pfeil', true).dashed).toBe(false)
  })

  it('defaults unknown ids to the first preset (Freihand)', () => {
    expect(resolveLinePreset('nope')).toEqual(resolveLinePreset('freihand'))
  })
})
