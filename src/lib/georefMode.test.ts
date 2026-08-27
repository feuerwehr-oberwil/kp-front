import { describe, it, expect, vi, beforeEach } from 'vitest'
import { saveGeoref } from './stationPlanScale'
import {
  beginTap,
  GEOREF_OFF,
  GEOREF_TAP_SLOP_PX,
  isPlacingTap,
  trackTap,
  georefDispatch,
  georefPhoneTargetPoint,
  resetGeorefMode,
  georefChip,
  georefLamp,
  georefMatching,
  georefPlacing,
  georefPointNo,
  georefQueueNo,
  georefReduce,
  georefSnapshot,
  georefWantsMap,
  georefWarnings,
  placeGeorefPhoneTarget,
  registerGeorefPhoneTarget,
  resetGeorefPlan,
  transferGeorefPlan,
  type GeorefModeState,
} from './georefMode'
import { fitSimilarity, PAIR_EPS_N, type Georef, type GeorefPair } from './georef'

// The store persists on its own (the surface that completes a pair may be unmounted by then), so
// the write is stubbed rather than the network.
const { mockGeorefForPlan } = vi.hoisted(() => ({
  mockGeorefForPlan: vi.fn<(id: string) => Georef | null>(() => null),
}))

vi.mock('./stationPlanScale', () => ({
  georefForPlan: mockGeorefForPlan,
  saveGeoref: vi.fn(() => Promise.resolve()),
  // the store subscribes at module load so a reference set on ANOTHER device re-renders here
  subscribeStationPlanScales: vi.fn(() => () => {}),
}))

// The pairing mode is the one piece of this feature that has to be right on a phone, in the
// dark, halfway through a gesture — so it is a pure reducer and it is tested as one. Every case
// below is a sequence somebody actually performs; none of them touch React or the network.

const AR = 1.5 // plan width / height, the `measureAR` a landscape sheet has

/** Arm the mode on a plan, optionally seeded with pairs the sheet already had. */
const armed = (pairs: GeorefPair[] = []): GeorefModeState =>
  georefReduce(GEOREF_OFF, { type: 'start', planId: 'modul2', pairs, aspect: AR })

const pair = (x: number, y: number, lng: number, lat: number): GeorefPair =>
  ({ plan: { x, y }, lngLat: { lng, lat }, kind: 'gesetzt' })

describe('phone fixed reference target', () => {
  beforeEach(() => resetGeorefMode())

  it('centres inside the usable lane below chrome, above controls, and within edge padding', () => {
    expect(georefPhoneTargetPoint(
      { left: 0, top: 0, right: 390, bottom: 844 },
      { top: 68, bottom: 620 },
      18,
    )).toEqual({ x: 195, y: 344 })
    expect(georefPhoneTargetPoint(
      { left: 0, top: 0, right: 40, bottom: 100 },
      { top: 40, bottom: 70 },
      18,
    )).toBeNull()
  })

  it('the explicit action can start on the Plan', () => {
    georefDispatch({ type: 'start', planId: 'modul2', pairs: [], aspect: AR })
    const unregister = registerGeorefPhoneTarget('plan', () => ({ x: 0.42, y: 0.31 }))
    expect(placeGeorefPhoneTarget('plan')).toBe(true)
    expect(georefSnapshot().queue).toEqual([{ x: 0.42, y: 0.31 }])
    unregister()
  })

  it('the explicit action can start on the Karte', () => {
    georefDispatch({ type: 'start', planId: 'modul2', pairs: [], aspect: AR })
    georefDispatch({ type: 'goMap' })
    const unregister = registerGeorefPhoneTarget('map', () => ({ lng: 7.527, lat: 47.516 }))
    expect(placeGeorefPhoneTarget('map')).toBe(true)
    expect(georefSnapshot().mapQueue).toEqual([{ lng: 7.527, lat: 47.516 }])
    unregister()
  })

  it('refuses an unavailable or out-of-sheet target without inventing a point', () => {
    georefDispatch({ type: 'start', planId: 'modul2', pairs: [], aspect: AR })
    const unregister = registerGeorefPhoneTarget('plan', () => null)
    expect(placeGeorefPhoneTarget('plan')).toBe(false)
    expect(georefSnapshot().queue).toEqual([])
    unregister()
  })
})

