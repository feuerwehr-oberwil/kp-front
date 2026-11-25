import { describe, expect, it } from 'vitest'
import { deriveReminders, isDue, openReRaises, pendenzLedger, suggestPendenzen } from './reminders'
import type { TimelineEvent } from '../types'

// timeline is stored newest-first (App prepends), so fixtures list newest rows first.
const row = (id: string, text: string, reminder: TimelineEvent['reminder'], at = '2026-06-24T03:00:00.000Z'): TimelineEvent =>
  ({ id, t: '03:00', at, icon: 'clock', text, kind: 'reminder', surface: 'map', reminder })

describe('deriveReminders', () => {
  it('returns a created reminder as open with its due time', () => {
    const tl = [row('r1', 'Lüfter prüfen', { op: 'created', id: 'a', dueAt: '2026-06-24T03:10:00.000Z' })]
    const open = deriveReminders(tl)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ id: 'a', rowId: 'r1', text: 'Lüfter prüfen', dueAt: '2026-06-24T03:10:00.000Z' })
  })

  // The pinned block and the fällig banner print the Fälligkeit themselves, so what they want
  // from the row is the bare Wiedervorlage — not «Erinnerung gesetzt für 12:06: Pizza …», which
  // read as the same time twice on one line.
  it('prefers the bare reminder text over the composed row text', () => {
    const tl = [row('r1', 'Erinnerung gesetzt für 12:06: Pizza bestellen',
      { op: 'created', id: 'a', dueAt: '2026-06-24T10:06:00.000Z', text: 'Pizza bestellen' })]
    expect(deriveReminders(tl)[0].text).toBe('Pizza bestellen')
  })

  // …and rows written before `reminder.text` existed are still in the append-only record and
  // still open, so the lead-in is peeled off their text instead.
  it('strips the «Erinnerung gesetzt für …» lead-in from an older row', () => {
    const tl = [row('r1', 'Erinnerung gesetzt für 12:06: Pizza bestellen',
      { op: 'created', id: 'a', dueAt: '2026-06-24T10:06:00.000Z' })]
    expect(deriveReminders(tl)[0].text).toBe('Pizza bestellen')
  })

  it('leaves a row that does not carry the lead-in untouched', () => {
    const tl = [row('r1', 'Lüfter prüfen', { op: 'created', id: 'a', dueAt: '2026-06-24T03:10:00.000Z' })]
    expect(deriveReminders(tl)[0].text).toBe('Lüfter prüfen')
  })

  it('drops a reminder once a later done row references it', () => {
    const tl = [
      row('r2', 'erledigt', { op: 'done', id: 'a' }),
      row('r1', 'Lüfter prüfen', { op: 'created', id: 'a', dueAt: '2026-06-24T03:10:00.000Z' }),
    ]
    expect(deriveReminders(tl)).toHaveLength(0)
  })

  // «Rückgängig» on an erledigt toast is a NEW row beside the done one — append-only — and the
  // item is open again with the due time it had
  it('reopens an item a later `reopened` row takes back, keeping its due time', () => {
    const tl = [
      row('r3', 'wieder offen', { op: 'reopened', id: 'a' }),
      row('r2', 'erledigt', { op: 'done', id: 'a' }),
      row('r1', 'Lüfter prüfen', { op: 'created', id: 'a', dueAt: '2026-06-24T03:10:00.000Z' }),
    ]
    expect(deriveReminders(tl)).toMatchObject([{ id: 'a', rowId: 'r1', dueAt: '2026-06-24T03:10:00.000Z' }])
    // …and a done AFTER the reopen closes it again: the latest op wins
    expect(deriveReminders([row('r4', 'erledigt', { op: 'done', id: 'a' }), ...tl])).toHaveLength(0)
  })

  it('applies the latest snooze as the effective due time', () => {
    const tl = [
      row('r2', '+10', { op: 'snoozed', id: 'a', dueAt: '2026-06-24T03:20:00.000Z' }),
      row('r1', 'Lüfter prüfen', { op: 'created', id: 'a', dueAt: '2026-06-24T03:10:00.000Z' }),
    ]
    expect(deriveReminders(tl)[0].dueAt).toBe('2026-06-24T03:20:00.000Z')
  })

  it('a snooze without an explicit dueAt keeps the previous due', () => {
    const tl = [
      row('r2', 'snooze', { op: 'snoozed', id: 'a' }),
      row('r1', 'x', { op: 'created', id: 'a', dueAt: '2026-06-24T03:10:00.000Z' }),
    ]
    expect(deriveReminders(tl)[0].dueAt).toBe('2026-06-24T03:10:00.000Z')
  })

  // ⚠️ REVERSED, deliberately. A `created` row without a due used to be treated as malformed and
  // dropped, because the only way to make one was the Erinnerung mode, which demands a Fälligkeit.
  // No due is now the ordinary Pendenz — so the same shape has to be kept, not skipped.
  it('keeps a created row that has no due (that is a Pendenz, not a malformed reminder)', () => {
    const tl = [row('r1', 'x', { op: 'created', id: 'a' })]
    expect(deriveReminders(tl)).toHaveLength(1)
  })

  it('ignores non-reminder rows', () => {
    const tl: TimelineEvent[] = [{ id: 'x', t: '03:00', icon: 'type', text: 'note', kind: 'journal' }]
    expect(deriveReminders(tl)).toHaveLength(0)
  })
})

