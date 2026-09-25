// @vitest-environment jsdom
/**
 * The live-GPS coupling's way back to the Einsatzort (D3, after the Übung on 23.09.2026: «Weiter
 * folgen» at 22:31 for a TLF back at the Magazin since 22:14 drew a 1.15 km depot → site → depot
 * spike into the saved hose line, and nothing remembered the on-site state).
 */
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  AWAY_AGAIN_M, BACK_ON_SITE_M, backKey, fmtAway, gpsLineName, gpsNotices, onSiteAnchor, onSiteCoords,
  rearmed, revertCoords, routingPatch, useBackOffers,
} from './gpsReturn'
import { followLiveVehicles } from './useGpsFollow'
import { haversineM } from './geo'
import type { Drawing, Entity, GpsFollowState, LngLat } from '../types'

const SITE: LngLat = [8.0, 47.0] // a neutral point — no station's real place
/** ~1.1 km north-east — the Magazin */
const DEPOT: LngLat = [8.01, 47.007]
const HYDRANT: LngLat = [SITE[0] - 0.0007, SITE[1] - 0.0004]
const AT = '2026-09-23T20:31:00.000Z'
const tlf = (coord: LngLat): Entity => ({ id: 'gps-3', kind: 'symbol', layer: 'fahrzeuge', coord, live: true, label: 'TLF' } as Entity)
const hose = (state: GpsFollowState, over: Partial<Drawing> = {}): Drawing => ({
  id: 'hose', kind: 'line', lineNo: 1, coords: [HYDRANT, [SITE[0] - 0.0003, SITE[1] - 0.0002], SITE],
  endAttachment: { target: { kind: 'object', id: 'gps-3', live: true }, routing: 'direct', gps: { state, confirmedAt: SITE, lastSafe: SITE } },
  ...over,
})
const doc = (d: Drawing) => ({ entities: [], drawings: [d] })
/** «Weiter folgen» as the workspace does it: routing patch onto the drawing */
const follow = (d: Drawing, at = AT): Drawing => ({ ...d, ...routingPatch(d, 'end', 'trace', { resolvedEnd: d.coords[d.coords.length - 1], at })! })
/** drive the vehicle along `path`, one follower pass per sample */
const drive = (d: Drawing, path: LngLat[]): Drawing => path.reduce((cur, p) => followLiveVehicles(doc(cur), [tlf(p)]).drawings[0], d)
const route = (from: LngLat, to: LngLat, n: number): LngLat[] =>
  Array.from({ length: n }, (_, i) => [from[0] + ((to[0] - from[0]) * (i + 1)) / n, from[1] + ((to[1] - from[1]) * (i + 1)) / n + (i % 2 ? 0.00005 : 0)])
/** how far the line reaches from the Einsatzort — the spike, in metres */
const reach = (coords: LngLat[]) => Math.max(...coords.map((p) => haversineM(SITE, p)))

describe('routingPatch · «Weiter folgen» photographs the on-site line ONCE', () => {
  it('a paused end starts following and keeps the line as it stood, with the tap time', () => {
    const d = hose('paused')
    const next = follow(d)
    const gps = next.endAttachment!.gps!
    expect(gps.state).toBe('continuous')
    expect(next.endAttachment!.routing).toBe('trace')
    expect(gps.before).toEqual({ coords: d.coords, routing: 'direct', state: 'paused', confirmedAt: SITE, lastSafe: SITE, at: AT })
  })

  it('a second «Weiter folgen» after «Folgen stoppen» keeps the FIRST snapshot — the drive is never the on-site state', () => {
    const driven = drive(follow(hose('paused')), route(SITE, DEPOT, 12))
    const stopped = { ...driven, ...routingPatch(driven, 'end', 'direct', { resolvedEnd: DEPOT, at: '2026-09-23T20:50:00.000Z' })! }
    expect(stopped.endAttachment!.gps!.state).toBe('paused')
    const again = follow(stopped, '2026-09-23T20:55:00.000Z')
    expect(again.endAttachment!.gps!.before!.at).toBe(AT)
    expect(again.endAttachment!.gps!.before!.coords).toEqual(hose('paused').coords)
  })

  it('«Spur» out of a guarded end snapshots too — it starts the same following', () => {
    const next = { ...hose('guarded'), ...routingPatch(hose('guarded'), 'end', 'trace', { resolvedEnd: SITE, at: AT })! }
    expect(next.endAttachment!.gps!.before?.state).toBe('guarded')
  })

  it('a fresh confirmation («Direkt» out of a pause) is the on-site state — the snapshot goes', () => {
    const stopped = { ...follow(hose('paused')), ...routingPatch(follow(hose('paused')), 'end', 'direct', { resolvedEnd: SITE, at: AT })! }
    const confirmed = routingPatch(stopped, 'end', 'direct', { resolvedEnd: SITE, targetCoord: DEPOT, at: AT })!.endAttachment!
    expect(confirmed.gps!.state).toBe('guarded')
    expect(confirmed.gps!.before).toBeUndefined()
    expect(confirmed.gps!.confirmedAt).toEqual(DEPOT)
  })

  it('an end without GPS only changes its routing, and a free end has nothing to patch', () => {
    const plain: Drawing = { ...hose('guarded'), endAttachment: { target: { kind: 'object', id: 'hyd' }, routing: 'direct' } }
    expect(routingPatch(plain, 'end', 'trace', { resolvedEnd: SITE, at: AT })).toEqual({ endAttachment: { target: { kind: 'object', id: 'hyd' }, routing: 'trace' } })
    expect(routingPatch(plain, 'start', 'trace', { resolvedEnd: SITE, at: AT })).toBeNull()
  })
})

