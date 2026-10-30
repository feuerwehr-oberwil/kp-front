// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { REPORT_COALESCE_MS, changedReportFields, foldsIntoPrevious, keepMachineFields, reportStep } from './reportUndo'
import { useUndoableSlice } from './useUndoableSlice'
import { createUndoTimeline } from './undoTimeline'
import type { ReportMeta } from './workspace'

/**
 * Field report 18.09.2026: «Rettungen eingetragen, Zahl war falsch, Rückgängig macht nichts.»
 *
 * The Einsatzrapport was the last record surface off the one timeline. It could not simply join
 * it the way Mittel and the Checklisten did, because every textarea on it persists on every
 * KEYSTROKE — so what is pinned here is both halves: that a step exists at all, and that typing
 * a Kurzbericht is ONE of them rather than forty.
 */

describe('reportStep — what one step back on the Rapport is', () => {
  it('sees nothing in a write that changed nothing', () => {
    const m: ReportMeta = { summary: 'Brand Küche', gerettete: { personen: 2 } }
    expect(reportStep(m, { ...m, gerettete: { personen: 2 } })).toBeNull()
    expect(changedReportFields(m, { ...m })).toEqual([])
  })

  it('lays no step for the app\'s own bookkeeping — a print is not an edit', () => {
    const m: ReportMeta = { summary: 'Brand Küche' }
    expect(reportStep(m, { ...m, reportMadeAt: '2026-09-18T10:00:00.000Z' })).toBeNull()
    expect(reportStep(m, { ...m, printJob: { id: 'j1', at: '2026-09-18T10:00:00.000Z' } })).toBeNull()
    // …but the same write WITH an operator edit in it is a step, and it is the edit's step
    expect(reportStep(m, { ...m, summary: 'Brand Küche EG', reportMadeAt: 'x' })?.structural).toBe(false)
  })

  it('reads typing as one repeating key, and a cleared value as its own step', () => {
    const a: ReportMeta = { summary: 'Bra' }
    const b: ReportMeta = { summary: 'Brand' }
    expect(reportStep(a, b)).toEqual({ key: 'summary', structural: false })
    // the ✕ on a Stepper / «Entfällt»: something DISAPPEARED
    const c: ReportMeta = { gerettete: { personen: 2 }, kontaktperson: 'Meier' }
    const d: ReportMeta = { kontaktperson: 'Meier', geretteteNone: true }
    expect(reportStep(c, d)).toEqual({ key: 'gerettete+geretteteNone', structural: true })
  })

  it('makes a row appearing or going its own step, and keys it by the length', () => {
    const one: ReportMeta = { partnerContacts: [{ org: 'Sanität' }] }
    const two: ReportMeta = { partnerContacts: [{ org: 'Sanität' }, { org: 'Polizei' }] }
    expect(reportStep(one, two)).toEqual({ key: 'partnerContacts#2', structural: true })
    // …and editing the row that was just added is a DIFFERENT thing, so it can never merge
    // backwards into the add: the key carries the length, and the add was structural anyway.
    const edited: ReportMeta = { partnerContacts: [{ org: 'Sanität' }, { org: 'Polizei', note: 'Verkehr' }] }
    expect(reportStep(two, edited)).toEqual({ key: 'partnerContacts#2', structural: false })
    // unticking one deletes its Bemerkung with it — exactly the press somebody wants back
    expect(reportStep(edited, one)).toEqual({ key: 'partnerContacts#1', structural: true })
  })
})

