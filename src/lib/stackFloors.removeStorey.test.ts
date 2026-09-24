import { describe, expect, it } from 'vitest'
import { removeStorey } from './stackFloors'
import { resolvePlanAnnos } from './lineAttachments'
import type { BoardAnno } from '../types'

// «Geschoss entfernen»'s sweep, rule by rule (23.09.2026 as `sweepFloor`, carried onto
// removeStorey when #207 moved the sweep out of IncidentWorkspace · onRemoveFloor). Every anno here
// is the stack's OWN — which of a view's annos are own is lib/storeyRemoval.test's subject.
const sweep = (view: BoardAnno[], floor: number, remaining = [0, 2]) =>
  removeStorey(view, new Set(view.map((a) => a.id)), floor, remaining).after

describe('removeStorey · the sweep of the stack’s own annos', () => {
  it('takes what lived only on the storey, keeps everything elsewhere', () => {
    const prev: BoardAnno[] = [
      { id: 's1', kind: 'symbol', x: 0.5, y: 0.5, floor: 1 },
      { id: 's0', kind: 'symbol', x: 0.5, y: 0.5, floor: 0 },
      { id: 'l1', kind: 'draw', floor: 1, pts: [[0.1, 0.1, 1], [0.2, 0.2, 1]] },
      { id: 'legacy', kind: 'text', x: 0.3, y: 0.3 }, // no floor = EG
    ]
    expect(sweep(prev, 1).map((a) => a.id)).toEqual(['s0', 'legacy'])
    expect(sweep(prev, 0, [1, 2]).map((a) => a.id)).toEqual(['s1', 'l1'])
  })

  it('a Leitung climbing through the storey loses only its vertices there — and the end that went lets go', () => {
    const climb: BoardAnno = {
      id: 'l1', kind: 'draw', floor: 0, pts: [[0.1, 0.1, 0], [0.2, 0.2, 0], [0.2, 0.2, 1]],
      endAttachment: { target: { kind: 'object', id: 's9' }, routing: 'direct' },
    }
    const [l] = sweep([climb], 1)
    expect(l.pts).toEqual([[0.1, 0.1, 0], [0.2, 0.2, 0]])
    expect(l.endAttachment).toBeUndefined()
  })

  it('an end docked onto something that went with the storey lets go where it was DRAWN', () => {
    const truck: BoardAnno = { id: 't1', kind: 'symbol', x: 0.9, y: 0.9, floor: 1 }
    const hose: BoardAnno = {
      id: 'l1', kind: 'draw', floor: 0, pts: [[0.1, 0.1, 0], [0.5, 0.5, 0]],
      endAttachment: { target: { kind: 'object', id: 't1' }, routing: 'direct' },
    }
    const drawn = resolvePlanAnnos([truck, hose]).find((a) => a.id === 'l1')!.pts!
    const [l] = sweep([truck, hose], 1)
    expect(l.id).toBe('l1')
    // the point the end was drawn at, on the vertex's own storey — not the stored socket
    expect(l.pts).toEqual([[0.1, 0.1, 0], [drawn[1][0], drawn[1][1], 0]])
    expect(l.endAttachment).toBeUndefined()
  })

  it('drops a shape that fell below its minimum, and a trail’s positions on the storey', () => {
    const area: BoardAnno = { id: 'a1', kind: 'area', floor: 0, pts: [[0, 0, 0], [1, 0, 0], [1, 1, 1]] }
    const team: BoardAnno = { id: 'r1', kind: 'resource', x: 0.5, y: 0.5, floor: 0,
      trail: [{ x: 0.1, y: 0.1, floor: 0, t: '10:00' }, { x: 0.2, y: 0.2, floor: 1, t: '10:05' }] }
    const out = sweep([area, team], 1)
    expect(out.map((a) => a.id)).toEqual(['r1'])
    expect(out[0].trail).toEqual([{ x: 0.1, y: 0.1, floor: 0, t: '10:00' }])
  })

  it('is pure — the removal keeps the input for its ↶, and the same input gives the same stack', () => {
    const prev: BoardAnno[] = [{ id: 'l1', kind: 'draw', floor: 0, pts: [[0, 0, 0], [1, 1, 0], [1, 1, 1]] }]
    const copy = structuredClone(prev)
    const a = sweep(prev, 1)
    expect(prev).toEqual(copy)
    expect(sweep(prev, 1)).toEqual(a)
  })
})
