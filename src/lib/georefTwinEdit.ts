import type { BoardAnno, BoardPoint } from '../types'

/** Write through a plan twin to its one source annotation. The projection itself is never added
 * to either document, so an edit cannot create a duplicate or drift from the source later. */
export function patchBoardTwinSource(annos: BoardAnno[], id: string, patch: Partial<BoardAnno>): BoardAnno[] {
  return annos.map((anno) => anno.id === id ? { ...anno, ...patch } : anno)
}

export interface DeleteBoardTwinResult {
  next: BoardAnno[]
  affectedIds: string[]
}

/** Delete a plan-owned symbol through its projection. Lines attached to that object keep a real
 * endpoint at its last plan position and lose the now-invalid relationship. */
export function deleteBoardTwinSource(annos: BoardAnno[], id: string): DeleteBoardTwinResult | null {
  const target = annos.find((anno) => anno.id === id)
  if (!target) return null
  const anchor: BoardPoint = [target.x ?? 0.5, target.y ?? 0.5, target.floor ?? 0]
  const affectedIds: string[] = []
  const next = annos.filter((anno) => anno.id !== id).map((anno) => {
    if (!anno.pts?.length) return anno
    let changed = false
    let startAttachment = anno.startAttachment, endAttachment = anno.endAttachment
    const pts = anno.pts.map((point) => [...point] as BoardPoint)
    if (startAttachment?.target.kind === 'object' && startAttachment.target.id === id) {
      pts[0] = anchor
      startAttachment = undefined
      changed = true
    }
    if (endAttachment?.target.kind === 'object' && endAttachment.target.id === id) {
      pts[pts.length - 1] = anchor
      endAttachment = undefined
      changed = true
    }
    if (!changed) return anno
    affectedIds.push(anno.id)
    return { ...anno, pts, startAttachment, endAttachment }
  })
  return { next, affectedIds }
}
