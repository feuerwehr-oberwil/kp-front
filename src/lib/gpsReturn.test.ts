// @vitest-environment jsdom
/**
 * The live-GPS coupling's way back to the Einsatzort (D3, after the Übung on 23.09.2026: «Weiter
 * folgen» for a TLF already back at its depot drew a 1.15 km depot → site → depot spike into the
 * saved hose line, and nothing remembered the on-site state).
 */
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  AWAY_AGAIN_M, AWAY_NOTICE_M, BACK_ON_SITE_M, endKey, fmtAway, followerOnlyChange, freshBefore, gpsLineName, gpsLineNames, gpsNotices,
  gpsReleaseRow, gpsRevertWords, hasTraced, onSiteAnchor, onSiteCoords, onSiteKnown, revertCoords, routingPatch, useGpsNotices,
} from './gpsReturn'
import { formatTime } from './format'
import type { TacticalObject } from './tacticalObjects'
import { followLiveVehicles } from './useGpsFollow'
import { haversineM } from './geo'
import type { Drawing, Entity, GpsFollowState, LngLat } from '../types'

const SITE: LngLat = [8.0, 47.0] // a neutral point — no station's real place
/** ~1.1 km north-east — a depot */
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

  it('a snapshot carried by an older build after it RE-CONFIRMED the end is stale — the next follow takes a fresh one', () => {
    const followed = follow(hose('paused'))
    const a = followed.endAttachment!
    // the pre-change «Direkt» out of a pause: { ...gps, state: 'guarded', confirmedAt, lastSafe } — before kept, unread
    const NEW: LngLat = [SITE[0] + 0.001, SITE[1]]
    const legacy: Drawing = { ...followed, coords: [HYDRANT, NEW], endAttachment: { ...a, routing: 'direct', gps: { ...a.gps!, state: 'guarded', confirmedAt: NEW, lastSafe: NEW } } }
    expect(freshBefore(legacy.endAttachment!.gps)).toBeUndefined()
    expect(revertCoords(legacy, 'end')).toBeNull()
    const again = follow(legacy, '2026-09-23T21:00:00.000Z')
    expect(again.endAttachment!.gps!.before!.at).toBe('2026-09-23T21:00:00.000Z')
    expect(again.endAttachment!.gps!.before!.coords).toEqual([HYDRANT, NEW])
  })
})

