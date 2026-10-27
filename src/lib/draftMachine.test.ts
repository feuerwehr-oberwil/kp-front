import { describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'
import { askOpenDraft, draftActive, finishKind, releaseDraft } from './draftMachine'

// the one question goes through the app's confirm; recorded here, answered with `next`
const answer = vi.hoisted(() => ({ next: false as boolean | 'alt', asked: [] as { title?: string; confirmLabel?: string; altLabel?: string; cancelLabel?: string }[] }))
vi.mock('./ui', () => ({ confirmDialog: (o: (typeof answer.asked)[number]) => { answer.asked.push(o); return Promise.resolve(answer.next) } }))

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

describe('releaseDraft (leaving an open drawing)', () => {
  it('leaves an empty hand alone', () => {
    expect(releaseDraft({ from: 'line', lineMode: 'nodes', count: 0 })).toEqual({ type: 'keep' })
  })

  it('asks about a committable draft of the tool being left (27.10.2026, replaced the A6 auto-commit)', () => {
    expect(releaseDraft({ from: 'line', lineMode: 'nodes', count: 2 })).toEqual({ type: 'ask', kind: 'line' })
    expect(releaseDraft({ from: 'area', lineMode: 'freehand', count: 3 })).toEqual({ type: 'ask', kind: 'area' })
  })

  it('commits instead when nobody can answer – the document goes away under it', () => {
    expect(releaseDraft({ from: 'line', lineMode: 'nodes', count: 2, ask: false })).toEqual({ type: 'commit', kind: 'line' })
  })

  it('drops a fragment below the minimum silently – nothing worth asking about', () => {
    expect(releaseDraft({ from: 'line', lineMode: 'nodes', count: 1 })).toEqual({ type: 'drop' })
    expect(releaseDraft({ from: 'area', lineMode: 'nodes', count: 2 })).toEqual({ type: 'drop' })
  })

  it('discards a committable draft on a locked surface, which may no longer write – with the toast', () => {
    expect(releaseDraft({ from: 'area', lineMode: 'nodes', count: 5, locked: true })).toEqual({ type: 'discard' })
  })

  it('drops a Freihand remnant silently — it dies with its tool', () => {
    expect(releaseDraft({ from: 'line', lineMode: 'freehand', count: 7 })).toEqual({ type: 'drop' })
  })

  it('keeps a draft that is not the left tool\'s — «Weiterzeichnen» re-arming its tool is no leave', () => {
    expect(releaseDraft({ from: 'pan', lineMode: 'nodes', count: 3 })).toEqual({ type: 'keep' })
  })
})

describe('askOpenDraft', () => {
  const C = appConfig.copy.toolDock

  it('names the drawing and maps the three buttons; dismissing is «Weiterzeichnen»', async () => {
    answer.next = true
    expect(await askOpenDraft('Wand')).toBe('save')
    expect(answer.asked[0]).toMatchObject({ title: C.openTitle.replace('{name}', 'Wand'), confirmLabel: C.openSave, altLabel: C.openDiscard, cancelLabel: C.openContinue })
    answer.next = 'alt'
    expect(await askOpenDraft('Linie')).toBe('discard')
    answer.next = false
    expect(await askOpenDraft('Linie')).toBe('continue')
  })
})
