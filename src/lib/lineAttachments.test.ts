import { describe, expect, it } from 'vitest'
import type { LineAttachment } from '../types'
import {
  advanceDwell, applyRouting, armDwell, attachInsetPx, boundaryPoint, detachProgress,
  DETACH_SHOW_PROGRESS, dwellFor, EMPTY_DWELL, endpointCapacity, flipLine, MAGNET_DWELL_MS,
  forkDims, forkPortPoint, gpsGuard, incomingAttachments, isMagnetAnno, isMagnetEntity,
  materializeEndpoint, moveLineBody,
  nearestFreeEndpoint, nearestMagneticTarget, nextFreePort, relationshipNetwork, resolveLinePoints, stickyMagneticTarget,
  MAGNET_RADIUS_PX, TEAM_JOIN_RADIUS_PX,
  wouldCreateCycle, type AttachableLine, type MagneticTarget,
} from './lineAttachments'

const line = (id: string, extra: Partial<AttachableLine> = {}): AttachableLine => ({ id, points: [[0, 0], [10, 0]], ...extra })
const toLine = (id: string, endpoint: 'start' | 'end' = 'end', port?: number): LineAttachment => ({ target: { kind: 'line', id, endpoint }, routing: 'direct', port })

describe('magnetic candidate and dwell', () => {
  it('takes the nearest eligible target inside the screen-space radius', () => {
    const got = nearestMagneticTarget([0, 0], [
      { key: 'far', target: { kind: 'object', id: 'far' }, point: [25, 0] },
      { key: 'near', target: { kind: 'object', id: 'near' }, point: [8, 0] },
      { key: 'blocked', target: { kind: 'object', id: 'blocked' }, point: [2, 0], blocked: true },
    ])
    expect(got?.key).toBe('near')
    expect(nearestMagneticTarget([0, 0], [{ key: 'x', target: { kind: 'object', id: 'x' }, point: [33, 0] }])).toBeNull()
  })

  it('holds a locked target through boundary jitter and hops only for a clearly closer one', () => {
    const a: MagneticTarget = { key: 'a', target: { kind: 'object', id: 'a' }, point: [0, 0] }
    const far: MagneticTarget = { key: 'far', target: { kind: 'object', id: 'far' }, point: [100, 0] }
    const c: MagneticTarget = { key: 'c', target: { kind: 'object', id: 'c' }, point: [30, 0] }
    // held 'a' 36px out — past its 32px acquire radius but still inside the 44px keep radius → held
    expect(stickyMagneticTarget([36, 0], [a, far], 'a')?.key).toBe('a')
    // dragged clear of the keep radius → dropped (lets the detach × show)
    expect(stickyMagneticTarget([60, 0], [a, far], 'a')).toBeNull()
    // near-equidistant rival stays with the held one (14 vs 16) — no flicker
    expect(stickyMagneticTarget([14, 0], [a, c], 'a')?.key).toBe('a')
    // rival clearly closer (>8px: 10 vs 20) wins
    expect(stickyMagneticTarget([20, 0], [a, c], 'a')?.key).toBe('c')
    // nothing held → plain nearest
    expect(stickyMagneticTarget([20, 0], [a, c], null)?.key).toBe('c')
  })

  // Candidates as the snap sites hand them in: a symbol (dwell) and a line end (instant).
  const sym = (key: string) => ({ key, target: { kind: 'object' as const, id: key } })
  const lineEnd = (key: string) => ({ key, target: { kind: 'line' as const, id: key, endpoint: 'end' as const } })

  it('dwells 500 ms on a symbol and not at all on a line end (14.09.)', () => {
    expect(dwellFor(sym('a'))).toBe(MAGNET_DWELL_MS)
    expect(dwellFor(lineEnd('l'))).toBe(0)
    expect(dwellFor(null)).toBe(MAGNET_DWELL_MS)
  })

  it('restarts fill on candidate changes and arms a symbol at the dwell', () => {
    let s = advanceDwell({ key: null, since: 0, armed: false }, sym('a'), 100)
    expect(advanceDwell(s, sym('a'), 599).armed).toBe(false)
    s = advanceDwell(s, sym('a'), 600)
    expect(s.armed).toBe(true)
    expect(advanceDwell(s, sym('b'), 700)).toEqual({ key: 'b', since: 700, armed: false })
  })

  // A stroke put on another line's end (or a Teilstück prong) means «from here» — there is
  // nothing to hesitate about, so the line target is armed the frame it is acquired.
  it('arms a line target the instant it is acquired', () => {
    expect(advanceDwell(EMPTY_DWELL, lineEnd('l'), 100)).toEqual({ key: 'l', since: 100, armed: true })
    // …and hopping from it onto a symbol starts that symbol's own full dwell
    const onSym = advanceDwell(advanceDwell(EMPTY_DWELL, lineEnd('l'), 100), sym('a'), 150)
    expect(onSym).toEqual({ key: 'a', since: 150, armed: false })
  })

  // The whole point of the 25.08. rework: `armed` is the COMMIT gate, not a decoration. Leaving
  // the target — or never holding still long enough — must leave nothing armed, so the release
  // paths in MapView/Whiteboard place the endpoint free instead of coupling it silently.
  it('un-arms the moment the candidate is left, so a release attaches to nothing', () => {
    const held = advanceDwell(advanceDwell(EMPTY_DWELL, sym('a'), 0), sym('a'), 600)
    expect(held.armed).toBe(true)
    expect(advanceDwell(held, null, 700)).toEqual(EMPTY_DWELL)
    expect(advanceDwell(held, sym('b'), 700).armed).toBe(false)
  })

  it('arms a line START instantly — a pointerdown on a target is aim, not hesitation', () => {
    expect(armDwell('a', 900)).toEqual({ key: 'a', since: 900, armed: true })
    expect(armDwell(null, 900)).toEqual(EMPTY_DWELL)
    // and a start that armed instantly still yields the ring to a LATER symbol candidate
    expect(advanceDwell(armDwell('a', 900), sym('b'), 950).armed).toBe(false)
  })

  it('fills the release ring with distance pulled out, full exactly at the detach radius', () => {
    expect(detachProgress([0, 0], [0, 0])).toBe(0)
    expect(detachProgress([0, 0], [22, 0])).toBeCloseTo(0.5)
    expect(detachProgress([0, 0], [44, 0])).toBe(1)
    expect(detachProgress([0, 0], [500, 0])).toBe(1)
    // a nudge of a few px stays under the show threshold — no red flash under a moving finger
    expect(detachProgress([0, 0], [6, 0])).toBeLessThan(DETACH_SHOW_PROGRESS)
    expect(detachProgress([0, 0], [12, 0])).toBeGreaterThan(DETACH_SHOW_PROGRESS)
  })
})

