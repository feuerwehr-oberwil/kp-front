import { describe, expect, it } from 'vitest'
import { draftActive, finishKind, releaseDraft } from './draftMachine'

// The draft contract the Karte (useMapDrawing) and the Plan (Whiteboard) both ask.

describe('finishKind (✓ «Fertig»)', () => {
  it('commits a Linie from 2 points and a Fläche from 3', () => {
    expect(finishKind('line', 2)).toBe('line')
    expect(finishKind('line', 1)).toBeNull()
    expect(finishKind('area', 3)).toBe('area')
    expect(finishKind('area', 2)).toBeNull()
  })

  it('has nothing to commit for any other tool', () => {
    expect(finishKind('symbol', 5)).toBeNull()
  })
})

describe('draftActive', () => {
  const nodes = { lineMode: 'nodes', areaMode: 'nodes' } as const
  it('enables ✓ for a committable node-mode draft of the armed tool only', () => {
    expect(draftActive('line', nodes, 2)).toBe(true)
    expect(draftActive('area', nodes, 2)).toBe(false)
    expect(draftActive('line', { ...nodes, lineMode: 'freehand' }, 5)).toBe(false)
    expect(draftActive('area', { ...nodes, areaMode: 'freehand' }, 5)).toBe(false)
  })
})

describe('releaseDraft (A6 tap-away)', () => {
  it('leaves an empty hand alone', () => {
    expect(releaseDraft({ from: 'line', lineMode: 'nodes', count: 0 })).toEqual({ type: 'keep' })
  })

  it('auto-commits a committable draft of the tool being left', () => {
    expect(releaseDraft({ from: 'line', lineMode: 'nodes', count: 2 })).toEqual({ type: 'commit', kind: 'line' })
    expect(releaseDraft({ from: 'area', lineMode: 'freehand', count: 3 })).toEqual({ type: 'commit', kind: 'area' })
  })

  it('discards a fragment below the minimum — with the toast, never silently', () => {
    expect(releaseDraft({ from: 'line', lineMode: 'nodes', count: 1 })).toEqual({ type: 'discard' })
    expect(releaseDraft({ from: 'area', lineMode: 'nodes', count: 2 })).toEqual({ type: 'discard' })
  })

  it('discards even a committable draft on a locked surface, which may no longer write', () => {
    expect(releaseDraft({ from: 'area', lineMode: 'nodes', count: 5, locked: true })).toEqual({ type: 'discard' })
  })

  it('drops a Freihand remnant silently — it dies with its tool', () => {
    expect(releaseDraft({ from: 'line', lineMode: 'freehand', count: 7 })).toEqual({ type: 'drop' })
  })

  it('keeps a draft that is not the left tool\'s — the undo re-arming its tool is no tap-away', () => {
    expect(releaseDraft({ from: 'pan', lineMode: 'nodes', count: 3 })).toEqual({ type: 'keep' })
  })
})