describe('onSiteCoords · «Am Einsatzort lösen» cuts the drive off', () => {
  it('followed to the depot and back and out again: cut back to the on-site line, and says it removed vertices', () => {
    const d = hose('paused')
    const driven = drive(follow(d), [...route(SITE, DEPOT, 20), ...route(DEPOT, SITE, 20), ...route(SITE, DEPOT, 20)])
    const { coords, removed } = onSiteCoords(driven, 'end', driven.coords[driven.coords.length - 1])
    expect(coords).toEqual(d.coords)
    expect(removed).toBe(true)
    expect(reach(coords)).toBeLessThan(100)
  })

  it('keeps a hand edit made to the rest of the line meanwhile (the difference to «Zurück»)', () => {
    const driven = drive(follow(hose('paused')), route(SITE, DEPOT, 10))
    const moved: LngLat = [HYDRANT[0] - 0.0001, HYDRANT[1]]
    const edited = { ...driven, coords: [moved, ...driven.coords.slice(1)] }
    const { coords } = onSiteCoords(edited, 'end', DEPOT)
    expect(coords[0]).toEqual(moved)
    expect(coords[coords.length - 1]).toEqual(SITE)
    expect(revertCoords(edited, 'end')![0]).toEqual(HYDRANT) // «Zurück» restores the snapshot exactly
  })

  it('a vertex a hand INSERTED meanwhile stays — the cut is found by value, not by index', () => {
    const driven = drive(follow(hose('paused')), route(SITE, DEPOT, 10))
    const extra: LngLat = [HYDRANT[0] + 0.0002, HYDRANT[1] + 0.00005]
    const edited = { ...driven, coords: [driven.coords[0], extra, ...driven.coords.slice(1)] }
    const { coords } = onSiteCoords(edited, 'end', DEPOT)
    expect(coords).toEqual([HYDRANT, extra, hose('paused').coords[1], SITE])
  })

  it('a START end is cut back the same way (the trace prepends there)', () => {
    const d: Drawing = { id: 's', kind: 'line', coords: [SITE, [SITE[0] - 0.0003, SITE[1]], HYDRANT],
      startAttachment: { target: { kind: 'object', id: 'gps-3', live: true }, routing: 'direct', gps: { state: 'paused', confirmedAt: SITE, lastSafe: SITE } } }
    const followed = { ...d, ...routingPatch(d, 'start', 'trace', { resolvedEnd: SITE, at: AT })! }
    const driven = route(SITE, DEPOT, 15).reduce((cur, p) => followLiveVehicles(doc(cur), [tlf(p)]).drawings[0], followed)
    expect(reach(driven.coords)).toBeGreaterThan(1000)
    expect(onSiteCoords(driven, 'start', DEPOT).coords).toEqual(d.coords)
  })

  it('BOTH ends following two vehicles: each end cuts back its own drive, whatever the other prepended', () => {
    const OTHER: LngLat = [SITE[0] - 0.002, SITE[1]]
    const mid: LngLat = [SITE[0] - 0.001, SITE[1] + 0.0002]
    const g = (at: LngLat) => ({ state: 'paused' as const, confirmedAt: at, lastSafe: at })
    const d: Drawing = { id: 'both', kind: 'line', coords: [OTHER, mid, SITE],
      startAttachment: { target: { kind: 'object', id: 'gps-9', live: true }, routing: 'direct', gps: g(OTHER) },
      endAttachment: { target: { kind: 'object', id: 'gps-3', live: true }, routing: 'direct', gps: g(SITE) } }
    let cur: Drawing = { ...d, ...routingPatch(d, 'end', 'trace', { resolvedEnd: SITE, at: AT })! }
    cur = { ...cur, ...routingPatch(cur, 'start', 'trace', { resolvedEnd: OTHER, at: AT })! }
    const away2: LngLat = [OTHER[0] - 0.01, OTHER[1] - 0.005]
    const a = route(SITE, DEPOT, 12), b = route(OTHER, away2, 12)
    for (let i = 0; i < 12; i++) cur = followLiveVehicles(doc(cur), [tlf(a[i]), { ...tlf(b[i]), id: 'gps-9' }]).drawings[0]
    // the end: the start's drive stays (it is the other end's business), this end's drive goes
    const endCut = onSiteCoords(cur, 'end', DEPOT).coords
    expect(endCut[endCut.length - 1]).toEqual(SITE)
    expect(endCut[endCut.length - 2]).toEqual(mid)
    expect(endCut[0]).toEqual(cur.coords[0])
    // …and the start the same way round
    const startCut = onSiteCoords(cur, 'start', away2).coords
    expect(startCut[0]).toEqual(OTHER)
    expect(startCut[1]).toEqual(mid)
  })

  it('a line that lost the vertex next to the end falls back to the snapshot itself', () => {
    const driven = drive(follow(hose('paused')), route(SITE, DEPOT, 3))
    const shortened = { ...driven, coords: driven.coords.slice(-2) }
    expect(onSiteCoords(shortened, 'end', DEPOT).coords).toEqual(hose('paused').coords)
  })

  it('without a snapshot: the given end, nothing removed', () => {
    const d = hose('paused')
    const onSite: LngLat = [SITE[0] - 0.00001, SITE[1]]
    expect(onSiteCoords(d, 'end', onSite)).toEqual({ coords: [...d.coords.slice(0, -1), onSite], removed: false })
  })
})

