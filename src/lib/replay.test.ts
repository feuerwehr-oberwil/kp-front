import { describe, expect, it } from 'vitest'
import { deriveMarkers, stateAt, vehiclesAt } from './replay'
import type { ReplayBundle, ReplayEvent, VehicleSampleRow } from './replay'
import type { Saved } from './workspace'

const iso = (ms: number) => new Date(ms).toISOString()

const ev = (over: Partial<ReplayEvent>): ReplayEvent => ({
  seq: 0,
  occurred_at: iso(0),
  op_type: 'other',
  ...over,
})

const emptyWs = (): Saved => ({
  entities: [],
  drawings: [],
  recent: [],
  layerState: [],
  timeline: [],
})

// A bundle whose loadSnapshotAt is injected (no network). `snap` returns the anchor.
const bundle = (
  events: ReplayEvent[],
  snap: (tMs: number) => { workspace: Saved | null; occurredMs: number | null } = () => ({
    workspace: null,
    occurredMs: null,
  }),
): ReplayBundle => ({
  incidentId: 'inc1',
  events,
  samples: [],
  startMs: 0,
  endMs: 1_000_000,
  snapshotCache: new Map(),
  loadSnapshotAt: async (tMs: number) => snap(tMs),
})

describe('deriveMarkers', () => {
  it('maps known op types to their kind + label', () => {
    const markers = deriveMarkers([
      ev({ seq: 1, op_type: 'entity.add', occurred_at: iso(1000) }),
      ev({ seq: 2, op_type: 'draw.add', occurred_at: iso(2000) }),
      ev({ seq: 3, op_type: 'status.change', occurred_at: iso(3000) }),
      ev({ seq: 4, op_type: 'incident.create', occurred_at: iso(500) }),
    ])
    expect(markers).toEqual([
      { ms: 1000, seq: 1, kind: 'symbol', label: 'Symbol gesetzt' },
      { ms: 2000, seq: 2, kind: 'draw', label: 'Zeichnung' },
      { ms: 3000, seq: 3, kind: 'status', label: 'Status' },
      { ms: 500, seq: 4, kind: 'status', label: 'Einsatz eröffnet' },
    ])
  })

  it('skips workspace.save (the fold anchor — too dense to mark)', () => {
    const markers = deriveMarkers([ev({ op_type: 'workspace.save', occurred_at: iso(1) })])
    expect(markers).toEqual([])
  })

  it('skips unknown / noisy op types', () => {
    const markers = deriveMarkers([
      ev({ op_type: 'entity.move' }),
      ev({ op_type: 'layer.toggle' }),
      ev({ op_type: 'mystery' }),
    ])
    expect(markers).toEqual([])
  })

  it('returns an empty array for no events', () => {
    expect(deriveMarkers([])).toEqual([])
  })
})