describe('georefReduce · placing a pair', () => {
  it('arms on a plan and asks for the plan first', () => {
    const s = armed()
    expect(s.planId).toBe('modul2')
    expect(s.want).toBe('plan')
    expect(georefPlacing(s)).toBe(false)
    expect(georefPointNo(s)).toBe(1)
  })

  it('a plan tap opens a point — and does NOT drag the operator to the map', () => {
    const s = georefReduce(armed(), { type: 'planTap', pt: { x: 0.2, y: 0.3 } })
    // ⚠️ Both surfaces' existing crosses stay directly draggable while points are queued.
    // A phone correction must not require deleting and recreating a pair.
    expect(georefPlacing(s)).toBe(false)
    expect(georefMatching(s)).toBe(false)
    expect(s.queue).toEqual([{ x: 0.2, y: 0.3 }])
    // ⚠️ the whole point of the queue: the sheet stays in front of you until you say otherwise
    expect(s.want).toBe('plan')
    expect(s.pairs).toHaveLength(0) // an open point is not a pair
    expect(georefWantsMap(s)).toBe(true) // …the map will take it when you get there
  })

  it('tapping the plan again QUEUES a second point instead of moving the first', () => {
    let s = georefReduce(armed(), { type: 'planTap', pt: { x: 0.2, y: 0.3 } })
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.4, y: 0.5 } })
    expect(s.queue).toEqual([{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.5 }])
    expect(s.pairs).toHaveLength(0)
    // the numbers a sheet full of open crosses carries, and the one the map is asking for
    expect(georefQueueNo(s, 0)).toBe(1)
    expect(georefQueueNo(s, 1)).toBe(2)
    expect(georefPointNo(s)).toBe(3) // on the plan: the one a further tap would open
  })

  it('may start on the map and gives that half point 1', () => {
    const s = georefReduce(armed(), { type: 'mapTap', lngLat: { lng: 7.5, lat: 47.5 } })
    expect(s.mapQueue).toEqual([{ lng: 7.5, lat: 47.5 }])
    expect(s.pairs).toHaveLength(0)
    expect(s.want).toBe('map')
    expect(georefPointNo(s)).toBe(2)
  })

  it('matches map-first points from the plan in the same numbered order', () => {
    let s = armed()
    s = georefReduce(s, { type: 'goMap' })
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.5, lat: 47.5 } })
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.6, lat: 47.6 } })
    expect(s.mapQueue).toHaveLength(2)
    s = georefReduce(s, { type: 'goPlan' })
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.2, y: 0.3 } })
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.4, y: 0.5 } })
    expect(s.pairs).toEqual([
      pair(0.2, 0.3, 7.5, 47.5),
      pair(0.4, 0.5, 7.6, 47.6),
    ])
    expect(s.mapQueue).toEqual([])
  })

  it('the map tap completes the pair and re-arms for the next point', () => {
    let s = georefReduce(armed(), { type: 'planTap', pt: { x: 0.2, y: 0.3 } })
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.5, lat: 47.5 } })
    expect(s.pairs).toEqual([{ plan: { x: 0.2, y: 0.3 }, lngLat: { lng: 7.5, lat: 47.5 }, kind: 'gesetzt' }])
    expect(s.queue).toEqual([])
    expect(s.want).toBe('plan')
    // ⚠️ still armed: the third point is what earns a residual, so it has to be cheap
    expect(s.planId).toBe('modul2')
    expect(georefPointNo(s)).toBe(2)
  })

  it('the map matches the OLDEST open point first, and stays on the map until they are done', () => {
    let s = armed()
    for (const [x, y] of [[0.2, 0.3], [0.6, 0.3], [0.4, 0.8]] as const) s = georefReduce(s, { type: 'planTap', pt: { x, y } })
    expect(s.queue).toHaveLength(3)
    s = georefReduce(s, { type: 'goMap' })
    expect(s.want).toBe('map')
    expect(georefPointNo(s)).toBe(1) // over there the number is the OLDEST open point
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.5, lat: 47.5 } })
    expect(s.pairs[0].plan).toEqual({ x: 0.2, y: 0.3 })
    expect(s.want).toBe('map') // two still open — no hop back mid-queue
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.501, lat: 47.5 } })
    expect(s.pairs[1].plan).toEqual({ x: 0.6, y: 0.3 })
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.5005, lat: 47.4995 } })
    expect(s.pairs.map((p) => p.plan)).toEqual([{ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.3 }, { x: 0.4, y: 0.8 }])
    expect(s.queue).toEqual([])
    expect(s.want).toBe('plan') // …and only now back to the sheet
  })

  it('keeps existing map crosses draggable while unmatched plan points wait', () => {
    let s = armed([pair(0.2, 0.3, 7.5, 47.5)])
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.7, y: 0.8 } })
    expect(s.queue).toHaveLength(1)
    expect(georefMatching(s)).toBe(false)
    const moved = georefReduce(s, { type: 'dragMap', idx: 0, lngLat: { lng: 7.51, lat: 47.51 } })
    expect(moved.pairs[0].lngLat).toEqual({ lng: 7.51, lat: 47.51 })
    expect(moved.queue).toEqual(s.queue)
  })

  it('may switch to the map before either half has been set', () => {
    const s = georefReduce(armed(), { type: 'goMap' })
    expect(s.want).toBe('map')
  })

  it('Deckung prüfen may switch to the map without an open point', () => {
    let s = georefReduce(armed(TWO), { type: 'check', on: true })
    s = georefReduce(s, { type: 'goMap' })
    expect(s.want).toBe('map')
    expect(s.check).toBe(true)
    expect(georefWantsMap(s)).toBe(false)
    expect(s.queue).toEqual([])
  })

  it('the shared loupe follows the aimed surface while queued points stay intact', () => {
    let s = georefReduce(armed(), { type: 'planTap', pt: { x: 0.2, y: 0.3 } })
    s = georefReduce(s, { type: 'goMap' })
    expect(s.want).toBe('map')
    s = georefReduce(s, { type: 'goPlan' })
    expect(s.want).toBe('plan')
    expect(s.queue).toEqual([{ x: 0.2, y: 0.3 }])
  })

  it('re-pairing the SAME plan point replaces it instead of appending a contradiction', () => {
    let s = armed([pair(0.2, 0.3, 7.5, 47.5)])
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.2, y: 0.3 } })
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.6, lat: 47.6 } })
    expect(s.pairs).toHaveLength(1)
    expect(s.pairs[0].lngLat).toEqual({ lng: 7.6, lat: 47.6 })
  })

  it('⚠️ …and the same holds MAP FIRST — the mirror branch must not append either', () => {
    // map half queued, then the operator recognises a corner on the sheet that ALREADY carries a
    // pair. Two pairs on one plan point holding different positions is the self-contradiction
    // `replacePair` exists to make impossible, and it drags the fit toward the worse tap.
    let s = armed([pair(0.2, 0.3, 7.5, 47.5)])
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.6, lat: 47.6 } })
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.2, y: 0.3 } })
    expect(s.pairs).toHaveLength(1)
    expect(s.pairs[0].lngLat).toEqual({ lng: 7.6, lat: 47.6 })
    expect(s.mapQueue).toEqual([])
  })
})