describe('foldsIntoPrevious — a burst of typing is one step', () => {
  const typing = { key: 'summary', structural: false }
  it('folds the same field inside the window and opens a new step outside it', () => {
    expect(foldsIntoPrevious({ key: 'summary', at: 1000 }, typing, 1000 + REPORT_COALESCE_MS)).toBe(true)
    expect(foldsIntoPrevious({ key: 'summary', at: 1000 }, typing, 1001 + REPORT_COALESCE_MS)).toBe(false)
  })
  it('never folds across fields, and never folds a structural write', () => {
    expect(foldsIntoPrevious({ key: 'remarks', at: 1000 }, typing, 1100)).toBe(false)
    expect(foldsIntoPrevious({ key: 'gerettete', at: 1000 }, { key: 'gerettete', structural: true }, 1100)).toBe(false)
  })
  it('folds nothing when no step stands', () => {
    expect(foldsIntoPrevious(null, typing, 1100)).toBe(false)
  })
})

describe('keepMachineFields — what a step back does NOT touch', () => {
  it('restores the operator\'s Rapport and leaves the app\'s own bookkeeping standing', () => {
    const restored: ReportMeta = { summary: 'Brand', reportMadeAt: '2026-09-18T09:00:00.000Z' }
    const live: ReportMeta = { summary: 'Brand Küche', printJob: { id: 'j1', at: '2026-09-18T10:00:00.000Z' } }
    expect(keepMachineFields(restored, live)).toEqual({ summary: 'Brand', printJob: live.printJob })
  })
  it('drops a machine field the live state no longer has', () => {
    const restored: ReportMeta = { summary: 'Brand', printJob: { id: 'j1', at: '2026-09-18T10:00:00.000Z' } }
    expect(keepMachineFields(restored, { summary: 'x' })).toEqual({ summary: 'Brand' })
  })
})

/** The real wiring: the slice, the classification and the one global timeline, exactly as
 *  IncidentWorkspace puts them together (`reportSet`). */
function useRapport(readOnly = false) {
  const timeline = useState(() => createUndoTimeline())[0]
  const [meta, setMeta] = useState<ReportMeta>({})
  // the machine's bookkeeping rides OUTSIDE the snapshots — see keepMachineFields
  const hist = useUndoableSlice(meta, setMeta, readOnly, keepMachineFields)
  // ⚠️ Through a ref, like the real caller: the entry outlives the render that pushed it, and a
  // captured `hist` would step a stack that has moved on.
  const histRef = useRef(hist)
  histRef.current = hist
  const last = useState(() => ({ current: null as { key: string; at: number } | null }))[0]
  const save = (next: ReportMeta, now: number) => {
    const laid = hist.set(next, {
      coalesce: (prev, n) => {
        const step = reportStep(prev, n)
        if (!step) { last.current = null; return true }
        const fold = foldsIntoPrevious(last.current, step, now)
        last.current = { key: step.key, at: now }
        return fold
      },
    })
    // …and every ↶ ↷ closes the open fold window, exactly as the real entry does
    if (laid) timeline.push({
      domain: 'rapport',
      label: 'Rapport',
      undo: () => { last.current = null; return !!histRef.current.undo() },
      redo: () => { last.current = null; return !!histRef.current.redo() },
    })
  }
  return { meta, save, timeline }
}

