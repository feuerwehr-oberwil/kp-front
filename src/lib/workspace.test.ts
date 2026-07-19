import { describe, expect, it, vi } from 'vitest'
import { autoActivateLayers, deriveInitial, normalizeBoard, sanitizeWorkspace, WORKSPACE_SCHEMA_VERSION, type Saved } from './workspace'
import type { LayerDef } from '../types'

// Inject one station reference layer with a category rule so the auto-activation path is
// exercisable (the bundled demo layers carry no autoActivate).
vi.mock('./deploymentConfig', () => ({
  referenceLayersFromConfig: (): LayerDef[] => [{
    id: 'hydrant', group: 'Wasser', label: 'Hydranten', icon: 'drop', base: false, visible: false,
    opacity: 100, geojson: '/api/reference/geo:hydrant', vectorKind: 'point', autoActivate: ['Brandbekämpfung'],
  }],
}))

// deriveInitial turns a persisted (or absent) workspace blob into App's initial state. It's the
// load path every incident open runs through, so its normalisation — orphan-reference cleanup,
// legacy-shape migration, layer reconciliation, remembered-plan scoping — is exactly where a
// silent data-shape regression would corrupt a freshly opened incident. These lock it in.

// The heavy domain types (Entity/TimelineEvent/BoardAnno/LayerDef) carry many fields irrelevant
// here; build minimal shapes and cast, like the sibling merge tests do.
const ws = (partial: Partial<Saved>): Saved => partial as Saved

describe('deriveInitial — fresh / empty incident', () => {
  it('a null workspace yields a blank slate (no demo seed leaks in)', () => {
    const s = deriveInitial(null, 'inc1', {})
    expect(s.doc.entities).toEqual([])
    expect(s.doc.drawings).toEqual([])
    expect(s.timeline).toEqual([])
    expect(s.board).toEqual({})
    expect(s.trupps).toEqual([])
    expect(s.attendance).toEqual({})
    // a brand-new incident opens on Modul 1 (the Übersicht)
    expect(s.activePlanId).toBe('modul1')
  })
})

describe('deriveInitial — timeline orphan-reference cleanup', () => {
  it('strips a timeline event\'s entityId when that entity no longer exists, keeps live ones', () => {
    const blob = ws({
      entities: [{ id: 'e1' }] as Saved['entities'],
      timeline: [
        { id: 't1', entityId: 'e1' },
        { id: 't2', entityId: 'gone' },
        { id: 't3' },
      ] as unknown as Saved['timeline'],
    })
    const { timeline } = deriveInitial(blob, 'inc1', {})
    expect(timeline.find((e) => e.id === 't1')?.entityId).toBe('e1')   // entity still present → kept
    expect(timeline.find((e) => e.id === 't2')?.entityId).toBeUndefined() // orphan → stripped
    expect(timeline.find((e) => e.id === 't3')?.entityId).toBeUndefined() // never had one
  })
})

describe('deriveInitial — legacy board migration (via normalizeBoard)', () => {
  it('migrates the old "trupp" annotation kind to "resource" and assigns a colour', () => {
    const blob = ws({ board: { p1: [{ id: 'a1', kind: 'trupp' }] } as unknown as Saved['board'] })
    const { board } = deriveInitial(blob, 'inc1', {})
    const anno = board.p1[0] as { kind: string; color?: string }
    expect(anno.kind).toBe('resource')
    expect(anno.color).toBeTruthy() // a palette colour was assigned to the colourless legacy team
  })

  it('normalizeBoard leaves an undefined board as an empty map', () => {
    expect(normalizeBoard(undefined)).toEqual({})
  })
})