describe('georefReduce · cancelling', () => {
  it('changes the Deckung blend without closing it, and clamps the value', () => {
    let s = georefReduce(armed(TWO), { type: 'check', on: true })
    s = georefReduce(s, { type: 'checkOpacity', opacity: 0.25 })
    expect(s.check).toBe(true)
    expect(s.checkOpacity).toBe(0.25)
    expect(georefReduce(s, { type: 'checkOpacity', opacity: 2 }).checkOpacity).toBe(1)
    expect(georefReduce(s, { type: 'checkOpacity', opacity: -1 }).checkOpacity).toBe(0)
  })

  it('a placement dismisses Deckung prüfen — the outline is stale the instant a point moves', () => {
    const checking = georefReduce(armed(TWO), { type: 'check', on: true })
    expect(checking.check).toBe(true)
    const placed = georefReduce(checking, { type: 'planTap', pt: { x: 0.5, y: 0.5 } })
    expect(placed.check).toBe(false)
    expect(placed.checkReturn).toBeNull()
    expect(placed.queue).toEqual([{ x: 0.5, y: 0.5 }]) // …and the tap itself still counted
  })

  it('leaves Deckung prüfen on the side it opened from without ending alignment', () => {
    let before = georefReduce(armed(TWO), { type: 'pick', idx: 0, side: 'map' })
    before = georefReduce(before, { type: 'mapTap', lngLat: { lng: 7.51, lat: 47.51 } })
    expect(before.want).toBe('map')
    const checking = georefReduce(before, { type: 'check', on: true })
    const after = georefReduce(checking, { type: 'finishCheck' })
    expect(after.check).toBe(false)
    expect(after.want).toBe(before.want)
    expect(after.planId).toBe(before.planId)
    expect(after.pairs).toEqual(before.pairs)
  })

  it('keeps a Passung coverage return alive until the Modul can restore its panel', () => {
    const checking = georefReduce(GEOREF_OFF, { type: 'start', planId: 'modul2', pairs: TWO, aspect: AR, check: true, returnToQuality: true })
    const returning = georefReduce(checking, { type: 'finishCheck' })
    expect(returning.check).toBe(false)
    expect(returning.checkReturn).toBe('quality')
    expect(returning.planId).toBe('modul2')
  })

  it('returns Passung-launched alignment to Passung on both cancel and finish', () => {
    const fromQuality = georefReduce(GEOREF_OFF, { type: 'start', planId: 'modul2', pairs: TWO, aspect: AR, returnToQuality: true })
    const returning = georefReduce(fromQuality, { type: 'end' })
    expect(returning.planId).toBe('modul2')
    expect(returning.want).toBe('plan')
    expect(returning.checkReturn).toBe('quality')
    expect(returning.queue).toEqual([])
    expect(georefReduce(returning, { type: 'dismiss' })).toBe(GEOREF_OFF)
  })

  it('«Fertig» / Esc drops the mode and every point still waiting for its map half', () => {
    let s = georefReduce(armed([pair(0.2, 0.3, 7.5, 47.5)]), { type: 'planTap', pt: { x: 0.7, y: 0.8 } })
    expect(s.queue).toHaveLength(1)
    s = georefReduce(s, { type: 'end' })
    expect(s).toBe(GEOREF_OFF)
  })

  it('«Punkte zurücksetzen» clears pairs AND open points, and stays armed', () => {
    let s = georefReduce(armed([pair(0.2, 0.3, 7.5, 47.5)]), { type: 'planTap', pt: { x: 0.7, y: 0.8 } })
    s = georefReduce(s, { type: 'clear' })
    expect(s.pairs).toEqual([])
    expect(s.queue).toEqual([])
    expect(s.planId).toBe('modul2') // ⚠️ «start over», not «leave»
    // …and with nothing left to clear it is a genuine no-op, so no empty write goes out
    expect(georefReduce(s, { type: 'clear' })).toBe(s)
  })

  it('ending an inactive mode is a genuine no-op (same object, so nothing re-renders)', () => {
    expect(georefReduce(GEOREF_OFF, { type: 'end' })).toBe(GEOREF_OFF)
  })

  it('nothing places while the mode is off', () => {
    expect(georefReduce(GEOREF_OFF, { type: 'planTap', pt: { x: 0.1, y: 0.1 } })).toBe(GEOREF_OFF)
    expect(georefReduce(GEOREF_OFF, { type: 'mapTap', lngLat: { lng: 7.5, lat: 47.5 } })).toBe(GEOREF_OFF)
  })
})

