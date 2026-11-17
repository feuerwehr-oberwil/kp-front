import { describe, expect, it } from 'vitest'
import { completeReminder, reopenReminder, type ReminderEvent } from './useReminders'
import { deriveReminders } from './reminders'
import { createUndoTimeline } from './undoTimeline'
import type { TimelineEvent } from '../types'

const copy = {
  doneLog: 'Erinnerung erledigt: {text}', pendenzDoneLog: 'Pendenz erledigt: {text}',
  reopenLog: 'Erinnerung wieder offen: {text}', pendenzReopenLog: 'Pendenz wieder offen: {text}',
}

/** An append-only Verlauf (newest first, the way the workspace stores it), with the open set
 *  derived from it exactly as useReminders does — so every step is checked against the record. */
function verlauf() {
  let seq = 0
  const rows: TimelineEvent[] = [{
    id: 'e0', t: '03:00', at: '2026-09-23T03:00:00.000Z', icon: 'type', text: 'Auftrag · Absperrmaterial holen', kind: 'journal',
    reminder: { op: 'created', id: 'p1', text: 'Absperrmaterial holen' },
  }]
  const append = (ev: ReminderEvent) => {
    seq += 1
    rows.unshift({ id: `e${seq}`, t: '03:00', at: `2026-09-23T03:${String(seq).padStart(2, '0')}:00.000Z`, icon: ev.icon, text: ev.text, kind: 'reminder', reminder: ev.reminder })
  }
  const isOpen = (id: string) => deriveReminders(rows).some((r) => r.id === id)
  return { rows, append, isOpen, item: () => deriveReminders(rows)[0] }
}

// «Erledigt» acts at once and sits on the ↶ timeline – no toast since owner pick 28, 17.11.2026
describe('completeReminder — «Erledigt» is one ↶ step', () => {
  it('closes at once, appending «Pendenz erledigt: …»', () => {
    const v = verlauf()
    const timeline = createUndoTimeline()
    completeReminder(v.item(), { ...v, copy, timeline })
    expect(v.isOpen('p1')).toBe(false)
    expect(v.rows[0]).toMatchObject({ text: 'Pendenz erledigt: Absperrmaterial holen', reminder: { op: 'done', id: 'p1' } })
    expect(timeline.canUndo()).toBe(true)
  })

  it('↶ reopens and ↷ closes again, each one appended row, and a stale step writes nothing', () => {
    const v = verlauf()
    const timeline = createUndoTimeline()
    completeReminder(v.item(), { ...v, copy, timeline })
    expect(timeline.undo().status).toBe('done')
    expect(v.isOpen('p1')).toBe(true)
    expect(v.rows[0]).toMatchObject({ icon: 'undo', reminder: { op: 'reopened', id: 'p1' } })
    expect(timeline.redo().status).toBe('done')
    expect(v.isOpen('p1')).toBe(false)
    expect(v.rows.map((r) => r.reminder?.op)).toEqual(['done', 'reopened', 'done', 'created'])
    timeline.undo()
    const before = v.rows.length
    // somebody else closed it meanwhile → ↷ is lost, not a second done row
    v.append({ icon: 'check', text: 'Pendenz erledigt: Absperrmaterial holen', reminder: { op: 'done', id: 'p1' } })
    expect(timeline.redo().status).toBe('lost')
    expect(v.rows).toHaveLength(before + 1)
  })

  it('an Erinnerung keeps its own word both ways', () => {
    const v = verlauf()
    const timeline = createUndoTimeline()
    const r = { ...v.item(), dueAt: '2026-09-23T04:00:00.000Z' }
    completeReminder(r, { ...v, copy, timeline })
    timeline.undo()
    expect(v.rows.slice(0, 2).map((x) => x.text)).toEqual(['Erinnerung wieder offen: Absperrmaterial holen', 'Erinnerung erledigt: Absperrmaterial holen'])
  })
})

// the Tafel's «Aufträge / Pendenzen» page un-ticks an «Erledigt» (05.11.2026)
describe('reopenReminder — un-ticking is the same act the other way', () => {
  it('appends «wieder offen», ↶ closes again, and an item already open writes nothing', () => {
    const v = verlauf()
    const timeline = createUndoTimeline()
    const item = v.item()
    reopenReminder(item, { ...v, copy, timeline })
    expect(v.rows).toHaveLength(1) // open already: nothing happened, nothing to take back
    expect(timeline.canUndo()).toBe(false)
    completeReminder(item, { ...v, copy })
    reopenReminder(item, { ...v, copy, timeline })
    expect(v.isOpen('p1')).toBe(true)
    expect(v.rows[0]).toMatchObject({ text: 'Pendenz wieder offen: Absperrmaterial holen', reminder: { op: 'reopened', id: 'p1' } })
    expect(timeline.undo().status).toBe('done')
    expect(v.isOpen('p1')).toBe(false)
    expect(v.rows.map((r) => r.reminder?.op)).toEqual(['done', 'reopened', 'done', 'created'])
  })
})