describe('object boundaries', () => {
  it('intersects circle and rotated rectangle footprints facing the next vertex', () => {
    expect(boundaryPoint({ shape: 'circle', center: [10, 10], radius: 5 }, [20, 10], 2)).toEqual([17, 10])
    const p = boundaryPoint({ shape: 'rect', center: [0, 0], width: 20, height: 10, rotation: 90 }, [0, 20], 0)
    expect(p[0]).toBeCloseTo(0); expect(p[1]).toBeCloseTo(10)
  })

  it('tucks an attached endpoint UNDER the glyph — the round cap must not stick out', () => {
    // a 32 px symbol at the origin, hose coming in from the right with an 8 px stroke
    const edge = 16
    const p = boundaryPoint({ shape: 'rect', center: [0, 0], width: 32, height: 32 }, [100, 0], -attachInsetPx(8))
    expect(p[0]).toBeLessThan(edge)              // endpoint sits inside the glyph box
    expect(p[0] + 8 / 2).toBeLessThanOrEqual(edge) // …and so does the round cap's tip
  })
})

describe('capacity, E ports, and cycles', () => {
  it('allows one ordinary continuation and three branches from an E end', () => {
    const e = line('e', { teilstueck: true })
    const a = line('a', { endAttachment: toLine('e', 'end', 0) })
    const b = line('b', { startAttachment: toLine('e', 'end', 1) })
    expect(endpointCapacity(e, 'start')).toBe(1)
    expect(endpointCapacity(e, 'end')).toBe(3)
    expect(incomingAttachments([e, a, b], 'e', 'end')).toHaveLength(2)
    expect(nextFreePort([e, a, b], 'e', 'end')).toBe(2)
    const c = line('c', { endAttachment: toLine('e', 'end', 2) })
    expect(nextFreePort([e, a, b, c], 'e', 'end')).toBeNull()
  })

  it('rejects direct and transitive circular dependencies', () => {
    const a = line('a', { endAttachment: toLine('b') })
    const b = line('b', { endAttachment: toLine('c') })
    const c = line('c')
    expect(wouldCreateCycle([a, b, c], 'c', 'a')).toBe(true)
    expect(wouldCreateCycle([a, b, c], 'c', 'b')).toBe(true)
    expect(wouldCreateCycle([a, b, c], 'c', 'a')).toBe(true)
    expect(wouldCreateCycle([a, b, c], 'c', 'x')).toBe(false)
  })
})

