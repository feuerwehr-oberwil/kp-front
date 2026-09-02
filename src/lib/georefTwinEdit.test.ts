import { describe, expect, it } from 'vitest'
import type { BoardAnno } from '../types'
import { deleteBoardTwinSource, detachBoardTwinEndpoint, patchBoardTwinSource, reverseBoardTwinSource,
  setBoardTwinEnding, teilstueckDependents } from './georefTwinEdit'

describe('editing through a georeference twin', () => {
  const source: BoardAnno = { id: 's1', kind: 'symbol', x: 0.3, y: 0.4, symbol: 'VKF Feuer', label: 'Brand' }
  const other: BoardAnno = { id: 's2', kind: 'symbol', x: 0.7, y: 0.8, symbol: 'VKF Fahrzeug', label: 'TLF' }

  it('patches the one source annotation and creates no mirrored copy', () => {
    const next = patchBoardTwinSource([source, other], source.id, { label: 'Brand Dach', rotation: 45 })
    expect(next).toHaveLength(2)
    expect(next.find((a) => a.id === source.id)).toMatchObject({ label: 'Brand Dach', rotation: 45 })
    expect(next.find((a) => a.id === other.id)).toBe(other)
  })

  it('deletes the source and safely detaches connected lines at its last position', () => {
    const line: BoardAnno = {
      id: 'l1', kind: 'draw', pts: [[0.1, 0.1], [0.2, 0.2]],
      endAttachment: { target: { kind: 'object', id: source.id }, routing: 'trace' },
    }
    const result = deleteBoardTwinSource([source, other, line], source.id)!
    expect(result.next.map((a) => a.id)).toEqual([other.id, line.id])
    expect(result.affectedIds).toEqual([line.id])
    expect(result.next[1]).toMatchObject({ pts: [[0.1, 0.1], [0.3, 0.4, 0]], endAttachment: undefined })
  })
})

/**
 * The map half of the mirror got its full DrawEditor on 01.09. (D-05): a mirrored Plan Leitung is
 * edited FROM the Karte, writing the one plan annotation. The three edits below reach past that
 * one annotation — reversing re-targets whatever hangs on it, dropping a Teilstück lets its
 * branches go, detaching pins an endpoint — so they resolve here rather than in the panel.
 */
describe('editing a mirrored plan Leitung from the Karte', () => {
  const hose: BoardAnno = { id: 'l1', kind: 'draw', pts: [[0.1, 0.1], [0.5, 0.1], [0.9, 0.1]], teilstueck: true }
  const branch: BoardAnno = {
    id: 'l2', kind: 'draw', pts: [[0.9, 0.1], [0.9, 0.6]],
    startAttachment: { target: { kind: 'line', id: 'l1', endpoint: 'end' }, routing: 'direct' },
  }
  const hydrant: BoardAnno = { id: 'h1', kind: 'symbol', x: 0.05, y: 0.05, symbol: 'VKF Hydrant' }

  it('reverses the line AND re-points the branch that hung on its end', () => {
    const write = reverseBoardTwinSource([hose, branch], 'l1')!
    const flipped = write.next.find((a) => a.id === 'l1')!
    expect(flipped.pts).toEqual([[0.9, 0.1], [0.5, 0.1], [0.1, 0.1]])
    // the branch was coupled to the tip — after the flip that coordinate is the START
    expect(write.next.find((a) => a.id === 'l2')!.startAttachment!.target).toMatchObject({ id: 'l1', endpoint: 'start' })
    expect(write.patches.map((p) => p.id)).toEqual(['l1', 'l2'])
  })

  it('names the branches a Teilstück carries, and releases them when the «E» goes', () => {
    expect(teilstueckDependents([hose, branch], 'l1')).toEqual([{ id: 'l2', endpoint: 'start' }])
    const write = setBoardTwinEnding([hose, branch], 'l1', 'arrow')!
    expect(write.next.find((a) => a.id === 'l1')).toMatchObject({ arrow: true, arrowStop: undefined, teilstueck: undefined })
    const released = write.next.find((a) => a.id === 'l2')!
    // the released endpoint keeps the coordinate it had — it loses the relationship, not its place
    expect(released.startAttachment).toBeUndefined()
    expect(released.pts![0]).toEqual([0.9, 0.1])
  })

  it('leaves the branches alone while the Abschluss stays a Teilstück', () => {
    const write = setBoardTwinEnding([hose, branch], 'l1', 'teilstueck')!
    expect(write.patches).toHaveLength(1)
    expect(write.next.find((a) => a.id === 'l2')!.startAttachment).toBeTruthy()
  })

  it('detaches one endpoint onto the target’s own position', () => {
    const attached: BoardAnno = {
      ...hose, teilstueck: undefined,
      startAttachment: { target: { kind: 'object', id: 'h1' }, routing: 'direct' },
    }
    const write = detachBoardTwinEndpoint([attached, hydrant], 'l1', 'start')!
    const line = write.next.find((a) => a.id === 'l1')!
    expect(line.startAttachment).toBeUndefined()
    expect(line.pts![0]).toEqual([0.05, 0.05, 0])
    // …and nothing else on the sheet moved
    expect(write.patches).toHaveLength(1)
  })

  it('answers null where there is nothing to write', () => {
    expect(reverseBoardTwinSource([hydrant], 'h1')).toBeNull()
    expect(detachBoardTwinEndpoint([hose], 'l1', 'start')).toBeNull()
    expect(setBoardTwinEnding([hose], 'nope', 'arrow')).toBeNull()
  })
})