describe('georefReduce · correcting one half', () => {
  const seeded = () => armed([pair(0.2, 0.3, 7.5, 47.5), pair(0.8, 0.7, 7.502, 47.499)])

  it('tapping a PLAN cross re-places only that half, and appends nothing', () => {
    let s = georefReduce(seeded(), { type: 'pick', idx: 0, side: 'plan' })
    expect(s.edit).toEqual({ idx: 0, side: 'plan' })
    expect(s.want).toBe('plan')
    expect(georefWantsMap(s)).toBe(false)
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.25, y: 0.35 } })
    expect(s.pairs).toHaveLength(2)
    expect(s.pairs[0]).toEqual({ plan: { x: 0.25, y: 0.35 }, lngLat: { lng: 7.5, lat: 47.5 }, kind: 'korrigiert' })
    expect(s.edit).toBeNull()
    expect(s.queue).toEqual([]) // a correction is not a new point
  })

  it('tapping a MAP cross sends the operator to the map and corrects there', () => {
    let s = georefReduce(seeded(), { type: 'pick', idx: 1, side: 'map' })
    expect(s.want).toBe('map')
    expect(georefWantsMap(s)).toBe(true)
    // the plan is inert while the MAP half is the one being waited on
    expect(georefReduce(s, { type: 'planTap', pt: { x: 0.1, y: 0.1 } })).toBe(s)
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.51, lat: 47.4 } })
    expect(s.pairs[1]).toEqual({ plan: { x: 0.8, y: 0.7 }, lngLat: { lng: 7.51, lat: 47.4 }, kind: 'korrigiert' })
    expect(s.edit).toBeNull()
  })

  it('picking a cross keeps the queue — those points are work, not a half-finished gesture', () => {
    let s = georefReduce(seeded(), { type: 'planTap', pt: { x: 0.5, y: 0.5 } })
    s = georefReduce(s, { type: 'pick', idx: 0, side: 'plan' })
    expect(s.queue).toEqual([{ x: 0.5, y: 0.5 }])
    expect(s.edit).toEqual({ idx: 0, side: 'plan' })
    // …but only ONE correction at a time: while a cross is picked up every cross goes inert
    expect(georefPlacing(s)).toBe(true)
    expect(georefMatching(s)).toBe(true)
  })

  it('«Punkt löschen» drops that pair and refits from the rest', () => {
    let s = georefReduce(seeded(), { type: 'pick', idx: 0, side: 'plan' })
    s = georefReduce(s, { type: 'removePair', idx: 0 })
    expect(s.pairs).toHaveLength(1)
    expect(s.pairs[0].plan).toEqual({ x: 0.8, y: 0.7 })
    expect(s.edit).toBeNull()
    // one pair left ⇒ no fit at all, and the surfaces say so rather than pretending
    expect(fitSimilarity(s.pairs, AR)).toBeNull()
    // deleting one that isn't there changes nothing
    expect(georefReduce(s, { type: 'removePair', idx: 4 })).toBe(s)
  })

  it('lets an unmatched plan point be selected, corrected and deleted individually', () => {
    let s = georefReduce(seeded(), { type: 'planTap', pt: { x: 0.5, y: 0.5 } })
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.7, y: 0.7 } })
    s = georefReduce(s, { type: 'pickPending', idx: 0, side: 'plan' })
    expect(s.edit).toEqual({ idx: 0, side: 'plan', pending: true })
    expect(georefPointNo(s)).toBe(3)
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.55, y: 0.45 } })
    expect(s.queue).toEqual([{ x: 0.55, y: 0.45 }, { x: 0.7, y: 0.7 }])
    expect(s.edit).toBeNull()

    s = georefReduce(s, { type: 'pickPending', idx: 1, side: 'plan' })
    s = georefReduce(s, { type: 'removePending', idx: 1, side: 'plan' })
    expect(s.queue).toEqual([{ x: 0.55, y: 0.45 }])
    expect(s.pairs).toHaveLength(2)
    expect(s.edit).toBeNull()
  })

  it('lets a map-first unmatched point be selected, corrected and deleted in place', () => {
    let s = georefReduce(seeded(), { type: 'mapTap', lngLat: { lng: 7.55, lat: 47.55 } })
    s = georefReduce(s, { type: 'pickPending', idx: 0, side: 'map' })
    expect(georefPointNo(s)).toBe(3)
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.56, lat: 47.56 } })
    expect(s.mapQueue).toEqual([{ lng: 7.56, lat: 47.56 }])
    expect(s.want).toBe('map')

    s = georefReduce(s, { type: 'pickPending', idx: 0, side: 'map' })
    s = georefReduce(s, { type: 'removePending', idx: 0, side: 'map' })
    expect(s.mapQueue).toEqual([])
    expect(s.pairs).toHaveLength(2)
    expect(s.want).toBe('map')
  })

  it('picking a cross that does not exist changes nothing', () => {
    const s = seeded()
    expect(georefReduce(s, { type: 'pick', idx: 7, side: 'plan' })).toBe(s)
  })

  it('dragging a cross patches that pair live and marks it corrected', () => {
    const plan = georefReduce(seeded(), { type: 'dragPlan', idx: 0, pt: { x: 0.21, y: 0.31 } })
    expect(plan.pairs[0]).toEqual({ plan: { x: 0.21, y: 0.31 }, lngLat: { lng: 7.5, lat: 47.5 }, kind: 'korrigiert' })
    const map = georefReduce(seeded(), { type: 'dragMap', idx: 1, lngLat: { lng: 7.503, lat: 47.4985 } })
    expect(map.pairs[1].plan).toEqual({ x: 0.8, y: 0.7 })
    expect(map.pairs[1].kind).toBe('korrigiert')
  })

  it('⚠️ but never ONTO another cross — coincident references leave the sheet with no fit', () => {
    const s = seeded()
    const onto = { x: 0.8 + PAIR_EPS_N / 2, y: 0.7 } // within a fingertip of pair 1
    expect(georefReduce(s, { type: 'dragPlan', idx: 0, pt: onto })).toBe(s)
    // a hair further out it is a landmark of its own again, and the drag goes through
    const clear = georefReduce(s, { type: 'dragPlan', idx: 0, pt: { x: 0.8 + PAIR_EPS_N * 3, y: 0.7 } })
    expect(clear.pairs[0].plan).toEqual({ x: 0.8 + PAIR_EPS_N * 3, y: 0.7 })
  })

  it('«Abbrechen» on a picked-up cross puts it back down, and nothing else', () => {
    let s = georefReduce(seeded(), { type: 'planTap', pt: { x: 0.5, y: 0.5 } })
    s = georefReduce(s, { type: 'pick', idx: 0, side: 'map' })
    // ⚠️ this is the corner the operator gets stuck in: both surface hops refuse while a cross
    // is picked up, so on a phone the opposite-surface button is dead
    expect(georefReduce(s, { type: 'goPlan' })).toBe(s)
    const back = georefReduce(s, { type: 'unpick' })
    expect(back.edit).toBeNull()
    expect(back.pairs).toBe(s.pairs)  // not moved
    expect(back.queue).toBe(s.queue)  // not thrown away
    expect(back.want).toBe(s.want)    // and the operator is not yanked to the other surface
    expect(georefReduce(back, { type: 'goPlan' }).want).toBe('plan')
  })

  it('putting down a cross that was never picked up is a no-op', () => {
    const s = seeded()
    expect(georefReduce(s, { type: 'unpick' })).toBe(s)
    expect(georefReduce(GEOREF_OFF, { type: 'unpick' })).toBe(GEOREF_OFF)
  })
})