describe('stateAt — fold over a snapshot anchor', () => {
  it('returns null when there is neither a snapshot nor any event before T', async () => {
    const b = bundle([ev({ op_type: 'entity.add', occurred_at: iso(5000) })])
    expect(await stateAt(b, 1000)).toBeNull()
  })

  it('returns an empty-but-present workspace from an empty snapshot anchor', async () => {
    const b = bundle([], () => ({ workspace: emptyWs(), occurredMs: 0 }))
    const s = await stateAt(b, 1000)
    expect(s).not.toBeNull()
    expect(s?.entities).toEqual([])
  })

  it('folds entity.add events that occur in (snapshot, T]', async () => {
    const events = [
      ev({ seq: 1, op_type: 'entity.add', occurred_at: iso(1000), payload_json: { id: 'e1', entity: { id: 'e1', kind: 'symbol', layer: 'l', coord: [7, 47], symbol: 'X' } } }),
      ev({ seq: 2, op_type: 'entity.add', occurred_at: iso(3000), payload_json: { id: 'e2', entity: { id: 'e2', kind: 'symbol', layer: 'l', coord: [8, 48], symbol: 'Y' } } }),
    ]
    const b = bundle(events, () => ({ workspace: emptyWs(), occurredMs: 0 }))
    const at2k = await stateAt(b, 2000)
    expect(at2k?.entities.map((e) => e.id)).toEqual(['e1'])
    const at4k = await stateAt(b, 4000)
    expect(at4k?.entities.map((e) => e.id)).toEqual(['e1', 'e2'])
  })

  it('does not re-apply events already baked into the snapshot (t <= occurredMs)', async () => {
    const snapWs = emptyWs()
    snapWs.entities = [{ id: 'e1', kind: 'symbol', layer: 'l', coord: [7, 47], symbol: 'X' } as never]
    const events = [
      // duplicate add at the snapshot instant — should be skipped, not duplicated
      ev({ seq: 1, op_type: 'entity.add', occurred_at: iso(2000), payload_json: { id: 'e1', entity: { id: 'e1', kind: 'symbol', layer: 'l', coord: [7, 47], symbol: 'X' } } }),
    ]
    const b = bundle(events, () => ({ workspace: snapWs, occurredMs: 2000 }))
    const s = await stateAt(b, 5000)
    expect(s?.entities).toHaveLength(1)
  })

  it('folds entity.move, entity.edit and entity.delete', async () => {
    const snapWs = emptyWs()
    snapWs.entities = [{ id: 'e1', kind: 'symbol', layer: 'l', coord: [7, 47], symbol: 'X', label: 'old' } as never]
    const events = [
      ev({ seq: 1, op_type: 'entity.move', occurred_at: iso(1000), payload_json: { id: 'e1', coord: [9, 49] } }),
      ev({ seq: 2, op_type: 'entity.edit', occurred_at: iso(2000), payload_json: { id: 'e1', patch: { label: 'new' } } }),
    ]
    const b = bundle(events, () => ({ workspace: snapWs, occurredMs: 0 }))
    const moved = await stateAt(b, 1500)
    expect(moved?.entities[0].coord).toEqual([9, 49])
    expect(moved?.entities[0].label).toBe('old')
    const edited = await stateAt(b, 2500)
    expect(edited?.entities[0].label).toBe('new')

    const delEvents = [ev({ seq: 1, op_type: 'entity.delete', occurred_at: iso(1000), payload_json: { id: 'e1' } })]
    const bd = bundle(delEvents, () => ({ workspace: snapWs, occurredMs: 0 }))
    const deleted = await stateAt(bd, 1500)
    expect(deleted?.entities).toHaveLength(0)
  })

  it('does not mutate the cached snapshot blob (clones the anchor)', async () => {
    const snapWs = emptyWs()
    const events = [ev({ seq: 1, op_type: 'entity.add', occurred_at: iso(1000), payload_json: { id: 'e1', entity: { id: 'e1', kind: 'symbol', layer: 'l', coord: [7, 47], symbol: 'X' } } })]
    const b = bundle(events, () => ({ workspace: snapWs, occurredMs: 0 }))
    await stateAt(b, 2000)
    expect(snapWs.entities).toHaveLength(0) // original untouched
  })

  it('folds draw.add and layer.toggle (overlay flip)', async () => {
    const snapWs = emptyWs()
    snapWs.layerState = [{ id: 'hydranten', visible: false }]
    const events = [
      ev({ seq: 1, op_type: 'draw.add', occurred_at: iso(1000), payload_json: { id: 'd1', drawing: { id: 'd1', kind: 'line', coords: [[7, 47], [8, 48]] } } }),
      ev({ seq: 2, op_type: 'layer.toggle', occurred_at: iso(2000), payload_json: { id: 'hydranten', visible: true } }),
    ]
    const b = bundle(events, () => ({ workspace: snapWs, occurredMs: 0 }))
    const s = await stateAt(b, 3000)
    expect(s?.drawings.map((d) => d.id)).toEqual(['d1'])
    expect(s?.layerState.find((l) => l.id === 'hydranten')?.visible).toBe(true)
  })

  it('treats a base-layer toggle as a radio group (others off)', async () => {
    const snapWs = emptyWs()
    snapWs.layerState = [
      { id: 'osm', visible: true },
      { id: 'satellite', visible: false },
    ]
    const events = [ev({ seq: 1, op_type: 'layer.toggle', occurred_at: iso(1000), payload_json: { id: 'satellite', base: true } })]
    const b = bundle(events, () => ({ workspace: snapWs, occurredMs: 0 }))
    const s = await stateAt(b, 2000)
    expect(s?.layerState.find((l) => l.id === 'satellite')?.visible).toBe(true)
    expect(s?.layerState.find((l) => l.id === 'osm')?.visible).toBe(false)
  })

  it('stops folding at the cursor (t > tMs breaks)', async () => {
    const events = [
      ev({ seq: 1, op_type: 'entity.add', occurred_at: iso(1000), payload_json: { id: 'a', entity: { id: 'a', kind: 'symbol', layer: 'l', coord: [7, 47], symbol: 'X' } } }),
      ev({ seq: 2, op_type: 'entity.add', occurred_at: iso(9000), payload_json: { id: 'b', entity: { id: 'b', kind: 'symbol', layer: 'l', coord: [7, 47], symbol: 'X' } } }),
    ]
    const b = bundle(events, () => ({ workspace: emptyWs(), occurredMs: 0 }))
    const s = await stateAt(b, 5000)
    expect(s?.entities.map((e) => e.id)).toEqual(['a'])
  })
})

