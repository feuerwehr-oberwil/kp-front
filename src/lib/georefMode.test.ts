import { describe, it, expect, vi, beforeEach } from 'vitest'
import { saveGeoref } from './stationPlanScale'
import {
  beginTap,
  GEOREF_OFF,
  georefDispatch,
  georefChip,
  georefLamp,
  georefMatching,
  georefOpenCount,
  georefOpenHint,
  georefPairIndex,
  georefPhoneTargetPoint,
  georefPlacing,
  georefPointNo,
  georefReduce,
  georefSideCount,
  georefSnapshot,
  georefTapOnMarker,
  georefWantsMap,
  georefWarnings,
  GEOREF_TAP_SLOP_PX,
  isPlacingTap,
  placeGeorefPhoneTarget,
  registerGeorefPhoneTarget,
  resetGeorefMode,
  resetGeorefPlan,
  settleSlots,
  trackTap,
  transferGeorefPlan,
  type GeorefModeState,
  type GeorefSlot,
} from './georefMode'
import { fitSimilarity, PAIR_EPS_N, type GeoPt, type Georef, type GeorefPair, type PlanPt } from './georef'

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

// --- synthetic ground truth -----------------------------------------------------------------
// An exact similarity (80 m per aspect-corrected unit, rotated 15°) through the same
// cos(lat)-corrected Web-Mercator the module uses, so `mapOf(p)` is the TRUE map counterpart of
// plan point `p`. That makes the auto-pairing deterministic to test: residuals of correctly
// assigned sets are ~zero, of mis-assigned sets tens of metres.
const R_EARTH = 6378137
const DEG = Math.PI / 180
const K = Math.cos(47.5 * DEG) * R_EARTH
const MERC_X0 = K * 7.5 * DEG
const MERC_Y0 = K * Math.log(Math.tan(Math.PI / 4 + (47.5 * DEG) / 2))
const S = 80, TH = 15 * DEG
const mapOf = (p: PlanPt): GeoPt => {
  const x = p.x * AR, y = -p.y
  const mx = MERC_X0 + S * (Math.cos(TH) * x - Math.sin(TH) * y)
  const my = MERC_Y0 + S * (Math.sin(TH) * x + Math.cos(TH) * y)
  return { lng: mx / K / DEG, lat: (2 * Math.atan(Math.exp(my / K)) - Math.PI / 2) / DEG }
}
const pairAt = (p: PlanPt): GeorefPair => ({ plan: p, lngLat: mapOf(p), kind: 'gesetzt' })

/** Arm the mode on a plan, optionally seeded with pairs the sheet already had. */
const armed = (pairs: GeorefPair[] = []): GeorefModeState =>
  georefReduce(GEOREF_OFF, { type: 'start', planId: 'modul2', pairs, aspect: AR })

const run = (start: GeorefModeState, actions: Parameters<typeof georefReduce>[1][]) =>
  actions.reduce(georefReduce, start)

const pair = (x: number, y: number, lng: number, lat: number): GeorefPair =>
  ({ plan: { x, y }, lngLat: { lng, lat }, kind: 'gesetzt' })

/** the open (single) halves per surface, straight off the slots */
const openPlan = (s: GeorefModeState) => s.slots.filter((sl) => sl.plan && !sl.map).map((sl) => sl.plan!)
const openMap = (s: GeorefModeState) => s.slots.filter((sl) => sl.map && !sl.plan).map((sl) => sl.map!)

// A well-spread, clearly scalene triangle — its correctly assigned fit is exact (≈0 m), so the
// auto-pairing trusts it, and no permutation of it is congruent to itself.
const T1: PlanPt = { x: 0.2, y: 0.2 }
const T2: PlanPt = { x: 0.8, y: 0.25 }
const T3: PlanPt = { x: 0.45, y: 0.8 }
const TRI: GeorefPair[] = [pairAt(T1), pairAt(T2), pairAt(T3)]

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
    expect(openPlan(georefSnapshot())).toEqual([{ x: 0.42, y: 0.31 }])
    unregister()
  })

  it('the explicit action can start on the Karte', () => {
    georefDispatch({ type: 'start', planId: 'modul2', pairs: [], aspect: AR })
    georefDispatch({ type: 'goMap' })
    const unregister = registerGeorefPhoneTarget('map', () => ({ lng: 7.527, lat: 47.516 }))
    expect(placeGeorefPhoneTarget('map')).toBe(true)
    expect(openMap(georefSnapshot())).toEqual([{ lng: 7.527, lat: 47.516 }])
    unregister()
  })

  it('refuses an unavailable or out-of-sheet target without inventing a point', () => {
    georefDispatch({ type: 'start', planId: 'modul2', pairs: [], aspect: AR })
    const unregister = registerGeorefPhoneTarget('plan', () => null)
    expect(placeGeorefPhoneTarget('plan')).toBe(false)
    expect(georefSnapshot().slots).toEqual([])
    unregister()
  })

  it('⚠️ places on the FIRST press even while a popover is open', () => {
    // the tap-beside-dismisses rule must not eat the explicit «Punkt setzen» button
    georefDispatch({ type: 'start', planId: 'modul2', pairs: TRI, aspect: AR })
    georefDispatch({ type: 'select', idx: 0, side: 'plan' })
    expect(georefSnapshot().sel).toEqual({ idx: 0, side: 'plan' })
    const unregister = registerGeorefPhoneTarget('plan', () => ({ x: 0.6, y: 0.6 }))
    expect(placeGeorefPhoneTarget('plan')).toBe(true)
    expect(openPlan(georefSnapshot())).toEqual([{ x: 0.6, y: 0.6 }])
    expect(georefSnapshot().sel).toBeNull()
    unregister()
  })
})