// --- the chip -------------------------------------------------------------------------------

// Two references ~130 m apart: enough baseline to keep the short-baseline warning quiet, so the
// only thing left to complain about is that two pairs solve exactly.
const TWO: GeorefPair[] = [pair(0.2, 0.2, 7.5, 47.5), pair(0.8, 0.8, 7.5015, 47.4991)]
// A triangle, so the fit is over-determined AND not collinear.
const THREE: GeorefPair[] = [
  pair(0.2, 0.2, 7.5, 47.5),
  pair(0.8, 0.2, 7.501, 47.5),
  pair(0.5, 0.8, 7.5005, 47.4995),
]

describe('georefWarnings', () => {
  it('says nothing about a fit that does not exist', () => {
    expect(georefWarnings(null)).toEqual([])
  })

  it('two pairs are always flagged — exact is not the same as checked', () => {
    const fit = fitSimilarity(TWO, AR)!
    expect(fit.n).toBe(2)
    expect(georefWarnings(fit)).toContain('twoPoints')
  })

  it('a short baseline is flagged even when the residuals look perfect', () => {
    // both references on the same house wall, a few metres apart
    const tight = [pair(0.2, 0.2, 7.5, 47.5), pair(0.24, 0.22, 7.50004, 47.49997)]
    expect(georefWarnings(fitSimilarity(tight, AR)!)).toContain('baseline')
  })

  it('three well-spread pairs raise nothing', () => {
    expect(georefWarnings(fitSimilarity(THREE, AR)!)).toEqual([])
  })
})

