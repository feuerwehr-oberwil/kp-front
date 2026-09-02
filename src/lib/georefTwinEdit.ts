import { flipLine } from './lineAttachments'
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

/** A write that touches MORE than the mirrored annotation itself. `patches` names every anno that
 *  actually changed, so the caller emits one `board.edit` per entry and replay reconstructs the
 *  same picture; `next` is the whole plan document after the write, for one undo step. */
export interface BoardTwinWrite {
  next: BoardAnno[]
  patches: { id: string; patch: Partial<BoardAnno> }[]
}

const applyPatches = (annos: BoardAnno[], patches: BoardTwinWrite['patches']): BoardAnno[] => {
  const byId = new Map(patches.map((p) => [p.id, p.patch]))
  return annos.map((anno) => { const patch = byId.get(anno.id); return patch ? { ...anno, ...patch } : anno })
}

/**
 * «Richtung umkehren» on a mirrored plan Leitung, from the Karte.
 *
 * The same `flipLine` both native surfaces call, so the line's own two attachments swap and every
 * OTHER plan line hanging on one of its ends is re-targeted — a branch coupled to the tip of a
 * hose must not leap to its other end because the flip happened through the mirror.
 */
export function reverseBoardTwinSource(annos: BoardAnno[], id: string): BoardTwinWrite | null {
  const target = annos.find((anno) => anno.id === id)
  if (target?.kind !== 'draw' || (target.pts?.length ?? 0) < 2) return null
  const lines = annos.filter((a) => a.kind === 'draw' && (a.pts?.length ?? 0) >= 2)
    .map((a) => ({ id: a.id, points: a.pts!, startAttachment: a.startAttachment, endAttachment: a.endAttachment }))
  const flip = flipLine({ id, points: target.pts!, startAttachment: target.startAttachment, endAttachment: target.endAttachment }, lines)
  const patches: BoardTwinWrite['patches'] = [
    { id, patch: { pts: flip.points, startAttachment: flip.startAttachment, endAttachment: flip.endAttachment } },
    ...flip.incoming.map((i) => ({ id: i.lineId, patch: { [i.endpoint === 'start' ? 'startAttachment' : 'endAttachment']: i.attachment } as Partial<BoardAnno> })),
  ]
  return { next: applyPatches(annos, patches), patches }
}

/** The plan lines hooked onto this one's END — what a Teilstück «E» carries, and what has to be
 *  let go (with a confirmation) before the Abschluss stops being one. */
export function teilstueckDependents(annos: BoardAnno[], id: string): { id: string; endpoint: 'start' | 'end' }[] {
  return annos.flatMap((anno) => (['start', 'end'] as const).filter((endpoint) => {
    const rel = endpoint === 'start' ? anno.startAttachment : anno.endAttachment
    return rel?.target.kind === 'line' && rel.target.id === id && rel.target.endpoint === 'end'
  }).map((endpoint) => ({ id: anno.id, endpoint })))
}

/**
 * Change a mirrored plan line's Abschluss (Whiteboard · changePlanEnding, seen from the Karte).
 *
 * Dropping a Teilstück releases everything that hung on its «E»: those endpoints keep the
 * coordinate they had and lose the now-meaningless relationship — the same rule a delete follows.
 * The caller confirms first (`teilstueckDependents`), because it is other people's lines.
 */
export function setBoardTwinEnding(
  annos: BoardAnno[], id: string, ending: 'none' | 'arrow' | 'arrowStop' | 'teilstueck',
): BoardTwinWrite | null {
  const target = annos.find((anno) => anno.id === id)
  if (!target) return null
  const released = target.teilstueck && ending !== 'teilstueck' ? teilstueckDependents(annos, id) : []
  const tip = target.pts?.[target.pts.length - 1]
  const patches: BoardTwinWrite['patches'] = [{
    id,
    patch: {
      arrow: ending === 'arrow' || ending === 'arrowStop' || undefined,
      arrowStop: ending === 'arrowStop' || undefined,
      teilstueck: ending === 'teilstueck' || undefined,
    },
  }]
  for (const { id: lineId, endpoint } of released) {
    const line = annos.find((anno) => anno.id === lineId)
    if (!line?.pts?.length || !tip) continue
    const idx = endpoint === 'start' ? 0 : line.pts.length - 1
    patches.push({
      id: lineId,
      patch: {
        pts: line.pts.map((p, i) => (i === idx ? tip : p)),
        ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }),
      },
    })
  }
  return { next: applyPatches(annos, patches), patches }
}

/** Detach one endpoint of a mirrored plan line: the point stays exactly where the attachment had
 *  put it (the target's own position, or the line's stored coordinate when the target is gone),
 *  and only the relationship goes — the Karte's `detachTwinDrawing`, in plan space. */
export function detachBoardTwinEndpoint(annos: BoardAnno[], id: string, endpoint: 'start' | 'end'): BoardTwinWrite | null {
  const target = annos.find((anno) => anno.id === id)
  const rel = endpoint === 'start' ? target?.startAttachment : target?.endAttachment
  if (!target?.pts?.length || !rel) return null
  const idx = endpoint === 'start' ? 0 : target.pts.length - 1
  const other = annos.find((anno) => anno.id === rel.target.id)
  const anchor: BoardPoint | undefined = rel.target.kind === 'object'
    ? (other && other.x != null && other.y != null ? [other.x, other.y, other.floor ?? 0] : undefined)
    : other?.pts?.length ? other.pts[rel.target.endpoint === 'start' ? 0 : other.pts.length - 1] : undefined
  const patch: Partial<BoardAnno> = {
    pts: target.pts.map((p, i) => (i === idx ? (anchor ?? p) : p)),
    ...(endpoint === 'start' ? { startAttachment: undefined } : { endAttachment: undefined }),
  }
  return { next: applyPatches(annos, [{ id, patch }]), patches: [{ id, patch }] }
}