describe('Teilstück fork ports', () => {
  it('lands the three ports on the fork prong tips: prong forward, ±half across', () => {
    const tip: [number, number] = [10, 0], neighbor: [number, number] = [0, 0], w = 10
    const { half, prong } = forkDims(w) // touch-sized: half = max(14, w*2.8)
    const mid = forkPortPoint(tip, neighbor, w, 1)
    expect(mid[0]).toBeCloseTo(10 + prong); expect(mid[1]).toBeCloseTo(0)       // middle prong straight ahead
    const top = forkPortPoint(tip, neighbor, w, 0), bot = forkPortPoint(tip, neighbor, w, 2)
    expect(top[1]).toBeCloseTo(-half); expect(bot[1]).toBeCloseTo(half)         // symmetric across the spine
    expect(top[0]).toBeCloseTo(10 + prong); expect(bot[0]).toBeCloseTo(10 + prong)
  })
  it('stays finite when the tip segment is degenerate', () => {
    const p = forkPortPoint([0, 0], [0, 0], 4, 0)
    expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
  })
})

describe('Teilstück branch carry', () => {
  it('a branch on a Teilstück -E follows the parent end (move + carry) via forkPortPoint', () => {
    const branchAttachment: LineAttachment = { target: { kind: 'line', id: 'p', endpoint: 'end' }, routing: 'direct', port: 1 }
    const branch: AttachableLine = { id: 'b', points: [[5, 5], [9, 1]], endAttachment: branchAttachment }
    const linePoint = (t: AttachableLine, ep: 'start' | 'end', att: LineAttachment, resolved: [number, number]) =>
      ep === 'end' && t.teilstueck && att.port != null && t.points.length >= 2
        ? forkPortPoint(resolved, t.points[t.points.length - 2], t.width ?? 4, att.port) : resolved
    const resolve = (parentEnd: [number, number]) => {
      const parent: AttachableLine = { id: 'p', points: [[0, 0], parentEnd], teilstueck: true }
      return resolveLinePoints(branch, { lines: [parent, branch], objectPoint: () => null, linePoint })
    }
    const near = resolve([10, 0])[1][0]
    const far = resolve([20, 0])[1][0]
    expect(far).toBeGreaterThan(near)   // parent end slides right → branch end carries with it
  })
})

describe('resolution, movement, detach, and networks', () => {
  it('resolves object boundaries and line endpoint chains without rewriting fallbacks', () => {
    const root = line('root', { points: [[2, 2], [10, 2]] })
    const child = line('child', { points: [[0, 0], [1, 0]], endAttachment: toLine('root', 'start') })
    const objectLine = line('obj', { startAttachment: { target: { kind: 'object', id: 'o1' }, routing: 'direct' } })
    const ctx = { lines: [root, child, objectLine], objectPoint: (id: string) => id === 'o1' ? [7, 7] as [number, number] : null }
    expect(resolveLinePoints(child, ctx)).toEqual([[0, 0], [2, 2]])
    expect(resolveLinePoints(objectLine, ctx)[0]).toEqual([7, 7])
    expect(child.points[1]).toEqual([1, 0])
  })

  it('keeps dangling fallbacks, materializes detach, and fixes attached body endpoints', () => {
    const attached = line('a', { startAttachment: { target: { kind: 'object', id: 'missing' }, routing: 'direct' } })
    expect(resolveLinePoints(attached, { lines: [attached], objectPoint: () => null })).toEqual(attached.points)
    expect(moveLineBody(attached, [2, 3])).toEqual([[0, 0], [12, 3]])
    const detached = materializeEndpoint(attached, 'start', [5, 6])
    expect(detached.points[0]).toEqual([5, 6]); expect(detached.startAttachment).toBeUndefined()
  })

  it('traverses line and object parties with decreasing network depth', () => {
    const a = line('a', { startAttachment: { target: { kind: 'object', id: 'pump' }, routing: 'direct' }, endAttachment: toLine('b') })
    const b = line('b', { endAttachment: { target: { kind: 'object', id: 'team' }, routing: 'trace' } })
    const net = relationshipNetwork([a, b], [], ['pump'])
    expect([...net.lineIds].sort()).toEqual(['a', 'b']); expect([...net.objectIds].sort()).toEqual(['pump', 'team'])
    expect(net.depth.get('object:team')).toBe(3)
  })

})