describe('attachment and Plan replay folding', () => {
  it('replays attach intent and fallback geometry between snapshots', async () => {
    const ws = emptyWs()
    ws.drawings = [{ id: 'l1', kind: 'line', coords: [[0, 0], [1, 1]] }]
    const attachment = { target: { kind: 'object', id: 'pump' }, routing: 'direct' }
    const b = bundle([ev({ seq: 1, op_type: 'draw.attach', occurred_at: iso(1000), payload_json: { id: 'l1', endpoint: 'start', attachment, fallback: [2, 3] } })], () => ({ workspace: ws, occurredMs: 0 }))
    const out = await stateAt(b, 2000)
    expect(out?.drawings[0]).toMatchObject({ coords: [[2, 3], [1, 1]], startAttachment: attachment })
  })

  it('replays board add/edit/delete payloads including per-vertex floors', async () => {
    const events = [
      ev({ seq: 1, op_type: 'board.add', occurred_at: iso(1000), payload_json: { id: 'p1', planId: 'gebaeude', anno: { id: 'p1', kind: 'draw', pts: [[0, 0, 0], [1, 1, 1]] } } }),
      ev({ seq: 2, op_type: 'board.edit', occurred_at: iso(2000), payload_json: { id: 'p1', planId: 'gebaeude', patch: { color: 'red' } } }),
    ]
    const b = bundle(events, () => ({ workspace: { ...emptyWs(), board: {} }, occurredMs: 0 }))
    expect((await stateAt(b, 3000))?.board?.gebaeude[0]).toMatchObject({ color: 'red', pts: [[0, 0, 0], [1, 1, 1]] })
  })
})

describe('vehiclesAt — interpolated sample paths', () => {
  const sample = (over: Partial<VehicleSampleRow>): VehicleSampleRow => ({
    device_id: 1,
    ts: iso(0),
    lat: 47,
    lng: 7,
    ...over,
  })

  it('returns an empty array when there are no samples', () => {
    expect(vehiclesAt([], 1000)).toEqual([])
  })

  it('linearly interpolates a position halfway between two samples', () => {
    const samples = [
      sample({ ts: iso(0), lng: 7, lat: 47, course: 90 }),
      sample({ ts: iso(1000), lng: 9, lat: 49, course: 180 }),
    ]
    const [v] = vehiclesAt(samples, 500)
    expect(v.coord[0]).toBeCloseTo(8, 6)
    expect(v.coord[1]).toBeCloseTo(48, 6)
    // course comes from prev sample when available
    expect(v.course).toBe(90)
  })

  it('holds at the last sample when T is past the final fix', () => {
    const samples = [
      sample({ ts: iso(0), lng: 7, lat: 47 }),
      sample({ ts: iso(1000), lng: 9, lat: 49, course: 270 }),
    ]
    const [v] = vehiclesAt(samples, 5000)
    expect(v.coord).toEqual([9, 49])
    expect(v.course).toBe(270)
  })

  it('skips a device whose first sample is after T (not yet present)', () => {
    const samples = [sample({ device_id: 2, ts: iso(5000) })]
    expect(vehiclesAt(samples, 1000)).toEqual([])
  })

  it('returns one entry per device and sorts unordered samples by time', () => {
    const samples = [
      sample({ device_id: 1, ts: iso(2000), lng: 10, lat: 50 }),
      sample({ device_id: 1, ts: iso(0), lng: 0, lat: 40 }),
      sample({ device_id: 2, ts: iso(0), lng: 5, lat: 45 }),
    ]
    const out = vehiclesAt(samples, 1000)
    expect(out.map((v) => v.deviceId).sort()).toEqual([1, 2])
    const d1 = out.find((v) => v.deviceId === 1)!
    // halfway between (0,40) at t0 and (10,50) at t2000 → (5,45)
    expect(d1.coord[0]).toBeCloseTo(5, 6)
    expect(d1.coord[1]).toBeCloseTo(45, 6)
  })

  it('falls back to next sample course when prev has none', () => {
    const samples = [
      sample({ ts: iso(0), course: null }),
      sample({ ts: iso(1000), lng: 8, lat: 48, course: 45 }),
    ]
    const [v] = vehiclesAt(samples, 500)
    expect(v.course).toBe(45)
  })

  it('handles a single sample (no next) by holding it', () => {
    const samples = [sample({ ts: iso(0), lng: 7, lat: 47, course: 12 })]
    const [v] = vehiclesAt(samples, 500)
    expect(v.coord).toEqual([7, 47])
    expect(v.course).toBe(12)
  })
})
