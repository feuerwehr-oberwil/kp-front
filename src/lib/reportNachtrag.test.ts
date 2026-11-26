import { describe, expect, it } from 'vitest'
import { reportBeforeNachtrag } from './reportNachtrag'
import type { TimelineEvent } from '../types'

// UX pick B3·18 (25.11.2026): after «Wieder öffnen» any hand-written change makes the paper old;
// while the Einsatz runs, M5 · A stands (only a Rapport field does, ReportPreflight · persist).
const row = (id: string, at: string, more: Partial<TimelineEvent> = {}): TimelineEvent => ({ id, t: '', at, icon: 'pen', text: id, ...more })
const closed = row('sys1', '2026-11-25T13:33:00Z', { lifecycle: 'closed', text: 'Einsatz abgeschlossen' })
const reopened = row('sys2', '2026-11-25T13:40:00Z', { lifecycle: 'reopened', text: 'Einsatz wiedereröffnet (Nachtrag)' })
const pdf = '2026-11-25T13:30:00Z'

describe('reportBeforeNachtrag', () => {
  it('a hand-written row after the reopen makes the paper of before it old', () => {
    expect(reportBeforeNachtrag(pdf, [closed, reopened, row('j1', '2026-11-25T13:45:00Z')])).toBe(true)
  })
  it('a reopen alone, or only machine rows after it, leave the paper current', () => {
    expect(reportBeforeNachtrag(pdf, [closed, reopened])).toBe(false)
    expect(reportBeforeNachtrag(pdf, [closed, reopened,
      row('azro-sys2-t1', '2026-11-25T13:40:01Z'), row('obs', '2026-11-25T13:41:00Z', { writtenAt: '2026-11-25T13:41:00Z' })])).toBe(false)
  })
  it('a PDF made after the change answers it', () => {
    expect(reportBeforeNachtrag('2026-11-25T13:50:00Z', [closed, reopened, row('j1', '2026-11-25T13:45:00Z')])).toBe(false)
  })
  it('a running Einsatz that was never closed keeps M5 · A: rows do not make the paper old', () => {
    expect(reportBeforeNachtrag(pdf, [row('j1', '2026-11-25T13:45:00Z')])).toBe(false)
  })
  it('no paper, nothing to be old', () => {
    expect(reportBeforeNachtrag(undefined, [closed, reopened, row('j1', '2026-11-25T13:45:00Z')])).toBe(false)
  })
})