describe('georefChip', () => {
  it('an un-referenced, un-armed plan offers the verb', () => {
    const chip = georefChip(null, GEOREF_OFF, 'modul2')
    expect(chip.kind).toBe('unlinked')
  })

  it('armed beats linked — while placing, the row belongs to the mode, not to a reading', () => {
    expect(georefChip(null, armed(), 'modul2').kind).toBe('armed')
    expect(georefChip(fitSimilarity(THREE, AR), armed(THREE), 'modul2').kind).toBe('armed')
  })

  it('a mode armed on ANOTHER plan leaves this chip showing its own state', () => {
    const other: GeorefModeState = { ...armed(), planId: 'modul3' }
    expect(georefChip(fitSimilarity(THREE, AR), other, 'modul2').kind).toBe('linked')
  })

  it('two pairs are linked-but-amber, and claim NO residual', () => {
    const chip = georefChip(fitSimilarity(TWO, AR), GEOREF_OFF, 'modul2')
    expect(chip).toMatchObject({ kind: 'linked', residualM: null, warn: true })
  })

  it('a third point earns a number and the calm tone', () => {
    const chip = georefChip(fitSimilarity(THREE, AR), GEOREF_OFF, 'modul2')
    expect(chip.kind).toBe('linked')
    expect(chip.warn).toBe(false)
    expect(chip.residualM).not.toBeNull()
    expect(chip.residualM!).toBeGreaterThanOrEqual(0)
  })
})

