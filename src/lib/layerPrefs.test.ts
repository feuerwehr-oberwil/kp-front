import { describe, it, expect, beforeEach } from 'vitest'
import { loadLayerPrefs, saveLayerPrefs } from './layerPrefs'
import { deriveInitial, type Saved } from './workspace'

// The suite runs in the node environment (vite.config), which has no Web Storage — and jsdom's
// is shadowed by Node's own experimental global. A three-method stand-in is all this module
// touches, and it keeps the test honest about the ONE thing that matters: what is stored is a
// string under a per-incident key.
const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  },
})

const ws = (over: Partial<Saved>): Saved =>
  ({ entities: [], drawings: [], recent: [], layerState: [], timeline: [], ...over }) as Saved

describe('layerPrefs — the Ebenen selection is device-local', () => {
  beforeEach(() => store.clear())

  it('round-trips per incident, and one incident never answers for another', () => {
    saveLayerPrefs('inc1', [{ id: 'hydrant', visible: false, opacity: 40 }])
    expect(loadLayerPrefs('inc1')).toEqual([{ id: 'hydrant', visible: false, opacity: 40 }])
    expect(loadLayerPrefs('inc2')).toBeUndefined()
  })

  it('ignores a corrupt or foreign value rather than opening a broken map', () => {
    store.set('kp.layers.inc1', '{ not json')
    expect(loadLayerPrefs('inc1')).toBeUndefined()
    store.set('kp.layers.inc1', '[{"id":"hydrant"}]')
    expect(loadLayerPrefs('inc1')).toBeUndefined() // no `visible` — not a layer row
  })

  it('the device value WINS over the blob — another tablet cannot hide a layer here', () => {
    saveLayerPrefs('inc1', [{ id: 'taktisch', visible: true, opacity: 100 }])
    const blob = ws({ layerState: [{ id: 'taktisch', visible: false, opacity: 20 }] as Saved['layerState'] })
    const { layers } = deriveInitial(blob, 'inc1', {})
    const taktisch = layers.find((l) => l.id === 'taktisch')
    expect(taktisch?.visible).toBe(true)
    expect(taktisch?.opacity).toBe(100)
  })

  it('…and the blob still seeds a device that has never said (existing workspaces)', () => {
    const blob = ws({ layerState: [{ id: 'taktisch', visible: false, opacity: 20 }] as Saved['layerState'] })
    const { layers } = deriveInitial(blob, 'inc1', {})
    expect(layers.find((l) => l.id === 'taktisch')?.visible).toBe(false)
  })
})
