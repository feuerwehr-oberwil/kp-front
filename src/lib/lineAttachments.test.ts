import { describe, expect, it } from 'vitest'
import type { LineAttachment } from '../types'
import {
  advanceDwell, applyRouting, boundaryPoint, endpointCapacity,
  forkDims, forkPortPoint, gpsGuard, incomingAttachments, materializeEndpoint, moveLineBody,
  nearestMagneticTarget, nextFreePort, relationshipNetwork, resolveLinePoints, stickyMagneticTarget,
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

  it('restarts fill on candidate changes and arms at 350 ms', () => {
    let s = advanceDwell({ key: null, since: 0, armed: false }, 'a', 100)
    expect(advanceDwell(s, 'a', 449).armed).toBe(false)
    s = advanceDwell(s, 'a', 450)
    expect(s.armed).toBe(true)
    expect(advanceDwell(s, 'b', 500)).toEqual({ key: 'b', since: 500, armed: false })
  })
})

describe('object boundaries', () => {
  it('intersects circle and rotated rectangle footprints facing the next vertex', () => {
    expect(boundaryPoint({ shape: 'circle', center: [10, 10], radius: 5 }, [20, 10], 2)).toEqual([17, 10])
    const p = boundaryPoint({ shape: 'rect', center: [0, 0], width: 20, height: 10, rotation: 90 }, [0, 20], 0)
    expect(p[0]).toBeCloseTo(0); expect(p[1]).toBeCloseTo(10)
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