describe('routing and GPS guard', () => {
  it('direct moves only the endpoint; trace records movement including return paths', () => {
    expect(applyRouting([[0, 0], [10, 0]], 'end', [12, 2], 'direct')).toEqual([[0, 0], [12, 2]])
    let p = applyRouting([[0, 0], [10, 0]], 'end', [12, 2], 'trace', 0)
    p = applyRouting(p, 'end', [10, 0], 'trace', 0)
    expect(p).toEqual([[0, 0], [10, 0], [12, 2], [10, 0]])
  })

  it('freezes guarded GPS at cumulative 20 m and continuous follows', () => {
    const metres = (a: [number, number], b: [number, number]) => Math.abs(b[0] - a[0])
    expect(gpsGuard('guarded', [0, 0], [19, 0], [19, 0], metres).point).toEqual([19, 0])
    expect(gpsGuard('guarded', [0, 0], [19, 0], [21, 0], metres)).toEqual({ state: 'paused', point: [19, 0], exceeded: true })
    expect(gpsGuard('continuous', [0, 0], [19, 0], [50, 0], metres).point).toEqual([50, 0])
  })
})

describe('per-vertex Plan floors', () => {
  it('preserves optional tuple metadata through resolution and routing', () => {
    const l: AttachableLine<[number, number] | [number, number, number]> = { id: 'p', points: [[0, 0], [1, 1, 2]] }
    const moved = applyRouting(l.points, 'end', [2, 2, 3], 'direct')
    expect(moved).toEqual([[0, 0], [2, 2, 3]])
  })
})