describe('georefReduce · placing points as numbered slots', () => {
  it('arms on a plan and asks for the plan first', () => {
    const s = armed()
    expect(s.planId).toBe('modul2')
    expect(s.want).toBe('plan')
    expect(georefPlacing(s)).toBe(false)
    expect(georefPointNo(s)).toBe(1)
  })

  it('a plan tap opens a half — and does NOT drag the operator to the map', () => {
    const s = georefReduce(armed(), { type: 'planTap', pt: { x: 0.2, y: 0.3 } })
    // ⚠️ nothing goes inert: crosses on both surfaces stay live through open halves
    expect(georefPlacing(s)).toBe(false)
    expect(georefMatching(s)).toBe(false)
    expect(openPlan(s)).toEqual([{ x: 0.2, y: 0.3 }])
    // ⚠️ free order: the sheet stays in front of you until you say otherwise
    expect(s.want).toBe('plan')
    expect(s.pairs).toHaveLength(0) // an open half is not a pair
    expect(georefWantsMap(s)).toBe(true) // …the map will take its counterpart when you get there
  })

  it('tapping the plan again opens a SECOND slot instead of moving the first', () => {
    let s = georefReduce(armed(), { type: 'planTap', pt: { x: 0.2, y: 0.3 } })
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.4, y: 0.5 } })
    expect(openPlan(s)).toEqual([{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.5 }])
    expect(s.pairs).toHaveLength(0)
    expect(georefPointNo(s)).toBe(3) // on the plan: the number a further tap would open
  })

  it('may start on the map and gives that half slot 1', () => {
    const s = georefReduce(armed(), { type: 'mapTap', lngLat: { lng: 7.5, lat: 47.5 } })
    expect(openMap(s)).toEqual([{ lng: 7.5, lat: 47.5 }])
    expect(s.pairs).toHaveLength(0)
    expect(s.want).toBe('map')
    expect(georefPointNo(s)).toBe(2)
  })

  it('matches map-first points from the plan in the same numbered order', () => {
    let s = armed()
    s = georefReduce(s, { type: 'goMap' })
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.5, lat: 47.5 } })
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.6, lat: 47.6 } })
    expect(openMap(s)).toHaveLength(2)
    s = georefReduce(s, { type: 'goPlan' })
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.2, y: 0.3 } })
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.4, y: 0.5 } })
    expect(s.pairs).toEqual([
      pair(0.2, 0.3, 7.5, 47.5),
      pair(0.4, 0.5, 7.6, 47.6),
    ])
    expect(openMap(s)).toEqual([])
  })

  it('the map tap completes the pair and stays on the map for its next point', () => {
    let s = georefReduce(armed(), { type: 'planTap', pt: { x: 0.2, y: 0.3 } })
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.5, lat: 47.5 } })
    expect(s.pairs).toEqual([{ plan: { x: 0.2, y: 0.3 }, lngLat: { lng: 7.5, lat: 47.5 }, kind: 'gesetzt' }])
    expect(s.slots).toHaveLength(1)
    expect(s.want).toBe('map')
    // ⚠️ still armed: the third point is what earns a residual, so it has to be cheap
    expect(s.planId).toBe('modul2')
    expect(georefPointNo(s)).toBe(2)
  })

  it('under three pairs the map matches the OLDEST open half — capture order is the pairing', () => {
    let s = armed()
    for (const p of [T1, T2, T3]) s = georefReduce(s, { type: 'planTap', pt: p })
    expect(openPlan(s)).toHaveLength(3)
    s = georefReduce(s, { type: 'goMap' })
    expect(s.want).toBe('map')
    expect(georefPointNo(s)).toBe(1) // over there the number is the OLDEST open point
    s = georefReduce(s, { type: 'mapTap', lngLat: mapOf(T1) })
    expect(s.pairs[0].plan).toEqual(T1)
    expect(s.want).toBe('map') // two still open — no hop back mid-queue
    s = georefReduce(s, { type: 'mapTap', lngLat: mapOf(T2) })
    expect(s.pairs[1].plan).toEqual(T2)
    s = georefReduce(s, { type: 'mapTap', lngLat: mapOf(T3) })
    expect(s.pairs.map((p) => p.plan)).toEqual([T1, T2, T3])
    expect(georefOpenCount(s)).toBe(0)
    expect(s.want).toBe('map') // …and remains where the operator deliberately went
  })

  it('keeps existing map crosses draggable while unmatched plan points wait', () => {
    let s = armed([pair(0.2, 0.3, 7.5, 47.5)])
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.7, y: 0.8 } })
    expect(openPlan(s)).toHaveLength(1)
    expect(georefMatching(s)).toBe(false)
    const moved = georefReduce(s, { type: 'dragMap', idx: 0, lngLat: { lng: 7.51, lat: 47.51 } })
    expect(moved.pairs[0].lngLat).toEqual({ lng: 7.51, lat: 47.51 })
    expect(openPlan(moved)).toEqual(openPlan(s))
  })

  it('may switch to the map before either half has been set', () => {
    const s = georefReduce(armed(), { type: 'goMap' })
    expect(s.want).toBe('map')
  })

  it('re-pairing the SAME plan point replaces it instead of appending a contradiction', () => {
    let s = armed([pair(0.2, 0.3, 7.5, 47.5)])
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.2, y: 0.3 } })
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.6, lat: 47.6 } })
    expect(s.pairs).toHaveLength(1)
    expect(s.pairs[0].lngLat).toEqual({ lng: 7.6, lat: 47.6 })
  })

  it('⚠️ …and the same holds MAP FIRST — the mirror branch must not append either', () => {
    // map half placed, then the operator recognises a corner on the sheet that ALREADY carries a
    // pair. Two pairs on one plan point holding different positions is the self-contradiction
    // the one-landmark rule exists to make impossible: it drags the fit toward the worse tap.
    let s = armed([pair(0.2, 0.3, 7.5, 47.5)])
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.6, lat: 47.6 } })
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.2, y: 0.3 } })
    expect(s.pairs).toHaveLength(1)
    expect(s.pairs[0].lngLat).toEqual({ lng: 7.6, lat: 47.6 })
    expect(openMap(s)).toEqual([])
  })
})