// A Pendenz is a `created` event WITHOUT a dueAt. It never alarms — there are no check-ins on a
// Schadenplatz, so a Fälligkeit on an Auftrag would only be alerting yourself.
describe('deriveReminders — Pendenzen (no due time)', () => {
  it('keeps a created row that has no dueAt', () => {
    const tl = [row('r1', 'Absperrmaterial', { op: 'created', id: 'a', text: 'Absperrmaterial' })]
    const open = deriveReminders(tl)
    expect(open).toHaveLength(1)
    expect(open[0].dueAt).toBeUndefined()
  })

  it('an undated Pendenz is never due', () => {
    const tl = [row('r1', 'x', { op: 'created', id: 'a', text: 'x' })]
    expect(isDue(deriveReminders(tl)[0], Date.now() + 10 ** 9)).toBe(false)
  })

  // ENT.4 (17.11.2026, owner: «stays offen everywhere»): an item open at the Einsatzende is open on
  // every surface; the closure only keeps a stale Erinnerung from ringing after a Nachtrag reopen
  it('keeps a timed Erinnerung open past the Einsatzende, but never lets it come due', () => {
    const closedAt = '2026-06-24T02:00:00.000Z'
    const tl = [
      row('r3', 'später', { op: 'created', id: 'later', dueAt: '2026-06-24T05:00:00.000Z' }),
      row('r2', 'stale', { op: 'created', id: 'timed', dueAt: '2026-06-24T01:00:00.000Z' }),
      row('r1', 'offen', { op: 'created', id: 'pend', text: 'offen' }),
    ]
    const open = deriveReminders(tl)
    expect(open.map((r) => r.id).sort()).toEqual(['later', 'pend', 'timed'])
    const at = (id: string) => open.find((r) => r.id === id)!
    const now = Date.parse('2026-06-24T06:00:00.000Z')
    expect(isDue(at('timed'), now, closedAt)).toBe(false)
    expect(isDue(at('timed'), now)).toBe(true)
    // due AFTER the Einsatzende (during the Nachtrag): rings as ever
    expect(isDue(at('later'), now, closedAt)).toBe(true)
    // …and the Tafel's ledger says the same «offen»
    expect(pendenzLedger(tl).find((p) => p.id === 'timed')?.doneAt).toBeUndefined()
  })

  // ENT.4: «Rückgängig» on a «wieder in …» re-raise puts things back as before it – no item
  it('drops a withdrawn re-raise from every reading, and gives its source back its chips', () => {
    const tl = [
      row('r4', 'Wiedervorlage zurückgenommen', { op: 'done', id: 'again', withdrawn: true }, '2026-06-24T03:06:00.000Z'),
      row('r3', 'Erinnerung gesetzt', { op: 'created', id: 'again', dueAt: '2026-06-24T03:35:00.000Z', text: 'Lagerapport', again: 'src' }, '2026-06-24T03:05:00.000Z'),
      row('r2', 'erledigt', { op: 'done', id: 'src' }, '2026-06-24T03:05:00.000Z'),
      row('r1', 'Lagerapport', { op: 'created', id: 'src', text: 'Lagerapport' }),
    ]
    expect(deriveReminders(tl)).toEqual([])
    expect(pendenzLedger(tl).map((p) => p.id)).toEqual(['src'])
    expect(openReRaises(tl, deriveReminders(tl)).size).toBe(0)
  })

  it('sorts dringend first, then oldest first', () => {
    const tl = [
      row('r3', 'neu', { op: 'created', id: 'c', text: 'neu' }, '2026-06-24T03:30:00.000Z'),
      row('r2', 'dringend', { op: 'created', id: 'b', text: 'dringend', urgent: true }, '2026-06-24T03:20:00.000Z'),
      row('r1', 'alt', { op: 'created', id: 'a', text: 'alt' }, '2026-06-24T03:00:00.000Z'),
    ]
    expect(deriveReminders(tl).map((r) => r.id)).toEqual(['b', 'a', 'c'])
  })

  it('carries the assignee read off the sentence', () => {
    const tl = [row('r1', 'x', { op: 'created', id: 'a', text: 'x', assignee: 'Werkhof Oberwil' })]
    expect(deriveReminders(tl)[0].assignee).toBe('Werkhof Oberwil')
  })
})

