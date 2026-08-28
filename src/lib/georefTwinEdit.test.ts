import { describe, expect, it } from 'vitest'
import type { BoardAnno } from '../types'
import { deleteBoardTwinSource, patchBoardTwinSource } from './georefTwinEdit'

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
