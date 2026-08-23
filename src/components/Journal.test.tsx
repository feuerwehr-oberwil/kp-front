// @vitest-environment jsdom
import { StrictMode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { Journal } from './Journal'
import type { TimelineEvent } from '../types'
import type { OpenReminder } from '../lib/reminders'

afterEach(cleanup)

const row = (id: string, at: number, text: string): TimelineEvent => ({
  id, t: '', at: new Date(at).toISOString(), text, icon: 'type', kind: 'journal',
})

// newest first, the order the Verlauf renders in
const events = [
  row('r3', 1_060_000, 'Feuer aus'),
  row('r2', 1_040_000, 'Trupp 1 im Einsatz'),
  row('r1', 1_010_000, 'Erkundung Nordseite läuft'),
]

const cls = (id: string) => document.querySelector(`[data-ev="${id}"]`)?.className ?? ''

/** ⚠️ Rendered in <StrictMode>, like the app itself (main.tsx). React runs every effect twice in
 *  development — effect, cleanup, effect — and an «already done» ref written on the first run
 *  makes the second run a no-op. That is not a hypothetical: the landing below shipped with such
 *  a guard and was dead code in dev, so «im Verlauf» opened the Verlauf and never scrolled. A
 *  test that mounts plainly cannot see it. */
function setup(over: Partial<React.ComponentProps<typeof Journal>> = {}) {
  const props: React.ComponentProps<typeof Journal> = {
    events, plans: [], onSelect: vi.fn(), onClose: vi.fn(), ...over,
  }
  render(<StrictMode><Journal {...props} /></StrictMode>)
  return props
}

describe('Journal · landing on one row («im Verlauf» on the Wiedergabe caption)', () => {
  it('⚠️ survives StrictMode’s double mount — the landing must not be a one-shot', async () => {
    setup({ landOn: { id: 'r2', nonce: 1 } })
    await waitFor(() => expect(cls('r2')).toContain('jr-flash'))
    expect(cls('r1')).not.toContain('jr-flash')
    expect(cls('r3')).not.toContain('jr-flash')
  })
})

describe('Journal · alongside a Wiedergabe', () => {
  it('⚠️ dims the rows the playhead has not reached — they had not been written yet', () => {
    setup({ replayAtMs: 1_040_000 })
    expect(cls('r3')).toContain('jr-future')
    // the row the playhead stands in, and everything before it, are the present and the past
    expect(cls('r2')).not.toContain('jr-future')
    expect(cls('r1')).not.toContain('jr-future')
  })

  it('a row sets the MOMENT instead of flying to a place', () => {
    const onSeekTo = vi.fn()
    const onSelect = vi.fn()
    setup({ replayAtMs: 1_040_000, onSeekTo, onSelect })
    fireEvent.click(screen.getByText('Erkundung Nordseite läuft'))
    expect(onSeekTo).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('…and with no replay running a row that has no place stays inert', () => {
    const onSelect = vi.fn()
    setup({ onSelect })
    fireEvent.click(screen.getByText('Erkundung Nordseite läuft'))
    expect(onSelect).not.toHaveBeenCalled()
  })
})

// ── Pendenzen ───────────────────────────────────────────────────────────────────────────────
// jsdom has no layout and no ResizeObserver; the block measures itself to decide whether
// «Aufklappen» is needed, which is a question only a real browser can answer. The stub keeps the
// ref callback from throwing — everything asserted below is about content and actions, not size.
class RO { observe() {} unobserve() {} disconnect() {} }
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= RO

const pendenz = (id: string, text: string, over: Partial<OpenReminder> = {}): OpenReminder => ({
  id, rowId: `row-${id}`, text, createdAt: new Date(1_000_000).toISOString(), notes: [], ...over,
})

describe('Journal · the Pendenzen block', () => {
  const open = [
    pendenz('p1', 'Absperrmaterial Kreuzung', { urgent: true }),
    pendenz('p2', 'Polizei aufgeboten', {
      notes: [
        { rowId: 'n1', text: 'Verkehrsdienst eingerichtet', at: new Date(1_020_000).toISOString() },
        { rowId: 'n2', text: 'Umleitung signalisiert', at: new Date(1_030_000).toISOString() },
      ],
    }),
  ]

  // ⚠️ EVERY item and EVERY Meldung. The block was capped at four rows once, with «12 offen» in
  // its own heading — and showed one Meldung of three, which read as the whole story.
  it('shows every open item with its whole thread', () => {
    setup({ openReminders: open })
    expect(screen.getByText('Absperrmaterial Kreuzung')).toBeTruthy()
    expect(screen.getByText('Polizei aufgeboten')).toBeTruthy()
    expect(screen.getByText('Verkehrsdienst eingerichtet')).toBeTruthy()
    expect(screen.getByText('Umleitung signalisiert')).toBeTruthy()
  })

  it('tapping an item writes a Meldung on it; the ring ticks it off', () => {
    const onReminderNote = vi.fn()
    const onReminderDone = vi.fn()
    setup({ openReminders: open, onReminderNote, onReminderDone })
    fireEvent.click(screen.getByText('Absperrmaterial Kreuzung'))
    expect(onReminderNote).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))
    fireEvent.click(document.querySelectorAll('.jr-pinned-row .jr-rem')[0])
    expect(onReminderDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))
  })

  // ⚠️ The time column says WHEN IT WAS RAISED — an Auftrag has no Fälligkeit, because nobody
  // checks in on a Schadenplatz. One tap swaps the WHOLE column; a half-clock/half-age column
  // cannot be read.
  it('swaps the whole time column between the clock and the age', () => {
    setup({ openReminders: open })
    const times = () => [...document.querySelectorAll('.jr-when')].map((e) => e.textContent ?? '')
    expect(times().every((t) => /^\d{2}:\d{2}$/.test(t))).toBe(true)
    fireEvent.click(document.querySelector('.jr-when')!)
    expect(times().every((t) => /^\d{2}:\d{2}$/.test(t))).toBe(false)
    expect(times()).toHaveLength(open.length)
  })

  // ⚠️ The ring ticks off in BOTH places, and it is the same call in both — one appended `done`
  // row, never a mutation of the row that raised the item. The row's ring was taken away once on
  // the argument that two controls did the same thing; what was actually wrong was that they were
  // two different SHAPES. Same ring, same gesture, same handler.
  it('ticks the same item off from the log row as from the block', () => {
    const onReminderDone = vi.fn()
    setup({
      events: [{ id: 'e1', t: '', at: new Date(1_000_000).toISOString(), text: 'Absperrmaterial Kreuzung',
        icon: 'type', kind: 'journal', reminder: { op: 'created', id: 'p1', text: 'Absperrmaterial Kreuzung' } }],
      openReminders: [pendenz('p1', 'Absperrmaterial Kreuzung')],
      onReminderDone,
    })
    fireEvent.click(document.querySelector('.hist-ev .jr-ic-tick')!)
    expect(onReminderDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))
    fireEvent.click(document.querySelector('.jr-pinned-row .jr-rem')!)
    expect(onReminderDone).toHaveBeenCalledTimes(2)
    expect(onReminderDone).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'p1' }))
  })

  // …and a row that is already closed is a FACT, not a switch: its green ring says what happened,
  // and there is nothing left to tick.
  it('a closed item’s ring is not a control', () => {
    setup({
      events: [{ id: 'e1', t: '', at: new Date(1_000_000).toISOString(), text: 'Absperrmaterial Kreuzung',
        icon: 'type', kind: 'journal', reminder: { op: 'created', id: 'p1', text: 'Absperrmaterial Kreuzung' } }],
      openReminders: [],
      onReminderDone: vi.fn(),
    })
    expect(document.querySelector('.jr-ring-done')).toBeTruthy()
    expect(document.querySelector('.jr-ic-tick')).toBeNull()
  })

  // ⚠️ A Meldung stands where it happened, among everything else — so it has to name the item it
  // answers, or three «Pendenz» rows in a row are three unrelated sentences.
  it('a Meldung row in the log names the item it belongs to, and jumps to it', () => {
    setup({
      events: [
        { id: 'n1', t: '', at: new Date(1_020_000).toISOString(), text: 'Fahrzeug unterwegs',
          icon: 'type', kind: 'journal', reminder: { op: 'note', id: 'p1' } },
        { id: 'e1', t: '', at: new Date(1_000_000).toISOString(), text: 'Auftrag · Absperrmaterial Kreuzung',
          icon: 'type', kind: 'journal', reminder: { op: 'created', id: 'p1', text: 'Absperrmaterial Kreuzung' } },
      ],
      openReminders: [pendenz('p1', 'Absperrmaterial Kreuzung')],
    })
    const ref = document.querySelector('.jr-note-on') as HTMLButtonElement
    expect(ref.textContent).toContain('Absperrmaterial Kreuzung')
    fireEvent.click(ref)
    expect(cls('e1')).toContain('jr-flash')
  })
})