// Meldungen: a third op that reports on an item without opening or closing it.
describe('deriveReminders — Meldungen', () => {
  const created = row('r1', 'Absperrmaterial', { op: 'created', id: 'a', text: 'Absperrmaterial' }, '2026-06-24T03:00:00.000Z')

  it('lists every Meldung on the item, oldest first', () => {
    const tl = [
      row('r3', 'Material vor Ort', { op: 'note', id: 'a' }, '2026-06-24T03:33:00.000Z'),
      row('r2', 'Fahrzeug unterwegs', { op: 'note', id: 'a' }, '2026-06-24T03:19:00.000Z'),
      created,
    ]
    const [r] = deriveReminders(tl)
    // ⚠️ ALL of them, oldest first — the item's row is the only place the thread reads as one
    expect(r.notes.map((n) => n.text)).toEqual(['Fahrzeug unterwegs', 'Material vor Ort'])
  })

  // ⚠️ The one that matters: a Meldung must never resurrect a closed item, whatever order the
  // rows merged in.
  it('does not reopen an item a later done row closed', () => {
    const tl = [
      row('r3', 'noch was', { op: 'note', id: 'a' }, '2026-06-24T03:40:00.000Z'),
      row('r2', 'erledigt', { op: 'done', id: 'a' }, '2026-06-24T03:35:00.000Z'),
      created,
    ]
    expect(deriveReminders(tl)).toHaveLength(0)
  })

  // ⚠️ Nothing WRITES this today — the composer's switch is hidden while writing a Meldung, because
  // a control on one Meldung that re-ranks the whole Pendenz is not what it looks like. The reducer
  // stays tolerant of it so the action can be given its own control without a second reducer.
  it('takes urgency from whatever event carries it, latest wins', () => {
    const tl = [
      row('r2', 'wird eng', { op: 'note', id: 'a', urgent: true }, '2026-06-24T03:20:00.000Z'),
      created,
    ]
    expect(deriveReminders(tl)[0].urgent).toBe(true)
  })

  // ⚠️ «Werkhof meldet 20 Minuten» is exactly the moment the Wiedervorlage moves — and it has to
  // move WITHOUT taking the sentence out of the item's thread, which a separate snooze row would.
  it('moves the due time when a Meldung carries one, and stays in the thread', () => {
    const tl = [
      row('r2', 'Werkhof meldet 20 Minuten', { op: 'note', id: 'a', dueAt: '2026-06-24T03:40:00.000Z' }, '2026-06-24T03:20:00.000Z'),
      row('r1', 'Absperrmaterial', { op: 'created', id: 'a', text: 'Absperrmaterial', dueAt: '2026-06-24T03:10:00.000Z' }),
    ]
    const [r] = deriveReminders(tl)
    expect(r.dueAt).toBe('2026-06-24T03:40:00.000Z')
    expect(r.notes.map((n) => n.text)).toEqual(['Werkhof meldet 20 Minuten'])
  })

  // …and it stays a note in every other respect: it must not reopen what a done row closed.
  it('does not reopen a closed item through a Meldung that carries a due time', () => {
    const tl = [
      row('r3', 'doch noch offen?', { op: 'note', id: 'a', dueAt: '2026-06-24T03:50:00.000Z' }, '2026-06-24T03:45:00.000Z'),
      row('r2', 'erledigt', { op: 'done', id: 'a' }, '2026-06-24T03:35:00.000Z'),
      created,
    ]
    expect(deriveReminders(tl)).toHaveLength(0)
  })
})

