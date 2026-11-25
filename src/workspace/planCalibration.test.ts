import { describe, expect, it, vi } from 'vitest'
import type { SetStateAction } from 'react'
import type { PlanScale } from '../lib/planScale'
import type { PlanScales } from '../lib/workspace'
import { createUndoTimeline } from '../lib/undoTimeline'
import { recordKey } from '../lib/undoKeys'
import { calibratePlan } from './planCalibration'

// hunt 24.11.2026, frontend-state F9: a hand calibration is a one-shot on `planScale:<planId>`,
// so another device's newer scale for that plan takes the toast's «Rückgängig» away with the step

const ours: PlanScale = { mPerU: 2, refM: 10, ar: 1 }
const theirs: PlanScale = { mPerU: 3, refM: 30, ar: 1 }

function fixture(initial: PlanScales) {
  let scales = initial
  const timeline = createUndoTimeline()
  const setPlanScale = (u: SetStateAction<PlanScales>) => { scales = typeof u === 'function' ? u(scales) : u }
  const rows = { undo: vi.fn(), redo: vi.fn() }
  const takeBack = calibratePlan('p', ours, {
    before: initial.p ?? null, setPlanScale, label: 'Massstab kalibriert', rows,
    // the shape of IncidentWorkspace · rememberOneShot
    remember: (domain, label, restore, reapply, touches) => timeline.push({ domain, label, touches,
      undo: () => { restore(); rows.undo(); return true }, redo: () => { reapply(); rows.redo(); return true } }),
  })
  return { timeline, takeBack, rows, scales: () => scales, setPlanScale }
}

describe('calibratePlan', () => {
  it('a first calibration is one ↶ step that takes the plan back to none, and ↷ puts it again', () => {
    const f = fixture({})
    expect(f.scales()).toEqual({ p: ours })
    f.timeline.undo()
    expect(f.scales()).toEqual({})
    f.timeline.redo()
    expect(f.scales()).toEqual({ p: ours })
  })

  it('the toast takes the step back while it stands, and the ↶ has nothing left of it', () => {
    const f = fixture({ p: theirs })
    expect(f.takeBack()).toBe(true)
    expect(f.scales()).toEqual({ p: theirs })
    expect(f.rows.undo).toHaveBeenCalledTimes(1)
    expect(f.timeline.canUndo()).toBe(false)
  })

  it('a newer scale from another device makes the toast decline instead of deleting it', () => {
    const f = fixture({})
    // B's calibration of the same plan lands through the merge
    f.setPlanScale((m) => ({ ...m, p: theirs }))
    f.timeline.rebase([recordKey('planScale', 'p')])
    expect(f.takeBack()).toBe(false)
    expect(f.scales()).toEqual({ p: theirs })
  })
})
