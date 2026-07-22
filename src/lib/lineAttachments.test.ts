import { describe, expect, it } from 'vitest'
import type { LineAttachment } from '../types'
import {
  advanceDwell, applyRouting, boundaryPoint, connectedNetwork, detachAffected, endpointCapacity,
  gpsGuard, incomingAttachments, materializeEndpoint, moveLineBody, nearestMagneticTarget,
  nextFreePort, relationshipNetwork, resolveLinePoints, wouldCreateCycle, type AttachableLine,
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

  it('traverses a full undirected display network', () => {
    const lines = [line('a', { endAttachment: toLine('b') }), line('b'), line('c', { startAttachment: toLine('b') }), line('z')]
    expect([...connectedNetwork(lines, ['a'])].sort()).toEqual(['a', 'b', 'c'])
  })

  it('traverses line and object parties with decreasing network depth', () => {
    const a = line('a', { startAttachment: { target: { kind: 'object', id: 'pump' }, routing: 'direct' }, endAttachment: toLine('b') })
    const b = line('b', { endAttachment: { target: { kind: 'object', id: 'team' }, routing: 'trace' } })
    const net = relationshipNetwork([a, b], [], ['pump'])
    expect([...net.lineIds].sort()).toEqual(['a', 'b']); expect([...net.objectIds].sort()).toEqual(['pump', 'team'])
    expect(net.depth.get('object:team')).toBe(3)
  })

  it('deleting a target materializes affected endpoints and never cascades', () => {
    const a = line('a', { endAttachment: { target: { kind: 'object', id: 'o' }, routing: 'direct' } })
    const b = line('b', { endAttachment: toLine('gone') })
    const gone = line('gone')
    const out = detachAffected([a, b, gone], new Set(['o']), new Set(['gone']), (l) => l.id === 'a' ? [[0, 0], [20, 20]] as [number, number][] : [[0, 0], [30, 30]] as [number, number][])
    expect(out.map((l) => l.id)).toEqual(['a', 'b'])
    expect(out[0].points[1]).toEqual([20, 20]); expect(out[0].endAttachment).toBeUndefined()
    expect(out[1].points[1]).toEqual([30, 30]); expect(out[1].endAttachment).toBeUndefined()
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