describe('isDue', () => {
  const r = { id: 'a', rowId: 'r1', text: 'x', dueAt: '2026-06-24T03:10:00.000Z', createdAt: '', notes: [] }
  it('is false before the due time', () => {
    expect(isDue(r, Date.parse('2026-06-24T03:09:59.000Z'))).toBe(false)
  })
  it('is true at/after the due time', () => {
    expect(isDue(r, Date.parse('2026-06-24T03:10:00.000Z'))).toBe(true)
    expect(isDue(r, Date.parse('2026-06-24T03:11:00.000Z'))).toBe(true)
  })
})

// ENT.4: the Einsatzende silences, it never closes – pinned above («keeps a timed Erinnerung open …»)
describe('isDue — silenced by the Einsatzende', () => {
  const r = { id: 'a', rowId: 'r1', text: 'x', dueAt: '2026-07-02T12:00:00Z', createdAt: '', notes: [] }
  it('rings for nothing due before closed_at, and as ever without one', () => {
    const now = Date.parse('2026-07-30T10:00:00Z')
    expect(isDue(r, now, '2026-07-02T18:00:00Z')).toBe(false)
    expect(isDue({ ...r, dueAt: '2026-07-30T09:00:00Z' }, now, '2026-07-02T18:00:00Z')).toBe(true)
    expect(isDue(r, now, null)).toBe(true)
  })
})

// What the composer offers while an entry is being typed: an open item the sentence already names.
describe('suggestPendenzen', () => {
  const open = deriveReminders([
    row('r2', 'Patient an Sanität übergeben', { op: 'created', id: 'b', text: 'Patient an Sanität übergeben' }, '2026-06-24T03:10:00.000Z'),
    row('r1', 'Absperrmaterial Kreuzung, Werkhof Oberwil', { op: 'created', id: 'a', text: 'Absperrmaterial Kreuzung, Werkhof Oberwil' }, '2026-06-24T03:00:00.000Z'),
  ])

  it('offers the item a word of the sentence names', () => {
    expect(suggestPendenzen('Werkhof meldet Fahrzeug unterwegs', open).map((r) => r.id)).toEqual(['a'])
  })

  // ⚠️ The one that matters. Accepting a suggestion changes what the entry IS, so a subsequence
  // coincidence («…s-A-N-I-tät» inside an unrelated sentence) must not offer itself.
  it('does not match letters scattered through unrelated words', () => {
    expect(suggestPendenzen('Sonstige Anmerkung ist tabellarisch', open)).toEqual([])
  })

  it('matches across punctuation inside the item', () => {
    expect(suggestPendenzen('Kreuzung gesperrt', open).map((r) => r.id)).toEqual(['a'])
  })

  it('says nothing for a sentence that names none of them', () => {
    expect(suggestPendenzen('Lüfter im Erdgeschoss gestellt', open)).toEqual([])
  })

  it('ignores single letters and empty input', () => {
    expect(suggestPendenzen('a', open)).toEqual([])
    expect(suggestPendenzen('', open)).toEqual([])
  })
  // owner pick UX journeys B2·45: «Trupp» offered to file a Mayday under an old Pendenz
  describe('no offer on an everyday word or an emergency', () => {
    const busy = deriveReminders([
      row('r3', 'Gebäude Trupp Kontrolle Werkhof', { op: 'created', id: 'c', text: 'Gebäude Trupp Kontrolle Werkhof' }, '2026-06-24T03:20:00.000Z'),
    ])

    it('a word that names an app thing is no hit, typed or in the item', () => {
      expect(suggestPendenzen('Trupp 3 eingerückt', busy)).toEqual([])
      expect(suggestPendenzen('Tru', busy)).toEqual([])
      expect(suggestPendenzen('Gebäude Nord geräumt', busy)).toEqual([])
    })

    it('a real hit still offers', () => {
      expect(suggestPendenzen('Trupp meldet: Werkhof erreicht', busy).map((r) => r.id)).toEqual(['c'])
    })

    it('a Mayday never gets an offer', () => {
      expect(suggestPendenzen('Mayday Trupp Weber: Werkhof', busy)).toEqual([])
      expect(suggestPendenzen('MAYDAY, Werkhof', busy)).toEqual([])
    })

    it('a sentence naming a Trupp in Notfall never gets an offer', () => {
      expect(suggestPendenzen('Trupp Weber Fabian beim Werkhof', busy, 2, ['Trupp Weber Fabian'])).toEqual([])
      expect(suggestPendenzen('Trupp 2 beim Werkhof', busy, 2, ['Trupp 1'])).toEqual(busy)
    })
  })
})