describe('onSiteKnown · where «Am Einsatzort» is a true word', () => {
  it('a fresh snapshot, a guarded end, a paused end still inside the guard — but not a trace without a snapshot', () => {
    expect(onSiteKnown(follow(hose('paused')).endAttachment!.gps!)).toBe(true)
    expect(onSiteKnown(hose('guarded').endAttachment!.gps!)).toBe(true)
    expect(onSiteKnown(hose('paused').endAttachment!.gps!)).toBe(true)
    // an older client's trace: continuous, no snapshot — or stopped after it, lastSafe at the depot
    expect(onSiteKnown({ state: 'continuous', confirmedAt: SITE, lastSafe: DEPOT })).toBe(false)
    expect(onSiteKnown({ state: 'paused', confirmedAt: SITE, lastSafe: DEPOT })).toBe(false)
    expect(hasTraced({ state: 'paused', confirmedAt: SITE, lastSafe: DEPOT })).toBe(true)
    expect(hasTraced(hose('paused').endAttachment!.gps!)).toBe(false)
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

describe('gpsNotices · one Meldung per vehicle', () => {
  const NEAR: LngLat = [SITE[0] + 0.0012, SITE[1]] // ~90 m
  const stop = (d: Drawing) => ({ ...d, ...routingPatch(d, 'end', 'direct', { resolvedEnd: DEPOT, at: AT })! })

  it('away: paused, the line still ends on site — with the live distance', () => {
    const [n] = gpsNotices([hose('paused')], [tlf(DEPOT)])
    expect(n.kind).toBe('away')
    expect(n.key).toBe('gps-3:away')
    expect(n.distanceM!).toBeGreaterThan(1000)
    expect(n.vehicle?.label).toBe('TLF')
  })

  it('two hoses on one TLF are ONE row naming both ends', () => {
    const two = [hose('paused'), hose('paused', { id: 'hose2', lineNo: 2 })]
    const rows = gpsNotices(two, [tlf(DEPOT)])
    expect(rows).toHaveLength(1)
    expect(rows[0].ends.map((e) => e.drawing.id)).toEqual(['hose', 'hose2'])
    expect(gpsLineNames(rows[0].ends.map((e) => e.drawing))).toBe('Leitung 1, Leitung 2')
  })

  it('stopped: paused after following — revertable only when every end kept its on-site line', () => {
    const stopped = stop(follow(hose('paused')))
    expect(gpsNotices([stopped], [tlf(DEPOT)])[0]).toMatchObject({ kind: 'stopped', canRevert: true })
    // an older build's trace, stopped: no snapshot, nothing to go back to
    const legacy = hose('paused', { endAttachment: { target: { kind: 'object', id: 'gps-3', live: true }, routing: 'direct', gps: { state: 'paused', confirmedAt: SITE, lastSafe: DEPOT } } })
    expect(gpsNotices([legacy], [tlf(DEPOT)])[0]).toMatchObject({ kind: 'stopped', canRevert: false })
    // ✕ waves it away on this device
    const key = endKey('hose', 'end', stopped.endAttachment!.gps!.before)
    expect(gpsNotices([stopped], [tlf(DEPOT)], { armed: new Set(), answered: new Set(), dismissed: new Set([key]) })).toEqual([])
  })

  it('back: NOT right after «Weiter folgen» 40 m off — only once the vehicle has been 300 m away', () => {
    const at40: LngLat = [SITE[0] + 0.0005, SITE[1]] // ~40 m
    const followed = drive(follow(hose('paused')), [at40])
    expect(gpsNotices([followed], [tlf(at40)])).toEqual([])
    expect(gpsNotices([followed], [tlf(NEAR)])).toEqual([])
    // it drove 1.1 km out: the trace itself says so — and coming back within 150 m asks
    const out = drive(followed, route(at40, DEPOT, 10))
    expect(gpsNotices([out], [tlf(DEPOT)])).toEqual([])
    const [n] = gpsNotices([out], [tlf(NEAR)])
    expect(n.kind).toBe('back')
    expect(n.distanceM!).toBeLessThanOrEqual(BACK_ON_SITE_M)
    // …and once this device answered «Weiter folgen», not again for this return
    const key = endKey('hose', 'end', n.before)
    expect(gpsNotices([out], [tlf(NEAR)], { armed: new Set(), answered: new Set([key]), dismissed: new Set() })).toEqual([])
  })

  it('a PARKED vehicle whose fix jitters past the 20 m pause raises nothing below 100 m — and clears silently when it comes back', () => {
    const jitter: LngLat = [SITE[0] + 0.00021, SITE[1]] // ~16 m: the staging walk-through of 25.09.2026
    const at95: LngLat = [SITE[0] + 0.00125, SITE[1]]   // ~95 m
    const at110: LngLat = [SITE[0] + 0.00145, SITE[1]]  // ~110 m
    expect(haversineM(SITE, at95)).toBeLessThan(AWAY_NOTICE_M)
    expect(haversineM(SITE, at110)).toBeGreaterThanOrEqual(AWAY_NOTICE_M)
    expect(gpsNotices([hose('paused')], [tlf(jitter)])).toEqual([])
    expect(gpsNotices([hose('paused')], [tlf(at95)])).toEqual([])
    expect(gpsNotices([hose('paused')], [tlf(at110)]).map((n) => n.kind)).toEqual(['away'])
    // back under the threshold: the row is simply gone again, nothing is written
    expect(gpsNotices([hose('paused')], [tlf(jitter)])).toEqual([])
  })

  it('a vehicle missing from the feed raises nothing — no distance, no evidence it left', () => {
    expect(gpsNotices([hose('paused')], [])).toEqual([])
  })

  it('guarded ends and plain attachments say nothing', () => {
    expect(gpsNotices([hose('guarded')], [tlf(SITE)])).toEqual([])
  })
})

describe('useGpsNotices · the device answers, asked once per return', () => {
  it('arms at 300 m live, asks within 150 m, «Weiter folgen» holds until 300 m out again', () => {
    const at40: LngLat = [SITE[0] + 0.0005, SITE[1]]
    // a follower that never traced far (a device joined late with only a short trace)
    const followed = drive(follow(hose('paused')), [at40])
    const NEAR: LngLat = [SITE[0] + 0.0012, SITE[1]]
    const FAR: LngLat = [SITE[0] + 0.0050, SITE[1]] // ~380 m
    const { result, rerender } = renderHook(({ v }) => useGpsNotices([followed], [tlf(v)]), { initialProps: { v: NEAR } })
    expect(result.current.notices).toEqual([]) // un-armed
    rerender({ v: FAR })
    expect(result.current.notices).toEqual([])
    rerender({ v: NEAR })
    expect(result.current.notices.map((n) => n.kind)).toEqual(['back'])
    act(() => result.current.answerBack(result.current.notices[0]))
    expect(result.current.notices).toEqual([])
    rerender({ v: [SITE[0] + 0.0030, SITE[1]] }) // ~225 m, between the rings
    rerender({ v: NEAR })
    expect(result.current.notices).toEqual([])
    rerender({ v: FAR })
    rerender({ v: NEAR })
    expect(result.current.notices.map((n) => n.kind)).toEqual(['back'])
    expect(haversineM(SITE, FAR)).toBeGreaterThanOrEqual(AWAY_AGAIN_M)
  })

  it('✕ on a «stopped» row hides it on this device until the end changes', () => {
    const stopped = { ...follow(hose('paused')), ...routingPatch(follow(hose('paused')), 'end', 'direct', { resolvedEnd: DEPOT, at: AT })! }
    const { result, rerender } = renderHook(({ ds }) => useGpsNotices(ds, [tlf(DEPOT)]), { initialProps: { ds: [stopped] } })
    act(() => result.current.dismissStopped(result.current.notices[0]))
    expect(result.current.notices).toEqual([])
    // the line is released and coupled anew: a new question
    rerender({ ds: [hose('paused')] })
    expect(result.current.notices.map((n) => n.kind)).toEqual(['away'])
  })
})

describe('followerOnlyChange · the merge tells the machine from a hand', () => {
  const obj = (d: Drawing): TacticalObject => ({ id: d.id, drawing: d })
  it('a follower sample is machine-only; a revert, a detach, «Folgen stoppen» are not', () => {
    const base = follow(hose('paused'))
    const sampled = drive(base, route(SITE, DEPOT, 3))
    expect(followerOnlyChange(obj(base), obj(sampled))).toBe(true)
    expect(followerOnlyChange(obj(base), obj({ ...base, coords: revertCoords(sampled, 'end')!, endAttachment: undefined }))).toBe(false)
    const stopped = { ...base, ...routingPatch(base, 'end', 'direct', { resolvedEnd: SITE, at: AT })! }
    expect(followerOnlyChange(obj(base), obj(stopped))).toBe(false)
    expect(followerOnlyChange(obj(base), obj({ ...base, color: '#ff0000' }))).toBe(false)
  })
})

describe('words', () => {
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

  it('the Verlauf row and the ↶ caption of «Zurück», with and without the vehicle', () => {
    const f = follow(hose('paused'))
    const ends = [{ drawing: f, endpoint: 'end' as const, before: f.endAttachment!.gps!.before }]
    const t = formatTime(new Date(AT))
    expect(gpsRevertWords(ends, 'TLF')).toEqual({ row: `Leitung 1: zurück auf Stand am Einsatzort (${t}), von TLF gelöst`, step: 'Leitung 1 zurück auf Stand am Einsatzort' })
    // the vehicle out of the feed: no placeholder («von Zeichnung gelöst») in its place
    expect(gpsRevertWords(ends).row).toBe(`Leitung 1: zurück auf Stand am Einsatzort (${t})`)
    const two = [...ends, { drawing: { ...f, id: 'h2', lineNo: 2 }, endpoint: 'end' as const, before: ends[0].before }]
    expect(gpsRevertWords(two, 'TLF').row).toBe(`Leitung 1, Leitung 2: zurück auf Stand am Einsatzort (${t}), von TLF gelöst`)
    expect(gpsReleaseRow([f], 'TLF')).toBe('Leitung 1: am Einsatzort von TLF gelöst, Fahrt entfernt')
  })

  it('onSiteAnchor: the snapshot, else lastSafe, else (a trace without one) the last confirmation', () => {
    const followed = follow(hose('paused'))
    const driven = drive(followed, route(SITE, DEPOT, 5))
    expect(onSiteAnchor(driven.endAttachment!.gps!)).toEqual(SITE)
    expect(onSiteAnchor({ state: 'paused', confirmedAt: SITE, lastSafe: HYDRANT })).toEqual(HYDRANT)
    expect(onSiteAnchor({ state: 'continuous', confirmedAt: SITE, lastSafe: DEPOT })).toEqual(SITE)
  })
})