describe('deriveInitial — picked Einsatzobjekt is synced per incident', () => {
  it('reads the picked object from the workspace blob (the synced source of truth)', () => {
    const s = deriveInitial(ws({ pickedObjectId: 'obj-A' }), 'inc1', {})
    expect(s.pickedObjectId).toBe('obj-A')
  })

  it('defaults to undefined (auto-surface) when the blob has no pick', () => {
    expect(deriveInitial(null, 'inc1', {}).pickedObjectId).toBeUndefined()
  })

  it('the blob value wins over a legacy device-cookie pick', () => {
    const s = deriveInitial(ws({ pickedObjectId: 'obj-blob' }), 'inc1', {
      pickedObject: { incidentId: 'inc1', objectId: 'obj-cookie' },
    })
    expect(s.pickedObjectId).toBe('obj-blob')
  })

  it('one-time imports the legacy cookie pick for THIS incident when the blob has none', () => {
    const s = deriveInitial(null, 'inc1', { pickedObject: { incidentId: 'inc1', objectId: 'obj-cookie' } })
    expect(s.pickedObjectId).toBe('obj-cookie')
  })

  it('ignores a legacy cookie pick belonging to a DIFFERENT incident', () => {
    const s = deriveInitial(null, 'inc2', { pickedObject: { incidentId: 'inc1', objectId: 'obj-cookie' } })
    expect(s.pickedObjectId).toBeUndefined() // no cross-incident bleed — the bug this fix closes
  })
})

describe('deriveInitial — layer state reconciliation', () => {
  it('applies saved visibility/opacity onto the base layer set without dropping layers', () => {
    const blob = ws({ layerState: [{ id: 'taktisch', visible: false, opacity: 40 }] as Saved['layerState'] })
    const { layers } = deriveInitial(blob, 'inc1', {})
    const taktisch = layers.find((l) => l.id === 'taktisch')
    expect(taktisch?.visible).toBe(false)
    expect(taktisch?.opacity).toBe(40)
    // layers not mentioned in the saved state keep their built-in defaults (still present).
    expect(layers.find((l) => l.id === 'markup')).toBeTruthy()
  })

  it('falls back to the first base map when the saved base no longer exists (trimmed defs)', () => {
    // the workspace had a since-removed base (e.g. base-grey) selected and the current
    // default (base-carto) explicitly off — without the guard NO background would render
    const blob = ws({
      layerState: [
        { id: 'base-grey', visible: true, opacity: 100 },
        { id: 'base-carto', visible: false, opacity: 100 },
        { id: 'base-osm', visible: false, opacity: 100 },
        { id: 'base-air', visible: false, opacity: 100 },
      ] as Saved['layerState'],
    })
    const { layers } = deriveInitial(blob, 'inc1', {})
    expect(layers.filter((l) => l.base && l.visible)).toHaveLength(1)
    expect(layers.find((l) => l.base && l.visible)?.id).toBe('base-carto')
  })
})

describe('autoActivateLayers — category-driven layer pre-activation', () => {
  const mk = (over: Partial<LayerDef>): LayerDef =>
    ({ id: 'x', group: 'Referenz', label: 'X', icon: 'map', visible: false, ...over }) as LayerDef

  it('switches matching hidden layers on, leaves the rest untouched', () => {
    const out = autoActivateLayers(
      [mk({ id: 'hydrant', autoActivate: ['Brandbekämpfung'] }), mk({ id: 'other' })],
      'Brandbekämpfung',
    )
    expect(out.find((l) => l.id === 'hydrant')?.visible).toBe(true)
    expect(out.find((l) => l.id === 'other')?.visible).toBe(false)
  })

  it('is additive only — an already-visible layer never flips off for a non-matching category', () => {
    const layers = [mk({ id: 'hydrant', visible: true, autoActivate: ['Brandbekämpfung'] })]
    expect(autoActivateLayers(layers, 'Strassenrettung')).toBe(layers)
  })

  it('returns the SAME array when nothing matches (safe as a setState updater no-op)', () => {
    const layers = [mk({ id: 'hydrant', autoActivate: ['Brandbekämpfung'] })]
    expect(autoActivateLayers(layers, 'Ölwehr')).toBe(layers)
    expect(autoActivateLayers(layers, null)).toBe(layers)
    expect(autoActivateLayers(layers, undefined)).toBe(layers)
  })
})