describe('the snapshot travels with the line', () => {
  it('every follower sample keeps it by identity — the pass spreads gps, never rebuilds it', () => {
    const followed = follow(hose('paused'))
    const before = followed.endAttachment!.gps!.before
    const driven = drive(followed, route(SITE, DEPOT, 30))
    expect(driven.endAttachment!.gps!.before).toBe(before)
    expect(reach(driven.coords)).toBeGreaterThan(1000) // the drive IS in the line — that is the spike
  })

  it('an older client that knows no `before` carries it along untouched (it spreads gps)', () => {
    const followed = follow(hose('paused'))
    const a = followed.endAttachment!
    // the pre-change setGpsRouting, verbatim in shape: { ...attachment, routing, gps: { ...gps, state } }
    const legacy = { ...a, routing: 'direct' as const, gps: { ...a.gps!, state: 'paused' as const } }
    expect(legacy.gps.before).toBe(a.gps!.before)
  })
})

describe('onSiteCoords · letting go happens at the Einsatzort', () => {
  it('the 22:31 case: followed to the Magazin, «Am Einsatzort lösen» cuts the drive off', () => {
    const d = hose('paused')
    const driven = drive(follow(d), [...route(SITE, DEPOT, 20), ...route(DEPOT, SITE, 20), ...route(SITE, DEPOT, 20)])
    const coords = onSiteCoords(driven, 'end', driven.coords[driven.coords.length - 1])
    expect(coords).toEqual(d.coords)
    expect(reach(coords)).toBeLessThan(100)
  })

  it('keeps a hand edit made to the rest of the line meanwhile (the difference to «Zurück»)', () => {
    const driven = drive(follow(hose('paused')), route(SITE, DEPOT, 10))
    const moved: LngLat = [HYDRANT[0] - 0.0001, HYDRANT[1]]
    const edited = { ...driven, coords: [moved, ...driven.coords.slice(1)] }
    const coords = onSiteCoords(edited, 'end', DEPOT)
    expect(coords[0]).toEqual(moved)
    expect(coords[coords.length - 1]).toEqual(SITE)
    expect(revertCoords(edited, 'end')![0]).toEqual(HYDRANT) // «Zurück» restores the snapshot exactly
  })

  it('a START end is cut back the same way (the trace prepends there)', () => {
    const d: Drawing = { id: 's', kind: 'line', coords: [SITE, [SITE[0] - 0.0003, SITE[1]], HYDRANT],
      startAttachment: { target: { kind: 'object', id: 'gps-3', live: true }, routing: 'direct', gps: { state: 'paused', confirmedAt: SITE, lastSafe: SITE } } }
    const followed = { ...d, ...routingPatch(d, 'start', 'trace', { resolvedEnd: SITE, at: AT })! }
    const driven = route(SITE, DEPOT, 15).reduce((cur, p) => followLiveVehicles(doc(cur), [tlf(p)]).drawings[0], followed)
    expect(reach(driven.coords)).toBeGreaterThan(1000)
    expect(onSiteCoords(driven, 'start', DEPOT)).toEqual(d.coords)
  })

  it('a line that lost vertices since falls back to the snapshot itself', () => {
    const driven = drive(follow(hose('paused')), route(SITE, DEPOT, 3))
    const shortened = { ...driven, coords: driven.coords.slice(-2) }
    expect(onSiteCoords(shortened, 'end', DEPOT)).toEqual(hose('paused').coords)
  })

  it('without a snapshot: the screen\'s end (guarded/paused are on site by the guard)', () => {
    const d = hose('paused')
    const onSite: LngLat = [SITE[0] - 0.00001, SITE[1]]
    expect(onSiteCoords(d, 'end', onSite)).toEqual([...d.coords.slice(0, -1), onSite])
  })
})

describe('revertCoords · «Zurück auf Stand am Einsatzort»', () => {
  it('is the snapshotted line exactly — and nothing without a snapshot', () => {
    const d = hose('paused')
    const driven = drive(follow(d), route(SITE, DEPOT, 25))
    expect(revertCoords(driven, 'end')).toEqual(d.coords)
    expect(revertCoords(d, 'end')).toBeNull()
    // a copy — reverting never hands the stored snapshot's arrays to the document
    expect(revertCoords(driven, 'end')![0]).not.toBe(driven.endAttachment!.gps!.before!.coords[0])
  })
})

