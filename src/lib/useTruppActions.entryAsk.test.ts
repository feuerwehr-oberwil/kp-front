import { expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import type { Entity, Drawing, Trupp } from '../types'
import { useTruppActions } from './useTruppActions'
import { createUndoTimeline } from './undoTimeline'
import { confirmDialog } from './ui'

vi.mock('./ui', async (load) => ({
  ...await load<typeof import('./ui')>(),
  confirmDialog: vi.fn(),
}))

// hunt 24.11.2026, frontend-state F1: tablet A leaves «Einrücken?» open, tablet B enters the crew
// and logs a pressure; A's late answer and its ↶ used to put the crew back on standby over B's
// records. The answer now reads the crew live and must still find it awaiting its entry.
const crew: Trupp = { id: 'C', name: 'Crew', entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'angemeldet' }
const marker: Entity = { id: 'M', kind: 'team', layer: 'einheiten', truppId: 'C', coord: [7, 47] }

function fixture(initial: Trupp, lines: Drawing[] = []) {
  let trupps = [initial]
  let drawings = lines
  const timeline = createUndoTimeline()
  function apply<T>(value: T, update: SetStateAction<T>): T {
    return typeof update === 'function' ? (update as (x: T) => T)(value) : update
  }
  function useCurrentActions() {
    return useTruppActions({
      trupps, drawings, entities: [marker], board: {}, objects: [], building: null,
      setTrupps: (update) => { trupps = apply(trupps, update) },
      setDocRaw: (update) => { drawings = apply({ entities: [marker], drawings }, update).drawings },
      liveTrupps: () => trupps, undoTimeline: timeline, setBoard: vi.fn(), log: vi.fn(),
      emit: vi.fn(), logPlan: vi.fn(), setMode: vi.fn(), setActivePlanId: vi.fn(), setPanel: vi.fn(),
      setPlanFocus: vi.fn(), mapCenter: () => [7, 47], focusMapEntity: vi.fn(), focusMapDrawing: vi.fn(),
    })
  }
  return { actions: useCurrentActions, timeline, current: () => trupps[0], hydrate: (t: Trupp) => { trupps = [t] } }
}

it('an entry question answered after a remote entry and pressure report cannot undo those records', async () => {
  let accept!: () => void
  vi.mocked(confirmDialog).mockImplementationOnce(() => new Promise<boolean>((resolve) => { accept = () => resolve(true) }))
  const b = fixture(crew)
  const question = b.actions().askTruppEntry('C')
  const at = '2026-11-24T03:00:00Z'
  const newer: Trupp = { ...crew, status: 'aktiv', entryTime: at, lastContactTime: at,
    readings: [{ t: at, bar: 240, kind: 'pressure' }], lastPressureBar: 240 }
  b.hydrate(newer)
  b.actions()
  accept()
  await question
  b.timeline.undo()
  expect(b.current()).toEqual(newer)
})