describe('deriveInitial — category pre-activation is fresh-workspace-only', () => {
  it('a fresh incident of a matching category opens with the layer visible', () => {
    const { layers } = deriveInitial(null, 'inc1', {}, 'Brandbekämpfung')
    expect(layers.find((l) => l.id === 'hydrant')?.visible).toBe(true)
  })

  it('a fresh incident of another category leaves it hidden', () => {
    const { layers } = deriveInitial(null, 'inc1', {}, 'Dienstleistungen')
    expect(layers.find((l) => l.id === 'hydrant')?.visible).toBe(false)
  })

  it('persisted layer state wins — a deliberately hidden layer is never re-forced on reopen', () => {
    const blob = ws({ layerState: [{ id: 'hydrant', visible: false, opacity: 100 }] as Saved['layerState'] })
    const { layers } = deriveInitial(blob, 'inc1', {}, 'Brandbekämpfung')
    expect(layers.find((l) => l.id === 'hydrant')?.visible).toBe(false)
  })
})

describe('deriveInitial — remembered active plan is incident-scoped', () => {
  const blob = ws({ activePlanId: 'modul2' })

  it('honours the remembered plan when reopening the SAME incident', () => {
    const s = deriveInitial(blob, 'inc1', { incidentId: 'inc1', activePlanId: 'modul3' })
    expect(s.activePlanId).toBe('modul3') // the cookie's plan wins for this incident
  })

  it('ignores the remembered plan for a DIFFERENT incident (falls back to the blob/default)', () => {
    const s = deriveInitial(blob, 'inc2', { incidentId: 'inc1', activePlanId: 'modul3' })
    expect(s.activePlanId).toBe('modul2') // not modul3 — a new incident doesn't inherit the last one's plan
  })
})

// sanitizeWorkspace is the read-time crash guard in front of deriveInitial: a stale IDB or
// hand-edited/newer-app server blob must load best-effort — well-formed entries kept, the
// malformed rest dropped AND counted (honesty rule), the version flagged. These lock exactly
// that contract in.
describe('sanitizeWorkspace — load gate', () => {
  it('null / undefined pass through as an absent workspace (no noise)', () => {
    expect(sanitizeWorkspace(null)).toEqual({ ws: null, dropped: 0, newerSchema: false })
    expect(sanitizeWorkspace(undefined)).toEqual({ ws: null, dropped: 0, newerSchema: false })
  })

  it('a non-object blob is rejected entirely and counted', () => {
    const g = sanitizeWorkspace('corrupt')
    expect(g.ws).toBeNull()
    expect(g.dropped).toBe(1)
  })

  it('a well-formed blob passes through with dropped 0 and feeds deriveInitial unchanged', () => {
    const blob = ws({
      entities: [{ id: 'e1' }] as Saved['entities'],
      drawings: [{ id: 'd1' }] as Saved['drawings'],
      trupps: [{ id: 'tr1' }] as Saved['trupps'],
      board: { modul1: [{ id: 'a1' }] } as unknown as Saved['board'],
      settings: { contactIntervalMin: 10 },
      schemaVersion: 1,
    })
    const g = sanitizeWorkspace(blob)
    expect(g.dropped).toBe(0)
    expect(g.newerSchema).toBe(false)
    const s = deriveInitial(g.ws, 'inc1', {})
    expect(s.doc.entities).toHaveLength(1)
    expect(s.trupps).toHaveLength(1)
    expect(s.settings.contactIntervalMin).toBe(10)
  })

  it('drops collection entries without a string id and counts every loss', () => {
    const g = sanitizeWorkspace({
      entities: [{ id: 'e1' }, { id: 42 }, null, 'junk'],
      trupps: [{ id: 'tr1' }, {}],
      mittel: [{ noId: true }],
    })
    expect(g.ws?.entities.map((e) => e.id)).toEqual(['e1'])
    expect(g.ws?.trupps).toHaveLength(1)
    expect(g.ws?.mittel).toHaveLength(0)
    expect(g.dropped).toBe(5) // 3 entities + 1 trupp + 1 mittel
  })

  it('resets wrong-typed fields (array-as-record, record-as-array) instead of crashing', () => {
    const g = sanitizeWorkspace({
      entities: { not: 'an array' },
      attendance: ['not', 'a', 'record'],
      building: 'garbage',
      activePlanId: 7,
    })
    expect(g.ws?.entities).toEqual([])
    expect(g.ws?.attendance).toBeUndefined()
    expect(g.ws?.building).toBeUndefined()
    expect(g.ws?.activePlanId).toBeUndefined()
    expect(g.dropped).toBe(3) // entities + attendance + building (a wrong-typed plain string resets uncounted)
  })

  it('board docs keep only array values with object annos (normalizeBoard would crash otherwise)', () => {
    const g = sanitizeWorkspace({ board: { modul1: [{ id: 'a1' }, 'junk'], broken: 'not-an-array' } })
    expect(g.ws?.board).toEqual({ modul1: [{ id: 'a1' }] })
    expect(g.dropped).toBe(2) // one non-object anno + one non-array doc
    expect(() => deriveInitial(g.ws, 'inc1', {})).not.toThrow()
  })

  it('an explicit null building survives (means "no Gebäude", not "absent field")', () => {
    const g = sanitizeWorkspace({ building: null })
    expect(g.ws?.building).toBeNull()
    expect(g.dropped).toBe(0)
  })

  it('flags a NEWER schemaVersion but still loads best-effort', () => {
    const g = sanitizeWorkspace({ entities: [{ id: 'e1' }], schemaVersion: WORKSPACE_SCHEMA_VERSION + 1 })
    expect(g.newerSchema).toBe(true)
    expect(g.ws?.entities).toHaveLength(1) // best-effort, not refused — 3am rule: degrade, don't block
  })

  it('current and older stamps do not flag', () => {
    expect(sanitizeWorkspace({ schemaVersion: WORKSPACE_SCHEMA_VERSION }).newerSchema).toBe(false)
    expect(sanitizeWorkspace({}).newerSchema).toBe(false) // pre-versioning blob
  })
})

