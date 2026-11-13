// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { appConfig } from '../config/appConfig'
import { connectRemovalToasts, removedText, removeWithUndo } from './removalToast'
import { createUndoTimeline } from './undoTimeline'
import { useObjectStore } from './useObjectStore'
import { detachDrawings, withDetach } from './lineAttachments'
import type { TacticalObject } from './tacticalObjects'
import type { Drawing, Entity } from '../types'

const ui = vi.hoisted(() => ({ toasts: [] as { text: string; undo?: () => void; guard?: () => boolean }[] }))
vi.mock('./ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ui')>(),
  toast: (text: string) => { ui.toasts.push({ text }); return 0 },
  undoToast: (text: string, undo: () => void, guard: () => boolean) => { ui.toasts.push({ text, undo, guard }); return 0 },
}))

/** a closure step on a fresh timeline, the way a removal lays one */
function setup() {
  const timeline = createUndoTimeline()
  const undo = vi.fn(() => { timeline.undo() })
  const unplug = connectRemovalToasts({ peek: () => timeline.peekUndo(), undo })
  const step = (label: string) => timeline.push({ domain: 'karte', label, undo: () => true, redo: () => true })
  return { timeline, undo, unplug, step }
}

beforeEach(() => { ui.toasts.length = 0 })

// The delete rule (CTL.1 / FLOW.2, 13.11.2026): an undoable removal acts at once and its toast is
// the ↶ of THAT step – never of whatever happens to be on top when it is tapped.
describe('removeWithUndo', () => {
  it('acts, then offers the ↶ of the step the act laid', () => {
    const { undo, unplug, step } = setup()
    const out = removeWithUndo('TLF entfernt', () => { step('TLF entfernt'); return 'gone' })
    expect(out).toBe('gone')
    expect(ui.toasts.map((t) => t.text)).toEqual(['TLF entfernt'])
    expect(ui.toasts[0].guard?.()).toBe(true)
    ui.toasts[0].undo?.()
    expect(undo).toHaveBeenCalledTimes(1)
    unplug()
  })

  it('declines once another step stands on top of it — ↶ still reaches the removal', () => {
    const { timeline, unplug, step } = setup()
    removeWithUndo('TLF entfernt', () => step('TLF entfernt'))
    step('Feuer verschoben')
    expect(ui.toasts[0].guard?.()).toBe(false)
    expect(timeline.peekUndo()?.label).toBe('Feuer verschoben')
    unplug()
  })

  it('says nothing for an act that laid no step', () => {
    const { unplug } = setup()
    removeWithUndo('TLF entfernt', () => {})
    expect(ui.toasts).toEqual([])
    unplug()
  })

  it('names the Leitungen it set loose, singular and plural', () => {
    expect(removedText('TLF entfernt')).toBe('TLF entfernt')
    expect(removedText('TLF entfernt', 1)).toBe(appConfig.copy.removedToast.freedOne.replace('{what}', 'TLF entfernt'))
    expect(removedText('TLF entfernt', 2)).toBe('TLF entfernt, 2 Leitungen gelöst')
  })
})

// What the confirm used to warn about – the Leitungen on a symbol – comes back with the ONE store
// step the toast takes back: the object, both line ends' attachments and a docked placard's bond.
describe('a symbol with Leitungen, removed and taken back', () => {
  const tlf: Entity = { id: 'tlf', kind: 'symbol', layer: 'taktisch', symbol: 'VKF Fahrzeug', label: 'TLF', coord: [7.55, 47.52] }
  const placard: Entity = { id: 'gt', kind: 'symbol', layer: 'taktisch', symbol: 'Gefahrentafel', coord: [7.5501, 47.5201], dockedTo: 'tlf' }
  const hose = (id: string, endpoint: 'start' | 'end'): Drawing => ({
    id, kind: 'line', coords: [[7.549, 47.519], [7.55, 47.52]],
    [endpoint === 'start' ? 'startAttachment' : 'endAttachment']: { target: { kind: 'object', id: 'tlf' }, routing: 'direct' },
  } as Drawing)
  const init: TacticalObject[] = [
    { id: 'tlf', entity: tlf }, { id: 'gt', entity: placard },
    { id: 'h1', drawing: hose('h1', 'end') }, { id: 'h2', drawing: hose('h2', 'start') },
  ]

  it('one ↶ (the toast\'s) restores the symbol, both attachments and the placard bond', () => {
    const timeline = createUndoTimeline()
    const hook = renderHook(() => useObjectStore(init, false, {
      getFits: () => new Map(), defaultLayer: 'taktisch', fitsVersion: 0,
      onCheckpoint: (step) => timeline.push({ domain: 'karte', label: 'x', step, undo: () => hook.result.current.undo(step), redo: () => hook.result.current.redo(step) }),
    }))
    const unplug = connectRemovalToasts({ peek: () => timeline.peekUndo(), undo: () => { act(() => { timeline.undo() }) } })
    const before = hook.result.current.objects
    // useMapActions · deleteEntity's write, verbatim in what it folds
    const lines = hook.result.current.doc.drawings
    const released = detachDrawings(lines, (_, __, a) => (a.target.kind === 'object' && a.target.id === 'tlf' ? tlf.coord : null))
    expect(released.size).toBe(2)
    act(() => {
      removeWithUndo(removedText('TLF entfernt', released.size), () => hook.result.current.commit((d) => ({
        ...d,
        entities: d.entities.filter((e) => e.id !== 'tlf').map((e) => (e.dockedTo === 'tlf' ? { ...e, dockedTo: undefined } : e)),
        drawings: d.drawings.map((dr) => withDetach(dr, released)),
      })))
    })
    const doc = hook.result.current.doc
    expect(doc.entities.map((e) => e.id)).toEqual(['gt'])
    expect(doc.drawings.every((d) => !d.startAttachment && !d.endAttachment)).toBe(true)
    expect(ui.toasts.map((t) => t.text)).toEqual(['TLF entfernt, 2 Leitungen gelöst'])
    ui.toasts[0].undo?.()
    expect(hook.result.current.objects).toEqual(before)
    unplug()
  })
})
