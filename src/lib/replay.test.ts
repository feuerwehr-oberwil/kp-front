import { describe, expect, it } from 'vitest'
import { activeReplayRange, activityMoments, findGaps, fractionAtTime, gapAt, journalMoments, layoutTrack, momentAt, segmentsFromGaps, stateAt, stepMoment, timeAtFraction, vehiclesAt } from './replay'
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

describe('activeReplayRange — trim idle head/tail to where changes happened', () => {
  const WIN_START = 0, WIN_END = 1_000_000
  it('survives an event count that would blow the spread-argument limit', () => {
    // The counts here are bounded by the SERVER, not by the client: a multi-day Einsatz keeps
    // accumulating events. Math.min(...arr) throws RangeError well before this size, which would
    // crash the replay view from data volume alone.
    const many = Array.from({ length: 200_000 }, (_, i) => ev({ op_type: 'entity.add', occurred_at: iso(i + 1) }))
    const r = activeReplayRange(many, [], WIN_START, WIN_END)
    expect(r).toEqual({ startMs: 1, endMs: 200_000 })
  })

  it('spans first → last change, not the whole incident window', () => {
    const r = activeReplayRange([
      ev({ op_type: 'incident.create', occurred_at: iso(0) }),   // idle head — excluded
      ev({ op_type: 'entity.add', occurred_at: iso(200_000) }),
      ev({ op_type: 'draw.add', occurred_at: iso(500_000) }),
    ], [], WIN_START, WIN_END)
    expect(r).toEqual({ startMs: 200_000, endMs: 500_000 })  // idle before first + after last trimmed
  })
  it('ignores incident.create so a late first action trims the head', () => {
    const r = activeReplayRange([ev({ op_type: 'incident.create', occurred_at: iso(0) }), ev({ op_type: 'status.change', occurred_at: iso(300_000) })], [], WIN_START, WIN_END)
    expect(r.startMs).toBe(300_000)
  })
  it('includes vehicle samples as changes', () => {
    const r = activeReplayRange([ev({ op_type: 'entity.add', occurred_at: iso(400_000) })], [{ ts: iso(100_000) }], WIN_START, WIN_END)
    expect(r).toEqual({ startMs: 100_000, endMs: 400_000 })
  })
  it('falls back to the full window when nothing but incident.create was recorded', () => {
    expect(activeReplayRange([ev({ op_type: 'incident.create', occurred_at: iso(0) })], [], WIN_START, WIN_END)).toEqual({ startMs: WIN_START, endMs: WIN_END })
    expect(activeReplayRange([], [], WIN_START, WIN_END)).toEqual({ startMs: WIN_START, endMs: WIN_END })
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

describe('activityMoments', () => {
  it('ignores workspace.save — a save is not evidence anybody did anything', () => {
    // THE central rule. The workspace is one blob of twenty-odd fields, so a save fires when a
    // layer is toggled or the operator switches Lage→Plan, and its payload is only {rev: N}.
    // Counting saves painted the bar blue across stretches where nothing had happened.
    expect(activityMoments([{ occurred_at: iso(5_000), op_type: 'workspace.save' }])).toEqual([])
  })

  it('drops incident.create — structural, and long before the work', () => {
    expect(activityMoments([{ occurred_at: iso(1_000), op_type: 'incident.create' }])).toEqual([])
  })

  it('counts status, Divera and Einsatzdaten changes', () => {
    const moments = activityMoments([
      { occurred_at: iso(1_000), op_type: 'status.change' },
      { occurred_at: iso(2_000), op_type: 'divera.update' },
      { occurred_at: iso(3_000), op_type: 'meta.change' },
    ])
    expect(moments.sort((a, b) => a - b)).toEqual([1_000, 2_000, 3_000])
  })

  it('counts journal entries — that is what an operator means by «etwas ist passiert»', () => {
    expect(activityMoments([], [{ at: iso(8_000) }])).toEqual([8_000])
  })

  it('skips legacy journal rows that carry only HH:MM', () => {
    // Guessing a calendar day onto them would silently close a gap that is really there.
    expect(activityMoments([], [{}, { at: iso(4_000) }])).toEqual([4_000])
  })

  it('ignores unparseable timestamps rather than emitting NaN', () => {
    expect(activityMoments([{ occurred_at: 'not-a-date', op_type: 'status.change' }])).toEqual([])
    expect(activityMoments([], [{ at: 'not-a-date' }])).toEqual([])
  })
})

describe('journalMoments / momentAt — the Verlauf on the replay axis', () => {
  const rows = [
    { id: 'c', at: iso(3_000), text: 'Feuer aus' },
    { id: 'a', at: iso(1_000), text: 'Erkundung läuft' },
    { id: 'b', at: iso(2_000), text: 'Trupp 1 eingesetzt' },
  ]

  it('sorts by time — the lane is an axis, not the order rows were written in', () => {
    expect(journalMoments(rows).map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('⚠️ drops rows with no absolute date rather than placing them at 0', () => {
    // Legacy rows carry only HH:MM. At 0 they would sit at the start of the incident — a
    // confident lie about when something was said, in the one view whose claim is «this is
    // how it was at this moment».
    expect(journalMoments([{ id: 'x', text: 'legacy' }, { id: 'y', at: 'not-a-date', text: '' }])).toEqual([])
  })

  it('needs an id — a moment nothing can be seeked to is not one', () => {
    expect(journalMoments([{ at: iso(1_000), text: 'orphan' }])).toEqual([])
  })

  it('momentAt takes the last row at or before the playhead', () => {
    const ms = journalMoments(rows)
    expect(momentAt(ms, 2_500)?.id).toBe('b')
    expect(momentAt(ms, 2_000)?.id).toBe('b') // exactly on a row is that row
    expect(momentAt(ms, 9_000)?.id).toBe('c')
  })

  it('momentAt is null before the first row — nothing had been written yet', () => {
    expect(momentAt(journalMoments(rows), 500)).toBeNull()
  })
})

describe('segmentsFromGaps', () => {
  it('returns the stretches between the gaps', () => {
    const segs = segmentsFromGaps([{ fromMs: 200, toMs: 800 }], 0, 1000)
    expect(segs).toEqual([{ fromMs: 0, toMs: 200 }, { fromMs: 800, toMs: 1000 }])
  })

  it('drops a leading segment when the gap starts at the very beginning', () => {
    expect(segmentsFromGaps([{ fromMs: 0, toMs: 800 }], 0, 1000)).toEqual([{ fromMs: 800, toMs: 1000 }])
  })

  it('falls back to the whole range when there are no gaps', () => {
    expect(segmentsFromGaps([], 0, 1000)).toEqual([{ fromMs: 0, toMs: 1000 }])
  })

  it('returns NOTHING when the gaps cover the whole range', () => {
    // Regression: the old fallback returned the full range as a segment even here, so the same
    // span was both a segment and a gap. The track then drew a full-width blue bar with a stub
    // break at the end, labelled with the entire elapsed time.
    expect(segmentsFromGaps([{ fromMs: 0, toMs: 1000 }], 0, 1000)).toEqual([])
  })

  it('returns nothing for a zero-width range', () => {
    expect(segmentsFromGaps([], 500, 500)).toEqual([])
  })
})

describe('layoutTrack', () => {
  const segs = [{ fromMs: 0, toMs: 1000 }, { fromMs: 9000, toMs: 10_000 }]
  const gaps = [{ fromMs: 1000, toMs: 9000 }]

  it('gives the break a fixed slice and splits the rest by real duration', () => {
    const pieces = layoutTrack(segs, gaps, 0.1)
    expect(pieces.map((p) => p.kind)).toEqual(['segment', 'gap', 'segment'])
    // the 8 s of silence gets 10 %; the two equal 1 s segments split the remaining 90 %
    expect(pieces[1].widthFrac).toBeCloseTo(0.1)
    expect(pieces[0].widthFrac).toBeCloseTo(0.45)
    expect(pieces[2].widthFrac).toBeCloseTo(0.45)
  })

  it('never lets breaks take more than half the bar', () => {
    // Ten gaps at 10 % each would leave nothing for the work this exists to make room for.
    const manyGaps = Array.from({ length: 10 }, (_, i) => ({ fromMs: i * 100 + 50, toMs: i * 100 + 90 }))
    const pieces = layoutTrack([{ fromMs: 0, toMs: 50 }], manyGaps, 0.1)
    const gapTotal = pieces.filter((p) => p.kind === 'gap').reduce((n, p) => n + p.widthFrac, 0)
    expect(gapTotal).toBeLessThanOrEqual(0.5 + 1e-9)
  })

  it('lays the pieces out end to end, filling the width', () => {
    const pieces = layoutTrack(segs, gaps, 0.1)
    const last = pieces[pieces.length - 1]
    expect(last.leftFrac + last.widthFrac).toBeCloseTo(1)
  })

  it('fills the width with the breaks when there are no segments at all', () => {
    // Regression: an incident with a single recorded moment in two days yields gaps and no
    // segments. Giving each gap its fixed slice then drew two stubs and left ~86 % of the bar
    // blank — nothing to scrub and nothing to read.
    const pieces = layoutTrack([], [{ fromMs: 0, toMs: 400 }, { fromMs: 600, toMs: 1000 }], 0.07)
    const total = pieces.reduce((n, p) => n + p.widthFrac, 0)
    expect(total).toBeCloseTo(1)
    const last = pieces[pieces.length - 1]
    expect(last.leftFrac + last.widthFrac).toBeCloseTo(1)
  })
})

describe('timeAtFraction / fractionAtTime', () => {
  const segs = [{ fromMs: 0, toMs: 1000 }, { fromMs: 9000, toMs: 10_000 }]
  const gaps = [{ fromMs: 1000, toMs: 9000 }]
  const pieces = layoutTrack(segs, gaps, 0.1)

  it('maps within a segment linearly', () => {
    expect(timeAtFraction(pieces, 0)).toBeCloseTo(0)
    expect(timeAtFraction(pieces, 0.225)).toBeCloseTo(500, -1)
  })

  it('clicking a break lands on the moment it ends, never inside the silence', () => {
    expect(timeAtFraction(pieces, 0.5)).toBe(9000)
  })

  it('round-trips a time through the layout and back', () => {
    const t = 9500
    expect(timeAtFraction(pieces, fractionAtTime(pieces, t))).toBeCloseTo(t, -1)
  })

  it('places a moment inside a break at the left edge of that break', () => {
    expect(fractionAtTime(pieces, 5000)).toBeCloseTo(pieces[1].leftFrac)
  })
})

describe('findGaps', () => {
  const MIN = 60_000

  it('finds the stretch between two distant moments', () => {
    const gaps = findGaps([0, 10 * MIN], 0, 10 * MIN, 2 * MIN)
    expect(gaps).toEqual([{ fromMs: 0, toMs: 10 * MIN }])
  })

  it('leaves closely-spaced moments alone', () => {
    // A pause in the work is not a hole in the record; skipping it would misrepresent the pace.
    expect(findGaps([0, MIN, 2 * MIN], 0, 2 * MIN, 5 * MIN)).toEqual([])
  })

  it('catches the trailing gap — the forgotten-close case', () => {
    // Two entries a minute apart, then the incident sits open until 10 h. Only the tail is a
    // gap — this is the stretch the whole feature exists for.
    const gaps = findGaps([0, MIN], 0, 600 * MIN, 2 * MIN)
    expect(gaps).toEqual([{ fromMs: MIN, toMs: 600 * MIN }])
  })

  it('catches a leading gap before the first activity', () => {
    const gaps = findGaps([30 * MIN], 0, 30 * MIN, 2 * MIN)
    expect(gaps).toEqual([{ fromMs: 0, toMs: 30 * MIN }])
  })

  it('sorts unordered input before pairing', () => {
    const gaps = findGaps([10 * MIN, 0], 0, 10 * MIN, 2 * MIN)
    expect(gaps).toEqual([{ fromMs: 0, toMs: 10 * MIN }])
  })

  it('ignores moments outside the range', () => {
    expect(findGaps([-99 * MIN, 5 * MIN, 999 * MIN], 0, 5 * MIN, 2 * MIN)).toEqual([
      { fromMs: 0, toMs: 5 * MIN },
    ])
  })
})

describe('gapAt', () => {
  const gaps = [{ fromMs: 100, toMs: 900 }]

  it('reports the gap the playhead is inside', () => {
    expect(gapAt(gaps, 500)).toEqual(gaps[0])
  })

  it('excludes the endpoints — those are real moments', () => {
    // Landing exactly on toMs after a jump must not re-trigger the same skip forever.
    expect(gapAt(gaps, 100)).toBeNull()
    expect(gapAt(gaps, 900)).toBeNull()
  })
})

describe('stepMoment', () => {
  const moments = [0, 5_000, 9_000]

  it('steps to the next moment strictly after the playhead', () => {
    expect(stepMoment(moments, 0, 1)).toBe(5_000)
    expect(stepMoment(moments, 4_999, 1)).toBe(5_000)
    expect(stepMoment(moments, 5_000, 1)).toBe(9_000)
  })

  it('steps backwards strictly before the playhead', () => {
    expect(stepMoment(moments, 9_000, -1)).toBe(5_000)
    expect(stepMoment(moments, 5_001, -1)).toBe(5_000)
  })

  it('returns null at either end so the caller can clamp', () => {
    expect(stepMoment(moments, 9_000, 1)).toBeNull()
    expect(stepMoment(moments, 0, -1)).toBeNull()
  })

  it('copes with unsorted input', () => {
    expect(stepMoment([9_000, 0, 5_000], 1_000, 1)).toBe(5_000)
  })
})