describe('sanitizeWorkspace — Rauch cloud → VKF Rauch symbol migration', () => {
  it('converts a placed cloud (map entity + plan anno) into the VKF Rauch symbol', () => {
    const g = sanitizeWorkspace({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      entities: [{ id: 'sh1', kind: 'shape', shape: 'cloud', coord: [7.5, 47.5], color: '#6b7280', sizeM: 80, sizeN: 0.18, rotation: 30 }],
      board: { gebaeude: [{ id: 'sha', kind: 'shape', shape: 'cloud', x: 0.5, y: 0.5, floor: 1, color: '#6b7280', sizeN: 0.2, rotation: 10 }] },
    })
    // entities migrate at sanitize; the board migrates via normalizeBoard inside deriveInitial
    const s = deriveInitial(g.ws, 'inc1', {})
    const e = s.doc.entities[0] as unknown as Record<string, unknown>
    expect(e.kind).toBe('symbol')
    expect(e.symbol).toBe('VKF Rauch')
    expect(e.shape).toBeUndefined()
    expect(e.sizeM).toBeUndefined()
    expect(e.sizeN).toBeUndefined()
    expect(e.rotation).toBe(30) // rotation preserved
    const a = s.board.gebaeude[0] as unknown as Record<string, unknown>
    expect(a.kind).toBe('symbol')
    expect(a.symbol).toBe('VKF Rauch')
    expect(a.shape).toBeUndefined()
  })
  it('leaves other shapes (arrow/square) untouched', () => {
    const g = sanitizeWorkspace({ schemaVersion: WORKSPACE_SCHEMA_VERSION, entities: [{ id: 'sh2', kind: 'shape', shape: 'arrow', coord: [7.5, 47.5] }] })
    expect((g.ws!.entities[0] as unknown as Record<string, unknown>).kind).toBe('shape')
  })
})