// «Richtung umkehren» — the one rule both surfaces flip a line by. The whole point is that NOTHING
// visibly moves except the Abschluss: the drawn path stays, and every attachment keeps the exact
// coordinate it was hanging on, from both directions.
describe('flipLine', () => {
  const obj = (id: string): LineAttachment => ({ target: { kind: 'object', id }, routing: 'direct' })
  const onLine = (id: string, endpoint: 'start' | 'end'): LineAttachment => ({ target: { kind: 'line', id, endpoint }, routing: 'direct' })

  it('reverses the points and swaps the line\'s own two attachments', () => {
    const hose: AttachableLine = { id: 'h', points: [[0, 0], [1, 0], [2, 0]], startAttachment: obj('tlf'), endAttachment: obj('haus') }
    const f = flipLine(hose, [hose])
    expect(f.points).toEqual([[2, 0], [1, 0], [0, 0]])
    // the TLF sat on [0,0]; that coordinate is now the LAST point, so it is the end attachment
    expect(f.endAttachment).toEqual(obj('tlf'))
    expect(f.startAttachment).toEqual(obj('haus'))
  })

  it('leaves an attachment-free line alone but for its order', () => {
    const f = flipLine({ id: 'h', points: [[0, 0], [3, 4]] }, [])
    expect(f.points).toEqual([[3, 4], [0, 0]])
    expect(f.startAttachment).toBeUndefined()
    expect(f.endAttachment).toBeUndefined()
    expect(f.incoming).toEqual([])
  })

  it('re-points every line hooked to it, so a branch stays on the tip it was coupled to', () => {
    const hose: AttachableLine = { id: 'h', points: [[0, 0], [2, 0]] }
    const branch: AttachableLine = { id: 'b', points: [[2, 0], [2, 2]], startAttachment: onLine('h', 'end') }
    const f = flipLine(hose, [hose, branch])
    // the branch hangs on the coordinate [2,0] — after the flip that is the hose's START
    expect(f.incoming).toEqual([{ lineId: 'b', endpoint: 'start', attachment: onLine('h', 'start') }])
  })

  it('carries a port (Teilstück prong) across untouched', () => {
    const hose: AttachableLine = { id: 'h', points: [[0, 0], [2, 0]], teilstueck: true }
    const branch: AttachableLine = { id: 'b', points: [[2, 0], [2, 2]], endAttachment: { ...onLine('h', 'end'), port: 2 } }
    const f = flipLine(hose, [hose, branch])
    expect(f.incoming[0].attachment.port).toBe(2)
    expect(f.incoming[0].attachment.target).toEqual({ kind: 'line', id: 'h', endpoint: 'start' })
  })

  it('ignores lines hooked to something else, and never rewrites the flipped line via `incoming`', () => {
    const hose: AttachableLine = { id: 'h', points: [[0, 0], [2, 0]], startAttachment: onLine('other', 'end') }
    const elsewhere: AttachableLine = { id: 'x', points: [[9, 9], [8, 8]], startAttachment: onLine('other', 'start') }
    const f = flipLine(hose, [hose, elsewhere])
    expect(f.incoming).toEqual([])
    // its own link to `other` travelled with its coordinate instead
    expect(f.endAttachment).toEqual(onLine('other', 'end'))
  })

  it('is its own inverse — flipping twice restores the line and everything on it', () => {
    const hose: AttachableLine = { id: 'h', points: [[0, 0], [1, 1], [2, 0]], startAttachment: obj('tlf'), endAttachment: obj('haus') }
    const branch: AttachableLine = { id: 'b', points: [[2, 0], [3, 0]], startAttachment: onLine('h', 'end') }
    const once = flipLine(hose, [hose, branch])
    const branch1: AttachableLine = { ...branch, startAttachment: once.incoming[0].attachment }
    const hose1: AttachableLine = { ...hose, points: once.points, startAttachment: once.startAttachment, endAttachment: once.endAttachment }
    const twice = flipLine(hose1, [hose1, branch1])
    expect(twice.points).toEqual(hose.points)
    expect(twice.startAttachment).toEqual(hose.startAttachment)
    expect(twice.endAttachment).toEqual(hose.endAttachment)
    expect(twice.incoming[0].attachment).toEqual(branch.startAttachment)
  })

  it('the flipped geometry still resolves both ends onto their targets', () => {
    const hose: AttachableLine = { id: 'h', points: [[0, 0], [5, 0]], startAttachment: obj('tlf'), endAttachment: obj('haus') }
    const f = flipLine(hose, [hose])
    const flipped: AttachableLine = { ...hose, points: f.points, startAttachment: f.startAttachment, endAttachment: f.endAttachment }
    const at: Record<string, [number, number]> = { tlf: [0, 0], haus: [5, 0] }
    const resolved = resolveLinePoints(flipped, { lines: [flipped], objectPoint: (id) => at[id] ?? null })
    // start = the Haus it now leaves from, end = the TLF — both still ON their object
    expect(resolved[0]).toEqual([5, 0])
    expect(resolved[resolved.length - 1]).toEqual([0, 0])
  })
})

// ONE list per frame, because it used to be four hand-maintained copies of the same sentence
// (MapView · candidatesAt / trackPlaceMagnet, MapMarkers · trackEndMagnet, Whiteboard ·
// planCandidatesAt) and nothing stopped them drifting apart.
describe('what a magnet may dock onto', () => {
  it('accepts only the kinds that state a PLACE — a symbol, a vehicle, a crew', () => {
    expect(['symbol', 'vehicle', 'team'].map((kind) => isMagnetEntity({ kind } as never))).toEqual([true, true, true])
    // ground, paper and a silhouette are not places a hose ends
    expect(['shape', 'note', 'photo', 'person'].map((kind) => isMagnetEntity({ kind } as never))).toEqual([false, false, false, false])
  })

  it('says the same in the Plan\'s own vocabulary — a Trupp chip is a `resource` there', () => {
    expect(isMagnetAnno({ kind: 'symbol' })).toBe(true)
    expect(isMagnetAnno({ kind: 'resource' })).toBe(true)
    expect(['draw', 'area', 'circle', 'text', 'shape'].map((kind) => isMagnetAnno({ kind } as never))).toEqual([false, false, false, false, false])
    expect(isMagnetAnno({})).toBe(false)
  })
})