// ⚠️ THE decided model (29.08.): «just allow setting somewhat random points on both places and
// when they match we're good.» Under a credible fit a new half only pairs with the open half it
// actually lands on — capture order stops being the pairing the moment the geometry can speak.
describe('georefReduce · free order and auto-pairing', () => {
  it('reaches the identical fit whichever surface went first', () => {
    const planFirst = run(armed(), [
      { type: 'planTap', pt: { x: 0.2, y: 0.2 } }, { type: 'mapTap', lngLat: { lng: 7.5, lat: 47.5 } },
      { type: 'planTap', pt: { x: 0.8, y: 0.8 } }, { type: 'mapTap', lngLat: { lng: 7.5015, lat: 47.4991 } },
    ])
    const mapFirst = run(armed(), [
      { type: 'goMap' },
      { type: 'mapTap', lngLat: { lng: 7.5, lat: 47.5 } }, { type: 'planTap', pt: { x: 0.2, y: 0.2 } },
      { type: 'goMap' },
      { type: 'mapTap', lngLat: { lng: 7.5015, lat: 47.4991 } }, { type: 'planTap', pt: { x: 0.8, y: 0.8 } },
    ])
    expect(mapFirst.pairs).toEqual(planFirst.pairs)
  })

  it('⚠️ BOTH surfaces may hold open halves at once — unrelated halves are not welded together', () => {
    let s = armed(TRI) // a measured, trustworthy fit stands
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.3, y: 0.6 } })
    // a map tap ~75 m away from that plan half's true position: NOT the same landmark
    s = georefReduce(s, { type: 'mapTap', lngLat: mapOf({ x: 0.9, y: 0.9 }) })
    expect(openPlan(s)).toHaveLength(1)
    expect(openMap(s)).toHaveLength(1) // the old FIFO would have paired these two blindly
    expect(s.pairs).toHaveLength(3)
    expect(georefOpenCount(s)).toBe(2)
  })

  it('…and a half pairs with the open half it LANDS ON, not with the oldest', () => {
    let s = armed(TRI)
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.3, y: 0.6 } })          // slot 4, open
    s = georefReduce(s, { type: 'mapTap', lngLat: mapOf({ x: 0.9, y: 0.9 }) }) // slot 5, open
    // the sheet tap at (0.9, 0.9) coincides with slot 5's map half under the fit — it completes
    // slot 5 and leaves the OLDER open plan half alone
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.9, y: 0.9 } })
    expect(s.pairs).toHaveLength(4)
    expect(openPlan(s)).toEqual([{ x: 0.3, y: 0.6 }])
    expect(openMap(s)).toEqual([])
    // …and its counterpart on the map closes the last open half
    s = georefReduce(s, { type: 'mapTap', lngLat: mapOf({ x: 0.3, y: 0.6 }) })
    expect(s.pairs).toHaveLength(5)
    expect(georefOpenCount(s)).toBe(0)
    expect(fitSimilarity(s.pairs, AR)!.meanResidualM).toBeLessThan(0.5)
  })

  it('a clearly mis-ordered set re-deals itself once the geometry leaves no doubt', () => {
    // an irregular quadrilateral, so no permutation of it is congruent to itself
    const Q: PlanPt[] = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.15 }, { x: 0.75, y: 0.85 }, { x: 0.25, y: 0.7 }]
    let s = armed()
    for (const p of Q) s = georefReduce(s, { type: 'planTap', pt: p })
    // the map side is walked in a DIFFERENT order: 2, 3, 4, 1
    for (const i of [1, 2, 3, 0]) s = georefReduce(s, { type: 'mapTap', lngLat: mapOf(Q[i]) })
    expect(s.pairs).toHaveLength(4)
    // the re-matcher has re-dealt the map halves so every plan point carries its own position
    const fit = fitSimilarity(s.pairs, AR)!
    expect(fit.meanResidualM).toBeLessThan(0.5)
    s.pairs.forEach((p, i) => expect(p.plan).toEqual(Q[i]))
  })

  it('tapping two open halves in sequence pairs them BY HAND, marked fixed', () => {
    let s = armed(TRI)
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.3, y: 0.6 } })
    s = georefReduce(s, { type: 'mapTap', lngLat: mapOf({ x: 0.9, y: 0.9 }) })
    expect(georefOpenCount(s)).toBe(2)
    s = georefReduce(s, { type: 'select', idx: 3, side: 'plan' })
    expect(s.sel).toEqual({ idx: 3, side: 'plan' })
    s = georefReduce(s, { type: 'select', idx: 4, side: 'map' })
    expect(s.sel).toBeNull()
    expect(georefOpenCount(s)).toBe(0)
    expect(s.slots[3]).toMatchObject({ plan: { x: 0.3, y: 0.6 }, map: mapOf({ x: 0.9, y: 0.9 }), fixed: true })
    expect(s.pairs).toHaveLength(4)
  })

  it('⚠️ a hand-made pair survives the automatic re-deal', () => {
    const Q: PlanPt[] = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.15 }, { x: 0.75, y: 0.85 }, { x: 0.25, y: 0.7 }]
    // slot 0 was paired BY HAND (deliberately "wrong" by the geometry's lights); 1–3 are
    // mis-dealt among themselves. The re-deal must fix the free three and leave 0 alone.
    const wrongMap = mapOf({ x: 0.5, y: 0.5 })
    const slots: GeorefSlot[] = [
      { plan: Q[0], map: wrongMap, kind: 'gesetzt', fixed: true },
      { plan: Q[1], map: mapOf(Q[2]), kind: 'gesetzt' },
      { plan: Q[2], map: mapOf(Q[3]), kind: 'gesetzt' },
      { plan: Q[3], map: mapOf(Q[1]), kind: 'gesetzt' },
    ]
    const out = settleSlots(slots, AR)
    expect(out[0].map).toBe(wrongMap) // the operator's explicit decision stands
    expect(out[1].map).toEqual(mapOf(Q[1]))
    expect(out[2].map).toEqual(mapOf(Q[2]))
    expect(out[3].map).toEqual(mapOf(Q[3]))
  })

  it('counts each surface independently and never navigates away after a match', () => {
    let s = run(armed(), [
      { type: 'goMap' },
      { type: 'mapTap', lngLat: { lng: 7.5, lat: 47.5 } },
      { type: 'mapTap', lngLat: { lng: 7.6, lat: 47.6 } },
    ])
    expect(georefSideCount(s, 'map')).toBe(2)
    expect(georefSideCount(s, 'plan')).toBe(0)

    s = georefReduce(s, { type: 'goPlan' })
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.2, y: 0.2 } })
    expect(s.want).toBe('plan')
    expect(georefSideCount(s, 'map')).toBe(2)
    expect(georefSideCount(s, 'plan')).toBe(1)

    s = georefReduce(s, { type: 'goMap' })
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.7, lat: 47.7 } })
    expect(s.want).toBe('map')
    expect(georefSideCount(s, 'map')).toBe(3)
    expect(georefSideCount(s, 'plan')).toBe(1)
  })
})