describe('gpsNotices · what the Meldeleiste says', () => {
  it('away: paused, the line still ends on site — with the live distance', () => {
    const [n] = gpsNotices([hose('paused')], [tlf(DEPOT)])
    expect(n.kind).toBe('away')
    expect(n.distanceM!).toBeGreaterThan(1000)
    expect(n.vehicle?.label).toBe('TLF')
  })

  it('stopped: paused after following', () => {
    const followed = follow(hose('paused'))
    const stopped = { ...followed, ...routingPatch(followed, 'end', 'direct', { resolvedEnd: DEPOT, at: AT })! }
    expect(gpsNotices([stopped], [tlf(DEPOT)])[0].kind).toBe('stopped')
  })

  it('back: following, and the vehicle is inside 150 m of the on-site point again — never while it is away', () => {
    const followed = follow(hose('paused'))
    expect(gpsNotices([followed], [tlf(DEPOT)])).toEqual([])
    const near: LngLat = [SITE[0] + 0.0012, SITE[1]] // ~90 m
    const [n] = gpsNotices([followed], [tlf(near)])
    expect(n.kind).toBe('back')
    expect(n.distanceM!).toBeLessThanOrEqual(BACK_ON_SITE_M)
    // …and once this device answered «Weiter folgen», not again for this return
    expect(gpsNotices([followed], [tlf(near)], new Set([backKey('hose', 'end', n.before!)]))).toEqual([])
  })

  it('a vehicle missing from the feed still gets its row, without a distance', () => {
    const [n] = gpsNotices([hose('paused')], [])
    expect(n.distanceM).toBeUndefined()
  })

  it('guarded ends and plain attachments say nothing', () => {
    expect(gpsNotices([hose('guarded')], [tlf(SITE)])).toEqual([])
  })
})

describe('useBackOffers · asked once per return', () => {
  it('a dismissed offer re-arms only once the vehicle is 300 m out again', () => {
    const followed = follow(hose('paused'))
    const key = backKey('hose', 'end', followed.endAttachment!.gps!.before!)
    const near: LngLat = [SITE[0] + 0.0012, SITE[1]]
    const mid: LngLat = [SITE[0] + 0.0030, SITE[1]] // ~225 m — between the rings
    const far: LngLat = [SITE[0] + 0.0050, SITE[1]] // ~375 m
    const { result, rerender } = renderHook(({ v }) => useBackOffers([followed], [tlf(v)]), { initialProps: { v: near } })
    act(() => result.current.dismiss(key))
    expect(result.current.dismissed.has(key)).toBe(true)
    rerender({ v: mid })
    expect(result.current.dismissed.has(key)).toBe(true)
    rerender({ v: far })
    expect(result.current.dismissed.has(key)).toBe(false)
    expect(haversineM(SITE, far)).toBeGreaterThanOrEqual(AWAY_AGAIN_M)
  })

  it('an offer whose following ended, or whose line is gone, is forgotten', () => {
    const followed = follow(hose('paused'))
    const key = backKey('hose', 'end', followed.endAttachment!.gps!.before!)
    expect(rearmed(key, [], [])).toBe(true)
    expect(rearmed(key, [{ ...followed, endAttachment: undefined }], [tlf(SITE)])).toBe(true)
    expect(rearmed(key, [followed], [tlf(SITE)])).toBe(false)
  })
})

describe('small words', () => {
  it('fmtAway: metres, ten metres, one decimal of a kilometre', () => {
    expect(fmtAway(34.4)).toBe('34 m')
    expect(fmtAway(338)).toBe('340 m')
    expect(fmtAway(996)).toBe('1.0 km')
    expect(fmtAway(1149)).toBe('1.1 km')
  })

  it('gpsLineName: «Leitung 1» for a numbered hose, its own name when it has one', () => {
    expect(gpsLineName(hose('paused'))).toBe('Leitung 1')
    expect(gpsLineName(hose('paused', { label: 'Speiseleitung' }))).toBe('Speiseleitung')
    expect(gpsLineName(hose('paused', { lineNo: undefined }))).toBe('Linie')
  })

  it('onSiteAnchor: the snapshot, else lastSafe, else (legacy trace) the last confirmation', () => {
    const followed = follow(hose('paused'))
    const driven = drive(followed, route(SITE, DEPOT, 5))
    expect(onSiteAnchor(driven.endAttachment!.gps!)).toEqual(SITE)
    expect(onSiteAnchor({ state: 'paused', confirmedAt: SITE, lastSafe: HYDRANT })).toEqual(HYDRANT)
    expect(onSiteAnchor({ state: 'continuous', confirmedAt: SITE, lastSafe: DEPOT })).toEqual(SITE)
  })
})