// The Ampel is the reading the bar never had. It replaces «2 Paare» — a number nobody can have
// an opinion about — with the sentence that decides whether to place a third point.
describe('georefLamp', () => {
  it('is red with nothing, and says what two points would buy', () => {
    const lamp = georefLamp(null, armed())
    expect(lamp.tone).toBe('red')
    expect(lamp.body).toBe('Zwei Punkte legen den Plan auf die Karte.')
  })

  it('stays red on ONE pair — a single point carries no sheet', () => {
    expect(georefLamp(null, armed([TWO[0]])).tone).toBe('red')
  })

  it('is amber at two, and carries the reason a third is needed', () => {
    const lamp = georefLamp(fitSimilarity(TWO, AR), armed(TWO))
    expect(lamp.tone).toBe('amber')
    expect(lamp.head).toBe('2 Punkte – exakt, aber ungeprüft')
    expect(lamp.body).toContain('erst ein dritter Punkt')
  })

  it('turns green on a measured fit, with the number AND what it is good for', () => {
    const lamp = georefLamp(fitSimilarity(THREE, AR), armed(THREE))
    expect(lamp.tone).toBe('green')
    expect(lamp.head).toMatch(/^3 Punkte · ⌀ \d+\.\d m$/)
    expect(lamp.body).toContain('spiegeln')
  })

  // a measured fit can still be a bad one — then the residual is the least useful thing on the
  // bar, and what is wrong with the POINTS takes its place
  it('stays amber on a collinear fit, and says so instead of boasting the number', () => {
    const line = [pair(0.2, 0.2, 7.5, 47.5), pair(0.5, 0.5, 7.5008, 47.4995), pair(0.8, 0.8, 7.5015, 47.4991)]
    const lamp = georefLamp(fitSimilarity(line, AR), armed(line))
    expect(lamp.tone).toBe('amber')
    expect(lamp.body).toContain('fast auf einer Linie')
  })

  it('counts the unmatched halves that are still waiting', () => {
    const withOpen: GeorefModeState = { ...armed(THREE), queue: [{ x: 0.1, y: 0.1 }] }
    expect(georefLamp(fitSimilarity(THREE, AR), withOpen).head).toContain('1 offen')
  })
})

describe('the store persists exactly the edits — and nothing else', () => {
  beforeEach(() => { resetGeorefMode(); mockGeorefForPlan.mockReset(); mockGeorefForPlan.mockReturnValue(null); vi.mocked(saveGeoref).mockClear() })

  it('arming a plan writes nothing', () => {
    georefDispatch({ type: 'start', planId: 'modul2', pairs: [], aspect: AR })
    georefDispatch({ type: 'planTap', pt: { x: 0.2, y: 0.2 } })
    expect(saveGeoref).not.toHaveBeenCalled() // an open point is not a georeference
  })

  it('⚠️ «Fertig» keeps the pairs instead of writing an empty reference over them', () => {
    georefDispatch({ type: 'start', planId: 'modul2', pairs: [], aspect: AR })
    georefDispatch({ type: 'planTap', pt: { x: 0.2, y: 0.2 } })
    georefDispatch({ type: 'mapTap', lngLat: { lng: 7.5, lat: 47.5 } })
    georefDispatch({ type: 'end' }) // flushes the debounced write
    expect(saveGeoref).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveGeoref).mock.calls[0][0]).toBe('modul2')
    expect(vi.mocked(saveGeoref).mock.calls[0][1].pairs).toHaveLength(1)
  })

  it('a correction is written too — the last one wins, not the first', () => {
    georefDispatch({ type: 'start', planId: 'modul2', pairs: [pair(0.2, 0.3, 7.5, 47.5)], aspect: AR })
    georefDispatch({ type: 'dragPlan', idx: 0, pt: { x: 0.25, y: 0.35 } })
    georefDispatch({ type: 'dragPlan', idx: 0, pt: { x: 0.26, y: 0.36 } })
    georefDispatch({ type: 'end' })
    expect(saveGeoref).toHaveBeenCalledTimes(1) // debounced: one write, not one per frame
    expect(vi.mocked(saveGeoref).mock.calls[0][1].pairs[0].plan).toEqual({ x: 0.26, y: 0.36 })
  })

  it('⚠️ «Referenz zurücksetzen» does not race its own debounced write', () => {
    // Both writes target the SAME document, `apiPut` serializes nothing and the endpoint has no
    // If-Match — so if the pair write landed second the server kept the pairs while the app
    // showed none, and the reset came back at the next boot.
    const key = 'object:o1:plan:modul2'
    georefDispatch({ type: 'start', planId: 'modul2', storageKey: key, pairs: [], aspect: AR })
    georefDispatch({ type: 'planTap', pt: { x: 0.2, y: 0.2 } })
    georefDispatch({ type: 'mapTap', lngLat: { lng: 7.5, lat: 47.5 } }) // a debounced write is armed
    resetGeorefPlan(key)
    return Promise.resolve().then(() => {
      expect(saveGeoref).toHaveBeenCalledTimes(1) // the pair write was DROPPED, not flushed
      expect(vi.mocked(saveGeoref).mock.calls[0][0]).toBe(key)
      expect(vi.mocked(saveGeoref).mock.calls[0][1].pairs).toEqual([])
    })
  })
})