describe('georefReduce · selection, popover and Verschieben', () => {
  const seeded = () => armed([pair(0.2, 0.3, 7.5, 47.5), pair(0.8, 0.7, 7.502, 47.499)])

  it('tapping a cross selects it — nothing goes inert, the same tap again puts it away', () => {
    let s = georefReduce(seeded(), { type: 'select', idx: 0, side: 'plan' })
    expect(s.sel).toEqual({ idx: 0, side: 'plan' })
    expect(s.want).toBe('plan')
    expect(georefPlacing(s)).toBe(false)
    expect(georefMatching(s)).toBe(false)
    expect(georefPointNo(s)).toBe(1)
    s = georefReduce(s, { type: 'select', idx: 0, side: 'plan' })
    expect(s.sel).toBeNull()
  })

  it('a tap BESIDE the open popover deselects and places nothing', () => {
    let s = georefReduce(seeded(), { type: 'select', idx: 0, side: 'plan' })
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.5, y: 0.5 } })
    expect(s.sel).toBeNull()
    expect(s.slots).toHaveLength(2) // the dismissal tap did not become a point
    // …while a tap on the OTHER surface is an ordinary placement (and clears the popover)
    let m = georefReduce(seeded(), { type: 'select', idx: 0, side: 'plan' })
    m = georefReduce(m, { type: 'mapTap', lngLat: { lng: 7.6, lat: 47.6 } })
    expect(m.sel).toBeNull()
    expect(openMap(m)).toHaveLength(1)
  })

  it('«Verschieben» arms the re-place; the next tap on that surface moves ONLY that half', () => {
    let s = georefReduce(seeded(), { type: 'select', idx: 0, side: 'plan' })
    s = georefReduce(s, { type: 'beginMove' })
    expect(s.move).toEqual({ idx: 0, side: 'plan' })
    expect(s.sel).toBeNull()
    expect(georefPlacing(s)).toBe(true) // plan crosses inert while the landing tap is owed
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.25, y: 0.35 } })
    expect(s.pairs).toHaveLength(2)
    expect(s.pairs[0]).toEqual({ plan: { x: 0.25, y: 0.35 }, lngLat: { lng: 7.5, lat: 47.5 }, kind: 'korrigiert' })
    expect(s.move).toBeNull()
    expect(georefOpenCount(s)).toBe(0) // a correction is not a new point
  })

  it('an armed MAP move keeps the map crosses inert and corrects there', () => {
    let s = georefReduce(seeded(), { type: 'select', idx: 1, side: 'map' })
    s = georefReduce(s, { type: 'beginMove' })
    expect(s.want).toBe('map')
    expect(georefMatching(s)).toBe(true)
    expect(georefWantsMap(s)).toBe(true)
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.51, lat: 47.4 } })
    expect(s.pairs[1]).toEqual({ plan: { x: 0.8, y: 0.7 }, lngLat: { lng: 7.51, lat: 47.4 }, kind: 'korrigiert' })
    expect(s.move).toBeNull()
  })

  it('⚠️ a move never strands the operator: the other surface stays fully live', () => {
    let s = georefReduce(seeded(), { type: 'select', idx: 0, side: 'plan' })
    s = georefReduce(s, { type: 'beginMove' })
    // the hop is never refused — that refusal is what pinned phones under the old pick state
    const hopped = georefReduce(s, { type: 'goMap' })
    expect(hopped.want).toBe('map')
    expect(hopped.move).toEqual({ idx: 0, side: 'plan' })
    // and a map tap while a PLAN move is armed is an ordinary placement, not swallowed
    const placed = georefReduce(hopped, { type: 'mapTap', lngLat: { lng: 7.6, lat: 47.6 } })
    expect(openMap(placed)).toHaveLength(1)
    expect(placed.move).toEqual({ idx: 0, side: 'plan' })
  })

  it('«Behalten» / Esc peels one layer at a time: move first, then the popover', () => {
    let s = georefReduce(seeded(), { type: 'select', idx: 0, side: 'plan' })
    s = georefReduce(s, { type: 'beginMove' })
    const back = georefReduce(s, { type: 'unpick' })
    expect(back.move).toBeNull()
    expect(back.pairs).toBe(s.pairs) // not moved
    expect(back.want).toBe(s.want)   // and the operator is not yanked anywhere
    const selOnly = georefReduce(seeded(), { type: 'select', idx: 1, side: 'map' })
    expect(georefReduce(selOnly, { type: 'unpick' }).sel).toBeNull()
    // putting down what was never picked up is a no-op
    expect(georefReduce(seeded(), { type: 'unpick' })).toEqual(seeded())
    expect(georefReduce(GEOREF_OFF, { type: 'unpick' })).toBe(GEOREF_OFF)
  })

  it('an open half can be selected, moved and deleted like any other point', () => {
    let s = georefReduce(seeded(), { type: 'planTap', pt: { x: 0.5, y: 0.5 } })
    s = georefReduce(s, { type: 'select', idx: 2, side: 'plan' })
    s = georefReduce(s, { type: 'beginMove' })
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.55, y: 0.45 } })
    expect(openPlan(s)).toEqual([{ x: 0.55, y: 0.45 }])
    expect(s.slots[2].kind).toBe('gesetzt') // moving a half that is not yet a pair corrects nothing
    s = georefReduce(s, { type: 'remove', idx: 2 })
    expect(georefOpenCount(s)).toBe(0)
    expect(s.pairs).toHaveLength(2)
  })

  it('«Punkt löschen» drops that whole slot and refits from the rest', () => {
    let s = georefReduce(seeded(), { type: 'select', idx: 0, side: 'plan' })
    s = georefReduce(s, { type: 'remove', idx: 0 })
    expect(s.pairs).toHaveLength(1)
    expect(s.pairs[0].plan).toEqual({ x: 0.8, y: 0.7 })
    expect(s.sel).toBeNull()
    // one pair left ⇒ no fit at all, and the surfaces say so rather than pretending
    expect(fitSimilarity(s.pairs, AR)).toBeNull()
    // deleting one that isn't there changes nothing
    expect(georefReduce(s, { type: 'remove', idx: 4 })).toBe(s)
  })

  it('selecting a cross that does not exist changes nothing', () => {
    const s = seeded()
    expect(georefReduce(s, { type: 'select', idx: 7, side: 'plan' })).toBe(s)
    // …nor selecting the EMPTY half of a slot
    const withOpen = georefReduce(s, { type: 'planTap', pt: { x: 0.5, y: 0.5 } })
    expect(georefReduce(withOpen, { type: 'select', idx: 2, side: 'map' })).toBe(withOpen)
  })

  it('dragging a cross patches that slot live and marks the pair corrected', () => {
    const plan = georefReduce(seeded(), { type: 'dragPlan', idx: 0, pt: { x: 0.21, y: 0.31 } })
    expect(plan.pairs[0]).toEqual({ plan: { x: 0.21, y: 0.31 }, lngLat: { lng: 7.5, lat: 47.5 }, kind: 'korrigiert' })
    const map = georefReduce(seeded(), { type: 'dragMap', idx: 1, lngLat: { lng: 7.503, lat: 47.4985 } })
    expect(map.pairs[1].plan).toEqual({ x: 0.8, y: 0.7 })
    expect(map.pairs[1].kind).toBe('korrigiert')
  })

  it('⚠️ an OPEN half is draggable too — the amber cross is a point, not a ghost', () => {
    let s = georefReduce(seeded(), { type: 'planTap', pt: { x: 0.5, y: 0.5 } })
    s = georefReduce(s, { type: 'dragPlan', idx: 2, pt: { x: 0.52, y: 0.55 } })
    expect(openPlan(s)).toEqual([{ x: 0.52, y: 0.55 }])
    expect(s.pairs).toHaveLength(2) // nothing was welded together by the drag
    s = georefReduce(s, { type: 'mapTap', lngLat: { lng: 7.6, lat: 47.6 } })
    s = georefReduce(s, { type: 'dragMap', idx: 2, lngLat: { lng: 7.61, lat: 47.61 } })
    expect(s.pairs[2].lngLat).toEqual({ lng: 7.61, lat: 47.61 })
  })

  it('⚠️ but never ONTO another cross — coincident references leave the sheet with no fit', () => {
    const s = seeded()
    const onto = { x: 0.8 + PAIR_EPS_N / 2, y: 0.7 } // within a fingertip of pair 1
    expect(georefReduce(s, { type: 'dragPlan', idx: 0, pt: onto })).toBe(s)
    // a hair further out it is a landmark of its own again, and the drag goes through
    const clear = georefReduce(s, { type: 'dragPlan', idx: 0, pt: { x: 0.8 + PAIR_EPS_N * 3, y: 0.7 } })
    expect(clear.pairs[0].plan).toEqual({ x: 0.8 + PAIR_EPS_N * 3, y: 0.7 })
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
    expect(openPlan(placed)).toEqual([{ x: 0.5, y: 0.5 }]) // …and the tap itself still counted
  })

  it('Deckung prüfen may switch to the map without an open point', () => {
    let s = georefReduce(armed(TWO), { type: 'check', on: true })
    s = georefReduce(s, { type: 'goMap' })
    expect(s.want).toBe('map')
    expect(s.check).toBe(true)
    expect(georefWantsMap(s)).toBe(false)
  })

  it('leaves Deckung prüfen on the side it opened from without ending alignment', () => {
    let before = georefReduce(armed(TWO), { type: 'select', idx: 0, side: 'map' })
    before = georefReduce(before, { type: 'unpick' })
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
    expect(georefOpenCount(returning)).toBe(0)
    expect(georefReduce(returning, { type: 'dismiss' })).toBe(GEOREF_OFF)
  })

  it('«Fertig» / Esc drops the mode and every half still waiting for its counterpart', () => {
    let s = georefReduce(armed([pair(0.2, 0.3, 7.5, 47.5)]), { type: 'planTap', pt: { x: 0.7, y: 0.8 } })
    expect(openPlan(s)).toHaveLength(1)
    s = georefReduce(s, { type: 'end' })
    expect(s).toBe(GEOREF_OFF)
  })

  it('«Punkte zurücksetzen» clears pairs AND open halves, and stays armed', () => {
    let s = georefReduce(armed([pair(0.2, 0.3, 7.5, 47.5)]), { type: 'planTap', pt: { x: 0.7, y: 0.8 } })
    s = georefReduce(s, { type: 'clear' })
    expect(s.slots).toEqual([])
    expect(s.pairs).toEqual([])
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
  // bar, and what to DO about the points takes its place (the 29.08. instruction rewrite)
  it('stays amber on a collinear fit, and instructs instead of boasting the number', () => {
    const line = [pair(0.2, 0.2, 7.5, 47.5), pair(0.5, 0.5, 7.5008, 47.4995), pair(0.8, 0.8, 7.5015, 47.4991)]
    const lamp = georefLamp(fitSimilarity(line, AR), armed(line))
    expect(lamp.tone).toBe('amber')
    expect(lamp.body).toContain('abseits der Linie setzen')
  })

  it('a short baseline reads as an instruction, not a scolding', () => {
    const tight = [pair(0.2, 0.2, 7.5, 47.5), pair(0.24, 0.22, 7.50004, 47.49997), pair(0.21, 0.24, 7.50002, 47.49999)]
    const lamp = georefLamp(fitSimilarity(tight, AR), armed(tight))
    expect(lamp.tone).toBe('amber')
    expect(lamp.body).toMatch(/^Den nächsten Punkt weiter weg setzen/)
  })

  it('counts the halves that are still waiting', () => {
    const withOpen = georefReduce(armed(THREE), { type: 'planTap', pt: { x: 0.1, y: 0.1 } })
    expect(georefLamp(fitSimilarity(THREE, AR), withOpen).head).toContain('1 offen')
  })
})