// ⚠️ The row's text is the ONE string the Verlauf, the Rapport and the hash chain all read
// (lib/journalEntry). The classification column changed what is DRAWN around it, and this pins
// that it changed nothing about the string itself.
describe('Journal · the classification column', () => {
  const auftrag: TimelineEvent = {
    id: 'a1', t: '', at: new Date(1_000_000).toISOString(), icon: 'type', kind: 'journal',
    entryType: 'auftrag', text: 'Auftrag · Trupp 1 Innenangriff über das Treppenhaus',
    reminder: { op: 'created', id: 'p1', text: 'Trupp 1 Innenangriff über das Treppenhaus' },
  }
  const textOf = (id: string) => document.querySelector(`[data-ev="${id}"] .jr-text`)?.textContent ?? ''

  // The PRINT drops the «Auftrag · » prefix because its Bereich column says the word (report ·
  // withoutAreaPrefix). The screen has no such column, so the sentence stays exactly as written.
  it('draws the record’s own string, prefix and all', () => {
    setup({ events: [auftrag], openReminders: [pendenz('p1', 'Trupp 1 Innenangriff über das Treppenhaus')] })
    expect(textOf('a1')).toBe(auftrag.text)
  })

  // ⚠️ It read «AUFTRAG  PENDENZ  Auftrag · Trupp 1 …» — the word twice in a chip and once more
  // in the sentence it was composed into.
  it('says each word once: no Bereich chip, no Pendenz chip', () => {
    setup({ events: [auftrag], openReminders: [pendenz('p1', 'Trupp 1 Innenangriff über das Treppenhaus')] })
    expect(document.querySelectorAll('.jr-chip')).toHaveLength(0)
    expect(document.querySelector('[data-ev="a1"]')!.textContent).not.toContain('Pendenz')
  })

  it('gives the row that raised an item the ring, and the closed one the closed ring', () => {
    setup({
      events: [
        { id: 'd1', t: '', at: new Date(1_030_000).toISOString(), icon: 'check', kind: 'reminder',
          text: 'Pendenz erledigt: Lüfter prüfen', reminder: { op: 'done', id: 'p2' } },
        { id: 'u1', t: '', at: new Date(1_020_000).toISOString(), icon: 'type', kind: 'journal',
          text: 'Lüftungsanlage prüfen', reminder: { op: 'created', id: 'p3' } },
        auftrag,
      ],
      openReminders: [pendenz('p3', 'Lüftungsanlage prüfen', { urgent: true })],
    })
    // p3 is still open and dringend; p1 is gone from the open set, so its row is erledigt
    expect(document.querySelector('[data-ev="u1"] .jr-ring-urgent')).toBeTruthy()
    expect(document.querySelector('[data-ev="a1"] .jr-ring-done')).toBeTruthy()
    expect(document.querySelector('[data-ev="d1"] .jr-ring-done')).toBeTruthy()
  })

  // a Meldung and a snooze are log lines ABOUT the item — they keep their glyph and, for the
  // Meldung, the anchor that names which item it answers
  it('leaves a Meldung row its own glyph', () => {
    setup({
      events: [{ id: 'n1', t: '', at: new Date(1_020_000).toISOString(), icon: 'type', kind: 'journal',
        text: 'Lüfter läuft', reminder: { op: 'note', id: 'p1' } }],
    })
    expect(document.querySelector('[data-ev="n1"] .jr-ring')).toBeNull()
    expect(document.querySelector('[data-ev="n1"] .ic use')?.getAttribute('href')).toBe('#type')
  })

  // «Nachtrag» / «korrigiert HH:MM» / «6×» are footnotes on the row: they belong after the
  // sentence, not in front of it where they pushed the text off its axis.
  it('puts the footnotes behind the sentence', () => {
    const at = new Date(1_060_000).toISOString()
    setup({ events: [{ ...events[0], correctedAt: at }, ...events.slice(1)] })
    const row = document.querySelector('[data-ev="r3"]')!
    const foot = row.querySelector('.jr-foot')!
    expect(foot.textContent).toMatch(/^korrigiert \d{1,2}:\d{2}$/)
    expect(row.querySelector('.jr-text')!.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('Journal · correcting a line (append-only)', () => {
  const sysRow: TimelineEvent = {
    id: 's1', t: '', at: new Date(1_050_000).toISOString(),
    text: 'Trupp 2 eingerückt', icon: 'people', kind: 'team',
  }
  const pen = () => screen.queryAllByLabelText('Text bearbeiten')

  it('offers the pen on what a person typed', () => {
    setup({ onEditText: vi.fn() })
    expect(pen()).toHaveLength(events.length)
  })

  // ⚠️ The whole point of the rule: rewriting «Trupp 2 eingerückt» would make the record state
  // an action that never happened that way.
  it('never offers it on a row the app wrote about an action', () => {
    setup({ events: [sysRow, ...events], onEditText: vi.fn() })
    expect(pen()).toHaveLength(events.length)
  })

  it('is absent entirely for a viewer (no handler)', () => {
    setup()
    expect(pen()).toHaveLength(0)
  })

  it('patches the row instead of editing it, and drops an empty correction', () => {
    const onEditText = vi.fn()
    setup({ onEditText })
    fireEvent.click(pen()[0])
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.click(screen.getByText('Speichern'))
    expect(onEditText).not.toHaveBeenCalled()

    fireEvent.click(pen()[0])
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Feuer aus, Nachkontrolle läuft' } })
    fireEvent.click(screen.getByText('Speichern'))
    expect(onEditText).toHaveBeenCalledWith('r3', 'Feuer aus, Nachkontrolle läuft')
  })

  // the corrected words must never pass for the ones spoken at the time
  it('marks a corrected line with the time of the correction', () => {
    const at = new Date(1_060_000).toISOString()
    setup({ events: [{ ...events[0], correctedAt: at }, ...events.slice(1)] })
    expect(screen.getByText(/^korrigiert \d{1,2}:\d{2}$/)).toBeTruthy()
  })
})

// ── the jump back from a Plan row ───────────────────────────────────────────────────────────
// The Lage's rows have always carried an `entityId` and flown to it. The Plan's carried the plan
// document and nothing else, so «Symbol "Löschleitung" auf Plan gesetzt» opened the Gebäude at
// whatever floor was showing and selected nothing. Placements record annoId + px/py + floor now
// (Whiteboard · PlanLogExtra); the record is append-only, so the rows written before that will
// never have them and must still land on their plan.
describe('Journal · a Plan row jumps back', () => {
  const planRow = (over: Partial<TimelineEvent>): TimelineEvent => ({
    id: 'p1', t: '', at: new Date(1_050_000).toISOString(), text: 'Symbol "Löschleitung" auf Plan gesetzt',
    icon: 'hex', kind: 'symbol', surface: 'plan', planId: 'geb', ...over,
  })

  it('carries the placed object and its spot', () => {
    const onSelect = vi.fn()
    setup({ events: [planRow({ annoId: 's7', px: 0.4, py: 0.6, floor: 2 })], onSelect })
    fireEvent.click(screen.getByText(/Löschleitung/))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      planId: 'geb', annoId: 's7', px: 0.4, py: 0.6, floor: 2,
    }))
  })

  it('⚠️ an old row without them still opens its plan rather than nothing', () => {
    const onSelect = vi.fn()
    setup({ events: [planRow({})], onSelect })
    fireEvent.click(screen.getByText(/Löschleitung/))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ planId: 'geb' }))
  })

  // undo/redo, and a Pendenz that happened to be ticked off while the Plan was open, are lines
  // ABOUT the surface rather than places on it — the journal is a record, not a UI
  it('leaves lines that are not about a place inert', () => {
    const onSelect = vi.fn()
    setup({
      events: [
        planRow({ id: 'h1', text: 'Rückgängig', icon: 'undo', kind: 'history' }),
        planRow({ id: 'd1', text: 'Pendenz erledigt: Absperrmaterial', icon: 'check', kind: 'reminder' }),
      ],
      onSelect,
    })
    fireEvent.click(screen.getByText('Rückgängig'))
    fireEvent.click(screen.getByText('Pendenz erledigt: Absperrmaterial'))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