// The magnet read backwards — «which endpoint is lying under what I just dropped here». Both
// surfaces ask it when a Trupp marker is dropped (IncidentWorkspace · finishEntityMove,
// Whiteboard · chipUp), so the two can never disagree about what «close enough» means.
describe('nearestFreeEndpoint (a marker dropped on the end of a hose)', () => {
  const same = (p: [number, number]): [number, number] => p

  it('takes the nearest FREE end inside the magnet radius', () => {
    const lines: AttachableLine[] = [
      { id: 'far', points: [[200, 0], [300, 0]] },
      { id: 'near', points: [[5, 0], [100, 0]] },
    ]
    expect(nearestFreeEndpoint([0, 0], lines, same)).toEqual({ lineId: 'near', endpoint: 'start', point: [5, 0] })
    // …and the far end of the same hose, when that is the one under the finger
    expect(nearestFreeEndpoint([98, 0], lines, same)?.endpoint).toBe('end')
  })

  // a Trupp joins at the hose's END only (15.09.): the caller narrows the ends that may answer
  it('answers with the ends the caller allows – the start of a hose is not where a crew goes', () => {
    const lines: AttachableLine[] = [{ id: 'h', points: [[5, 0], [100, 0]] }]
    expect(nearestFreeEndpoint([0, 0], lines, same, 32, ['end'])).toBeNull()
    expect(nearestFreeEndpoint([98, 0], lines, same, 32, ['end'])?.endpoint).toBe('end')
  })

  it('leaves an end that is already docked alone', () => {
    const lines: AttachableLine[] = [{ id: 'h', points: [[0, 0], [100, 0]], startAttachment: { target: { kind: 'object', id: 'tlf' }, routing: 'direct' } }]
    expect(nearestFreeEndpoint([0, 0], lines, same)).toBeNull()
  })

  it('answers nothing beside the MIDDLE of a hose, or beyond the radius', () => {
    const lines: AttachableLine[] = [{ id: 'h', points: [[0, 0], [50, 0], [100, 0]] }]
    expect(nearestFreeEndpoint([50, 2], lines, same)).toBeNull()   // a vertex, not an endpoint
    expect(nearestFreeEndpoint([0, 40], lines, same)).toBeNull()   // outside MAGNET_RADIUS_PX
  })

  it('measures in the px space the caller projects into', () => {
    // sheet fractions × a 1000×1000 board: 0.02 apart is 20 px, inside the radius
    const lines: AttachableLine[] = [{ id: 'h', points: [[0.5, 0.5], [0.9, 0.9]] }]
    const toPx = (p: [number, number]): [number, number] => [p[0] * 1000, p[1] * 1000]
    expect(nearestFreeEndpoint([510, 510], lines, toPx)?.endpoint).toBe('start')
    expect(nearestFreeEndpoint([560, 560], lines, toPx)).toBeNull()
  })

  it('ignores a degenerate line — a single point is no hose', () => {
    expect(nearestFreeEndpoint([0, 0], [{ id: 'dot', points: [[0, 0]] }], same)).toBeNull()
  })

  /** ⚠️ The Trupp-MARKER half of this magnet reaches further than the endpoint half, and it has
   *  to: an endpoint is dragged by the very point that lands in the socket, a marker is dragged
   *  by its body while its LEFT EDGE is what aims (lib/lineAttachments · TEAM_JOIN_RADIUS_PX,
   *  used by MapView · trackTeamJoin). A reach that stayed at 32 px is «nothing happened» with a
   *  pill under the thumb — which is exactly what the field reported. */
  it('reaches further for a Trupp marker than for a dragged endpoint', () => {
    expect(TEAM_JOIN_RADIUS_PX).toBeGreaterThan(MAGNET_RADIUS_PX)
    const lines: AttachableLine[] = [{ id: 'h', points: [[0, 0], [100, 0]] }]
    const justOutside: [number, number] = [0, (MAGNET_RADIUS_PX + TEAM_JOIN_RADIUS_PX) / 2]
    expect(nearestFreeEndpoint(justOutside, lines, same)).toBeNull()
    expect(nearestFreeEndpoint(justOutside, lines, same, TEAM_JOIN_RADIUS_PX)?.endpoint).toBe('start')
    // …and it is still a radius, not «anywhere»: past it nothing joins
    expect(nearestFreeEndpoint([0, TEAM_JOIN_RADIUS_PX + 1], lines, same, TEAM_JOIN_RADIUS_PX)).toBeNull()
  })
})