describe('georefOpenHint — the status line names the missing half', () => {
  it('says nothing while every point is complete', () => {
    expect(georefOpenHint(armed(TRI))).toBeNull()
  })

  it('names the ONE open half and the surface it is missing on', () => {
    const planOnly = georefReduce(armed(TRI), { type: 'planTap', pt: { x: 0.3, y: 0.6 } })
    expect(georefOpenHint(planOnly)).toBe('Punkt 4 fehlt noch auf der Karte.')
    const mapOnly = georefReduce(armed(TRI), { type: 'mapTap', lngLat: mapOf({ x: 0.9, y: 0.9 }) })
    expect(georefOpenHint(mapOnly)).toBe('Punkt 4 fehlt noch auf dem Modul.')
  })

  it('counts several open halves on one surface', () => {
    let s = georefReduce(armed(), { type: 'planTap', pt: { x: 0.2, y: 0.2 } })
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.6, y: 0.6 } })
    expect(georefOpenHint(s)).toBe('2 Punkte fehlen noch auf der Karte.')
  })

  it('says so when both surfaces hold open halves', () => {
    let s = georefReduce(armed(TRI), { type: 'planTap', pt: { x: 0.3, y: 0.6 } })
    s = georefReduce(s, { type: 'mapTap', lngLat: mapOf({ x: 0.9, y: 0.9 }) })
    expect(georefOpenHint(s)).toContain('Karte und Modul')
  })

  it('a selection wins the line — the popover needs its context sentence', () => {
    const s = georefReduce(armed(TRI), { type: 'select', idx: 1, side: 'plan' })
    expect(georefOpenHint(s)).toBe('Punkt 2 ausgewählt – daneben tippen wählt ab.')
  })
})