// The Tafel's «Aufträge / Pendenzen» page (05.11.2026): every item, open and done, and the page's
// corrections of Was / Wer / Prio. riding on `note` rows.
describe('pendenzLedger + corrections from the Tafel page', () => {
  const a = row('r1', 'Strom abschalten', { op: 'created', id: 'a', text: 'Strom abschalten', dueAt: '2026-06-24T03:40:00.000Z' }, '2026-06-24T03:14:00.000Z')
  const b = row('r2', 'Wasserbezug melden', { op: 'created', id: 'b', text: 'Wasserbezug melden', urgent: true }, '2026-06-24T03:09:00.000Z')

  it('lists every item in the order it was raised, done ones with their time and kept', () => {
    const tl = [row('r4', 'erledigt', { op: 'done', id: 'b' }, '2026-06-24T03:18:00.000Z'), a, b]
    const items = pendenzLedger(tl)
    expect(items.map((i) => [i.id, i.doneAt])).toEqual([['b', '2026-06-24T03:18:00.000Z'], ['a', undefined]])
    expect(items[1].dueAt).toBe('2026-06-24T03:40:00.000Z')
  })

  it('a reopened item is open again on the page', () => {
    const tl = [
      row('r5', 'wieder offen', { op: 'reopened', id: 'b' }, '2026-06-24T03:20:00.000Z'),
      row('r4', 'erledigt', { op: 'done', id: 'b' }, '2026-06-24T03:18:00.000Z'),
      b,
    ]
    expect(pendenzLedger(tl)[0].doneAt).toBeUndefined()
  })

  it('applies the latest Was / Wer / Prio. and keeps a correction out of the Meldungen', () => {
    const tl = [
      row('r7', 'Auf der Tafel geändert', { op: 'note', id: 'a', edit: { assignee: 'Lt Brunner' } }, '2026-06-24T03:22:00.000Z'),
      row('r6', 'Auf der Tafel geändert', { op: 'note', id: 'a', edit: { text: 'Strom abschalten (EBL)', assignee: 'Of Zürcher' }, urgent: true }, '2026-06-24T03:20:00.000Z'),
      row('r5', 'EBL kommt', { op: 'note', id: 'a' }, '2026-06-24T03:19:00.000Z'),
      a,
    ]
    const [r] = deriveReminders(tl)
    expect(r).toMatchObject({ text: 'Strom abschalten (EBL)', assignee: 'Lt Brunner', urgent: true })
    expect(r.notes.map((n) => n.text)).toEqual(['EBL kommt'])
  })

  it('a correction never reopens a done item, and an emptied Wer clears it', () => {
    const tl = [
      row('r6', 'geändert', { op: 'note', id: 'b', edit: { assignee: '' } }, '2026-06-24T03:30:00.000Z'),
      row('r5', 'geändert', { op: 'note', id: 'b', edit: { assignee: 'Masch. Graf' } }, '2026-06-24T03:20:00.000Z'),
      row('r4', 'erledigt', { op: 'done', id: 'b' }, '2026-06-24T03:18:00.000Z'),
      b,
    ]
    const [item] = pendenzLedger(tl)
    expect(item.doneAt).toBe('2026-06-24T03:18:00.000Z')
    expect(item.assignee).toBeUndefined()
  })

  it('marks an item typed on the page', () => {
    const tl = [row('r1', 'Pendenz von der Tafel', { op: 'created', id: 'c', text: 'Gemeinde informieren', origin: 'tafel' })]
    expect(deriveReminders(tl)[0].origin).toBe('tafel')
  })
})

// «wieder in …» is a one-time action (05.11.2026: a double tap raised two): its done state is read
// off the record – the item a re-raise points back at (`again`), while that re-raise is open
describe('openReRaises', () => {
  const again = row('n1', 'Erinnerung gesetzt für 03:30: Lagerapport', { op: 'created', id: 'p2', dueAt: '2026-06-24T03:30:00.000Z', text: 'Lagerapport', again: 'p1' })
  it('names the closed item and how far ahead its open re-raise was set', () => {
    expect(openReRaises([again], [{ id: 'p2' }])).toEqual(new Map([['p1', 30]]))
  })
  it('lets go once the re-raise is closed too – its own done row offers the next one', () => {
    expect(openReRaises([again], []).size).toBe(0)
  })
})