describe('transferring a module alignment', () => {
  beforeEach(() => { resetGeorefMode(); mockGeorefForPlan.mockReset(); vi.mocked(saveGeoref).mockClear() })

  it('copies the source pairs to an independent target document', async () => {
    const source = { pairs: [pair(0.2, 0.3, 7.5, 47.5), pair(0.8, 0.7, 7.502, 47.499)] }
    mockGeorefForPlan.mockImplementation((id) => id === 'object:o1:plan:modul2' ? source : null)

    await expect(transferGeorefPlan('object:o1:plan:modul2', 'object:o1:plan:modul3')).resolves.toBe(true)
    expect(saveGeoref).toHaveBeenCalledWith('object:o1:plan:modul3', { pairs: source.pairs })

    const written = vi.mocked(saveGeoref).mock.calls[0][1].pairs
    expect(written).not.toBe(source.pairs)
    expect(written[0]).not.toBe(source.pairs[0])
    expect(written[0].plan).not.toBe(source.pairs[0].plan)
    expect(written[0].lngLat).not.toBe(source.pairs[0].lngLat)
  })

  it('does not write for a missing source or the same sheet', async () => {
    mockGeorefForPlan.mockReturnValue(null)
    await expect(transferGeorefPlan('source', 'target')).resolves.toBe(false)
    mockGeorefForPlan.mockReturnValue({ pairs: [pair(0.2, 0.3, 7.5, 47.5)] })
    await expect(transferGeorefPlan('same', 'same')).resolves.toBe(false)
    expect(saveGeoref).not.toHaveBeenCalled()
  })
})

// The one rule both surfaces obey: a TAP places a point, everything else pans/zooms as if no
// mode were running. It is a pure gesture fold precisely so the plan's capture layer and the
// map's pointer handlers cannot drift apart — and so «pan and come back» can be tested at all.
describe('tap vs. drag — the same discrimination on both surfaces', () => {
  it('a still press and release is a tap', () => {
    const g = beginTap(100, 100)
    trackTap(g, 101, 102)
    expect(isPlacingTap(g)).toBe(true)
  })

  it('tolerates a shaky finger up to the slop — gloves wobble', () => {
    const g = beginTap(100, 100)
    trackTap(g, 100 + GEOREF_TAP_SLOP_PX - 1, 100)
    expect(isPlacingTap(g)).toBe(true)
  })

  it('past the slop it is a pan, and places nothing', () => {
    const g = beginTap(100, 100)
    trackTap(g, 100 + GEOREF_TAP_SLOP_PX + 1, 100)
    expect(isPlacingTap(g)).toBe(false)
  })

  it('⚠️ a pan that ENDS where it began is still a pan', () => {
    // MapLibre's own click tolerance compares only down and up, so it calls this a click and
    // would drop a reference point in the middle of a three-hundred-pixel pan.
    const g = beginTap(400, 300)
    for (const x of [420, 500, 650, 700, 520, 400]) trackTap(g, x, 300)
    expect(isPlacingTap(g)).toBe(false)
  })

  it('a second finger disqualifies the gesture however still it was', () => {
    const g = beginTap(100, 100)
    trackTap(g, 100, 100, true) // pinch
    expect(isPlacingTap(g)).toBe(false)
  })

  it('places nothing when there was no gesture at all', () => {
    expect(isPlacingTap(null)).toBe(false)
    expect(() => trackTap(null, 1, 1)).not.toThrow()
  })

  it('stays armed across tap after tap — a third point has to be cheap', () => {
    let s = armed()
    for (const [x, y, lng, lat] of [[0.2, 0.2, 7.5, 47.5], [0.8, 0.2, 7.501, 47.5], [0.5, 0.8, 7.5005, 47.4995]] as const) {
      s = georefReduce(s, { type: 'planTap', pt: { x, y } })
      s = georefReduce(s, { type: 'mapTap', lngLat: { lng, lat } })
      expect(s.planId).toBe('modul2')
    }
    expect(s.pairs).toHaveLength(3)
  })
})