describe('georefPairIndex — a slot finds its residual', () => {
  it('maps slot indices onto the derived pair list, skipping open halves', () => {
    let s = georefReduce(armed(TRI), { type: 'planTap', pt: { x: 0.3, y: 0.6 } })
    s = georefReduce(s, { type: 'mapTap', lngLat: mapOf({ x: 0.9, y: 0.9 }) })
    s = georefReduce(s, { type: 'planTap', pt: { x: 0.9, y: 0.9 } }) // completes the map orphan
    expect(georefPairIndex(s, 0)).toBe(0)
    expect(georefPairIndex(s, 3)).toBeNull() // the open plan half claims no residual
    expect(georefPairIndex(s, 4)).toBe(3)
  })
})

describe('the store persists exactly the edits — and nothing else', () => {
  beforeEach(() => { resetGeorefMode(); mockGeorefForPlan.mockReset(); mockGeorefForPlan.mockReturnValue(null); vi.mocked(saveGeoref).mockClear() })

  it('arming a plan writes nothing', () => {
    georefDispatch({ type: 'start', planId: 'modul2', pairs: [], aspect: AR })
    georefDispatch({ type: 'planTap', pt: { x: 0.2, y: 0.2 } })
    expect(saveGeoref).not.toHaveBeenCalled() // an open half is not a georeference
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

  it('dragging an OPEN half writes nothing — half a pair still never persists', () => {
    georefDispatch({ type: 'start', planId: 'modul2', pairs: [], aspect: AR })
    georefDispatch({ type: 'planTap', pt: { x: 0.2, y: 0.2 } })
    georefDispatch({ type: 'dragPlan', idx: 0, pt: { x: 0.3, y: 0.3 } })
    georefDispatch({ type: 'end' })
    expect(saveGeoref).not.toHaveBeenCalled()
  })

  it('pairing two halves BY HAND persists like any completed pair', () => {
    georefDispatch({ type: 'start', planId: 'modul2', pairs: TRI, aspect: AR })
    georefDispatch({ type: 'planTap', pt: { x: 0.3, y: 0.6 } })
    georefDispatch({ type: 'mapTap', lngLat: mapOf({ x: 0.9, y: 0.9 }) })
    vi.mocked(saveGeoref).mockClear()
    georefDispatch({ type: 'select', idx: 3, side: 'plan' })
    georefDispatch({ type: 'select', idx: 4, side: 'map' })
    georefDispatch({ type: 'end' })
    expect(saveGeoref).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveGeoref).mock.calls[0][1].pairs).toHaveLength(4)
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
    for (const p of [T1, T2, T3]) {
      s = georefReduce(s, { type: 'planTap', pt: p })
      s = georefReduce(s, { type: 'mapTap', lngLat: mapOf(p) })
      expect(s.planId).toBe('modul2')
    }
    expect(s.pairs).toHaveLength(3)
  })
})

// A gesture that begins on a cross belongs to the cross (select / drag) — MapLibre listens
// natively on the canvas container, so the map sees the cross's events too and has to filter
// them itself (MapView · onMouseDown/onTouchStart).
describe('georefTapOnMarker — a cross owns its own gesture', () => {
  // minimal stand-ins: only `closest` is consulted, and the pure tests run without a DOM
  const inMarker = { closest: (sel: string) => (sel === '.maplibregl-marker' ? inMarker : null) } as unknown as EventTarget
  const onCanvas = { closest: () => null } as unknown as EventTarget

  it('a press inside a marker never starts a placement gesture', () => {
    expect(georefTapOnMarker(inMarker)).toBe(true)
  })

  it('a press on the bare canvas does', () => {
    expect(georefTapOnMarker(onCanvas)).toBe(false)
  })

  it('tolerates targets that are no elements at all', () => {
    expect(georefTapOnMarker(null)).toBe(false)
    expect(georefTapOnMarker(undefined)).toBe(false)
    expect(georefTapOnMarker({} as EventTarget)).toBe(false)
  })
})
