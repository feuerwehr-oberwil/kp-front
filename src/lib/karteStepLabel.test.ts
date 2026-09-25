// A Karte undo step is named by what it did (staging 3am R3-3, 25.09.2026) — the store-diff half
// of the naming (lib/karteStepLabel); the Verlauf-row half is wired in IncidentWorkspace and
// pinned in IncidentWorkspace.grundgeruest.test.tsx.

import { describe, expect, it } from 'vitest'
import { karteStepLabel } from './karteStepLabel'
import { createUndoTimeline } from './undoTimeline'
import type { TacticalObject } from './tacticalObjects'
import type { Drawing, Entity } from '../types'

const kp = { id: 'k', entity: { id: 'k', kind: 'symbol', layer: 'op', coord: [8, 47], symbol: 'VKF KP Front', label: 'KP Front' } as Entity }
const line = { id: 'l', drawing: { id: 'l', kind: 'line', coords: [[8, 47], [8.001, 47.001]], arrow: true, marker: 'Z' } as unknown as Drawing }
const moved = (o: TacticalObject): TacticalObject => ({ ...o, entity: { ...o.entity!, coord: [8.0005, 47.0005] } })

describe('karteStepLabel', () => {
  it('names one object set, drawn or removed', () => {
    expect(karteStepLabel([], [kp])).toBe('KP Front gesetzt')
    expect(karteStepLabel([], [line])).toBe('Zufahrt gezeichnet')
    // taken off the picture is «entfernt» — «gelöscht» means extinguished (#226)
    expect(karteStepLabel([kp], [])).toBe('KP Front entfernt')
  })

  it('a position-only change is a move; anything else is a change', () => {
    expect(karteStepLabel([kp], [moved(kp)])).toBe('KP Front verschoben')
    const recoloured = { ...kp, entity: { ...kp.entity!, color: '#e8392b' } }
    expect(karteStepLabel([kp], [recoloured])).toBe('KP Front geändert')
  })

  it('several objects are counted; nothing changed is no name', () => {
    expect(karteStepLabel([kp], [moved(kp), line])).toBe('2 Objekte geändert')
    expect(karteStepLabel([kp, line], [kp, line])).toBeNull()
    // a copy with equal content is no change either
    expect(karteStepLabel([kp], [{ ...kp }])).toBeNull()
  })
})

describe('undoTimeline · rename', () => {
  it('names a pushed entry after the fact, on either stack', () => {
    const t = createUndoTimeline()
    const h = t.push({ domain: 'karte', label: 'Änderung auf der Karte', undo: () => true, redo: () => true })
    h.rename('KP Front verschoben')
    expect(t.peekUndo()?.label).toBe('KP Front verschoben')
    t.undo()
    h.rename('KP Front gesetzt')
    expect(t.peekRedo()?.label).toBe('KP Front gesetzt')
    // the handle is still the dropper it always was
    h()
    expect(t.canRedo()).toBe(false)
  })
})