describe('the Rapport on the one timeline', () => {
  it('takes back a Rettung — add, correct and «Keine» are three steps', () => {
    const { result } = renderHook(() => useRapport())
    const at = 100_000
    act(() => { result.current.save({ gerettete: { personen: 1 } }, at) })
    // a correction two seconds later is the SAME step — a stepper tapped twice is one act
    act(() => { result.current.save({ gerettete: { personen: 3 } }, at + 2000) })
    expect(result.current.meta.gerettete).toEqual({ personen: 3 })
    // «Keine»: deletes the count, and is its own step however fast it followed
    act(() => { result.current.save({ geretteteNone: true }, at + 2100) })
    expect(result.current.meta).toEqual({ geretteteNone: true })

    act(() => { result.current.timeline.undo() })
    expect(result.current.meta.gerettete).toEqual({ personen: 3 })
    act(() => { result.current.timeline.undo() })
    expect(result.current.meta).toEqual({})
    expect(result.current.timeline.canUndo()).toBe(false)
    // …and forward again, both of them
    act(() => { result.current.timeline.redo() })
    expect(result.current.meta.gerettete).toEqual({ personen: 3 })
    act(() => { result.current.timeline.redo() })
    expect(result.current.meta).toEqual({ geretteteNone: true })
  })

  it('gives back the whole Kurzbericht, not one letter', () => {
    const { result } = renderHook(() => useRapport())
    const at = 100_000
    const text = 'Brand Küche'
    for (let i = 1; i <= text.length; i++) {
      // 80 ms apart — a human typing
      act(() => { result.current.save({ summary: text.slice(0, i) }, at + i * 80) })
    }
    expect(result.current.meta.summary).toBe(text)
    act(() => { result.current.timeline.undo() })
    expect(result.current.meta.summary).toBeUndefined()
    expect(result.current.timeline.canUndo()).toBe(false)
  })

  it('opens a second step once the typing paused past the window', () => {
    const { result } = renderHook(() => useRapport())
    act(() => { result.current.save({ remarks: 'Ölbindemittel' }, 100_000) })
    act(() => { result.current.save({ remarks: 'Ölbindemittel gestreut' }, 100_000 + REPORT_COALESCE_MS + 1) })
    act(() => { result.current.timeline.undo() })
    expect(result.current.meta.remarks).toBe('Ölbindemittel')
  })

  it('never lets a print stamp become a step of its own', () => {
    const { result } = renderHook(() => useRapport())
    act(() => { result.current.save({ summary: 'Fehlalarm' }, 100_000) })
    act(() => { result.current.save({ summary: 'Fehlalarm', reportMadeAt: '2026-09-18T10:00:00.000Z' }, 200_000) })
    expect(result.current.timeline.canUndo()).toBe(true)
    act(() => { result.current.timeline.undo() })
    expect(result.current.meta.summary).toBeUndefined()
    expect(result.current.timeline.canUndo()).toBe(false)
  })

  it('keeps an outstanding print job across a ↶ — the machine\'s fields are not the edit', () => {
    const { result } = renderHook(() => useRapport())
    const job = { id: 'j1', at: '2026-09-18T10:00:00.000Z' }
    act(() => { result.current.save({ summary: 'Brand' }, 100_000) })
    // the print is queued (no step of its own), then the sentence grows in the SAME step
    act(() => { result.current.save({ summary: 'Brand', printJob: job }, 100_100) })
    act(() => { result.current.save({ summary: 'Brand Küche', printJob: job }, 100_200) })
    act(() => { result.current.timeline.undo() })
    // the sentence goes back, the queued job stays — settlePrintJob still has something to stamp
    expect(result.current.meta.summary).toBe('Brand')
    expect(result.current.meta.printJob).toEqual(job)
    // …and all the way back: still the operator's edits that move, never the print
    act(() => { result.current.timeline.undo() })
    expect(result.current.meta.summary).toBeUndefined()
    expect(result.current.meta.printJob).toEqual(job)
  })

  it('typing right after a ↶ is its own step — the fold window does not reach across it', () => {
    const { result } = renderHook(() => useRapport())
    act(() => { result.current.save({ summary: 'Brand' }, 100_000) })
    act(() => { result.current.timeline.undo() })
    expect(result.current.meta.summary).toBeUndefined()
    // same field, well inside the burst window: it must NOT fold into the step now on the redo
    // stack, or the new typing would have no way back and the next ↷ would overwrite it
    act(() => { result.current.save({ summary: 'Fehlalarm' }, 100_500) })
    expect(result.current.timeline.canUndo()).toBe(true)
    act(() => { result.current.timeline.undo() })
    expect(result.current.meta.summary).toBeUndefined()
  })

  it('a session that may not write the record lays no step down', () => {
    const { result } = renderHook(() => useRapport(true))
    act(() => { result.current.save({ summary: 'x' }, 100_000) })
    expect(result.current.timeline.canUndo()).toBe(false)
  })
})
