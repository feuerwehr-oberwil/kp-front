// Pendenzen (open items), derived from the append-only Verlauf stream.
//
// The journal never edits or removes a row (see the kp-front-journal note), so an open item's
// lifecycle is a SEQUENCE of events sharing one `reminder.id`:
//   - `created`  → carries the text, and a `dueAt` only if it is a timed Erinnerung
//   - `note`     → a later row reporting what happened, without closing it. It MAY carry a new
//                  `dueAt` — a Meldung that moves the Wiedervorlage («Werkhof meldet 20 Minuten»).
//                  One carrying `edit` is no Meldung but a CORRECTION of Was / Wer (+ `urgent`)
//                  from the Tafel's «Aufträge / Pendenzen» page (05.11.2026): latest wins per
//                  field, and it is kept out of the item's thread
//   - `snoozed`  → a later row with a new `dueAt` (timed Erinnerungen only)
//   - `done`     → a later row that closes it
//   - `reopened` → a later row that takes a `done` back («Rückgängig» on the erledigt toast, or ↶,
//                  23.09.2026). The done row STAYS — the record says it was ticked off and then
//                  reopened, in that order — and the item is open again with the due it had.
//   - `done` + `withdrawn` → the «Rückgängig» of a «wieder in …» re-raise (ENT.4, 17.11.2026): the
//                  item is taken back as if never raised – it leaves every reading below, so the
//                  Tafel and the paper do not print it as «Erledigt».
// ⚠️ ONE state per item on every surface (ENT.4): an item still open when the Einsatz closed stays
// OPEN – in the Verlauf, on the Tafel, on paper. Only its ALARM stops: a timed Erinnerung due before
// the Einsatzende never comes due (`isDue` · closedAt), so a Nachtrag reopen rings nothing stale.
// The open set (`deriveReminders`), every item open or done (`pendenzLedger`), each item's *effective*
// due time and its Meldungen are derived here (`foldPendenzen`) — never
// stored as mutable fields. This keeps everything correct under offline merge + replay for free.
//
// ⚠️ Two kinds live in one list, and the difference that matters is the `dueAt`:
//   - WITHOUT one: a Pendenz. Open until done, never alarms. There are no check-ins on a
//     Schadenplatz, so a due time on an Auftrag would be a fiction — you would only be alerting
//     yourself. What you want to know is how long it has been running, which the created time says.
//   - WITH one: today's Erinnerung, unchanged — banner, tone, OS notification, +10 min.

import { appConfig } from '../config/appConfig'
import { fuzzyScore, norm } from './quickPhrases'
import type { Surface, TimelineEvent } from '../types'

/**
 * «wieder in …» on a done row (Journal · JournalRow): the items re-raised from a closed one that are
 * still OPEN, keyed by the item they re-raise (`reminder.again`), with how far ahead each was set
 * (whole minutes, its `dueAt` less its row's `at`). That done row shows ✓ «↻ in 30 min gesetzt»
 * instead of its chips – the one-time action's done state, read off the record
 * (docs/ui-conventions.md · One-time actions); once the re-raise is closed too, the chips are back.
 */
export function openReRaises(timeline: readonly TimelineEvent[], open: readonly Pick<OpenReminder, 'id'>[]): Map<string, number> {
  const openIds = new Set(open.map((r) => r.id))
  const out = new Map<string, number>()
  for (const e of timeline) {
    const r = e.reminder
    if (r?.op !== 'created' || !r.again || !openIds.has(r.id) || !r.dueAt || !e.at) continue
    out.set(r.again, Math.max(1, Math.round((Date.parse(r.dueAt) - Date.parse(e.at)) / 60_000)))
  }
  return out
}

/** The latest Meldung on an open item — what the list shows under the item's own text. */
export interface PendenzNote {
  /** the note row's id, so the list can jump to it */
  rowId: string
  text: string
  /** ISO instant, for the list's time column */
  at: string
}

export interface OpenReminder {
  /** stable id (the `created` row's reminder.id) */
  id: string
  /** timeline row id of the `created` event — target for "In Verlauf öffnen" */
  rowId: string
  /** the bare item — «Lüfter prüfen», NOT the `created` row's own text («Erinnerung gesetzt für
   *  22:10: Lüfter prüfen», or «Auftrag · Lüfter prüfen»). Everything that re-shows an item
   *  prints its own context, so the prefixes arrived as a stutter. */
  text: string
  /** effective due time (ISO) for a timed Erinnerung: the latest snooze, else the original.
   *  ABSENT on a Pendenz — which is the whole difference between the two (see the note above). */
  dueAt?: string
  /** when it was raised (ISO) — the list's time column and the Rapport's «Erteilt». '' if an
   *  older row lacked `at`. */
  createdAt: string
  /** sorts to the top and prints a marker. The LATEST event carrying it wins. */
  urgent?: boolean
  /** «Wer» for the Rapport column, read off the sentence when it was written */
  assignee?: string
  /** EVERY Meldung on this item, oldest first.
   *  ⚠️ Not just the latest. The Meldungen stand in the Verlauf where they happened, scattered
   *  among everything else, and nothing there says which item each belongs to — so the item's own
   *  row is the only place the thread can be read as a thread. Showing one of three was worse than
   *  showing none: it looked like the whole story. */
  notes: PendenzNote[]
  /** surface it was raised on, for the Verlauf chip / jump */
  surface?: Surface
  /** raised by a row typed on the Tafel's «Aufträge / Pendenzen» page — the Verlauf's block says
   *  «von der Tafel» (types · reminder.origin) */
  origin?: 'tafel'
}

type Reminder = NonNullable<TimelineEvent['reminder']>

/** One item's whole lifecycle, folded off the stream — what both readings below are made of. */
interface Folded {
  created: TimelineEvent
  op: 'created' | 'snoozed' | 'done' | 'reopened'
  dueAt?: string
  /** when the latest `done` closed it (ISO; '' when that row had no `at`) — set only while done */
  doneAt?: string
  urgent?: boolean
  notes: PendenzNote[]
  /** the latest correction of the item's own words (a `note` carrying `edit`), per field */
  text?: string
  assignee?: string
  /** a withdrawn re-raise (`done` + `withdrawn`) – dropped from the fold's result */
  withdrawn?: boolean
}

/**
 * THE fold of the Pendenz lifecycle: every item by id, its events applied oldest first, so the
 * latest op wins regardless of how the (newest-first) timeline is stored or merged. A row that
 * stands before its item's `created` (a merge can put it there) is applied once that lands.
 * `deriveReminders` (what is open) and `pendenzLedger` (every item) are two readings of it.
 */
function foldPendenzen(timeline: readonly TimelineEvent[]): Map<string, Folded> {
  const items = new Map<string, Folded>()
  const early = new Map<string, [TimelineEvent, Reminder][]>()
  const apply = (e: TimelineEvent, r: Reminder, f: Folded) => {
    // Urgency is taken from whatever event carries it, latest wins — the same append-only pattern
    // as `snoozed`/`dueAt`. The composer writes it on `created` only: re-ranking an item from one
    // of its Meldungen was tried and pulled (see types · reminder.urgent). The Tafel page's «Prio.»
    // is the action of its own that tolerance was kept for, and rides on an `edit` note.
    if (r.urgent !== undefined) f.urgent = r.urgent
    if (r.op === 'note') {
      // ⚠️ Does NOT touch the item's OP. A Meldung reports on an item; it never opens or closes
      // one, and it must not resurrect an item that a later `done` already closed.
      // …but it may carry a new `dueAt` — «Werkhof meldet 20 Minuten» is exactly when the
      // Wiedervorlage moves. That is a snooze in everything but the row it rides on, and it has to
      // ride on the note: a separate snooze row would take the sentence out of the item's thread.
      if (r.dueAt) f.dueAt = r.dueAt
      // ⚠️ A correction of the item's own words (the Tafel page, types · reminder.edit) is not a
      // Meldung: it changes what the item SAYS, so it is not listed in the thread. Its row stays
      // in the Verlauf where it happened, like every row.
      if (r.edit) {
        if (typeof r.edit.text === 'string' && r.edit.text.trim()) f.text = r.edit.text.trim()
        if (typeof r.edit.assignee === 'string') f.assignee = r.edit.assignee.trim()
        return
      }
      f.notes.push({ rowId: e.id, text: e.text, at: e.at ?? '' })
      return
    }
    if (r.op === 'created') return
    // a snooze without an explicit dueAt keeps the previous due — and so do `done` and
    // `reopened`, which is what hands a reopened Erinnerung back the Fälligkeit it had
    f.op = r.op
    if (r.dueAt) f.dueAt = r.dueAt
    f.doneAt = r.op === 'done' ? e.at ?? '' : undefined
    if (r.op === 'done' && r.withdrawn) f.withdrawn = true
  }
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]
    const r = e.reminder
    if (!r) continue
    if (r.op === 'created') {
      const f: Folded = { created: e, op: 'created', dueAt: r.dueAt, urgent: r.urgent, notes: [] }
      items.set(r.id, f)
      for (const [x, xr] of early.get(r.id) ?? []) apply(x, xr, f)
      early.delete(r.id)
      continue
    }
    const f = items.get(r.id)
    if (f) apply(e, r, f)
    else early.set(r.id, [...(early.get(r.id) ?? []), [e, r]])
  }
  // a withdrawn re-raise is no item at all – not open, not done (see the header)
  for (const [id, f] of items) if (f.withdrawn) items.delete(id)
  return items
}

function itemOf(id: string, f: Folded): OpenReminder {
  const c = f.created
  const assignee = f.assignee ?? c.reminder?.assignee
  return {
    id, rowId: c.id, text: f.text ?? bareText(c), dueAt: f.dueAt, createdAt: c.at ?? '',
    urgent: f.urgent || undefined,
    assignee: assignee || undefined,
    notes: f.notes,
    surface: c.surface,
    ...(c.reminder?.origin === 'tafel' ? { origin: 'tafel' as const } : {}),
  }
}

/** An item of the Einsatz, open or done — one row of the Tafel's «Aufträge / Pendenzen» page. */
export interface PendenzItem extends OpenReminder {
  /** when it was ticked off (ISO; '' when that row lacked `at`) — ABSENT while it is open */
  doneAt?: string
}

/**
 * EVERY Pendenz and Erinnerung the Einsatz raised, open and done, in the order they were raised —
 * the Tafel's «Aufträge / Pendenzen» page (components/TafelPendenzen), which is a paper form: it
 * lists what was ordered and keeps what was done, struck through, where it stood.
 * ⚠️ Not `deriveReminders`: that one answers «what is still open» and sorts dringend first, a
 * working order. No closure expiry either — the page is a record, not an alarm.
 */
export function pendenzLedger(timeline: readonly TimelineEvent[]): PendenzItem[] {
  return [...foldPendenzen(timeline)]
    .map(([id, f]): PendenzItem => (f.op === 'done' ? { ...itemOf(id, f), doneAt: f.doneAt ?? '' } : itemOf(id, f)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/**
 * Reduce the timeline to the still-open items, each with its effective state.
 * Order-independent: events are folded oldest→newest so the latest op wins regardless of how the
 * (newest-first) timeline is stored or merged.
 *
 * ⚠️ No closure expiry here (ENT.4, 17.11.2026, owner: «stays offen everywhere»). It used to drop
 * timed Erinnerungen due before the Einsatzende, so after a Nachtrag reopen the Verlauf drew them
 * done while the Tafel listed them open and red and the paper said «offen». The no-stale-alarms
 * rule it served lives where the alarm is decided: `isDue` · closedAt.
 */
export function deriveReminders(timeline: readonly TimelineEvent[]): OpenReminder[] {
  const open: OpenReminder[] = []
  for (const [id, f] of foldPendenzen(timeline)) {
    if (f.op === 'done') continue
    open.push(itemOf(id, f))
  }
  // dringend first, then the OLDEST first: the position carries the age, so the time column can
  // stay a plain clock. Undated and dated sort together — one list, one question («was ist offen»).
  return open.sort((a, b) =>
    Number(!!b.urgent) - Number(!!a.urgent)
    || a.createdAt.localeCompare(b.createdAt)
    || a.id.localeCompare(b.id))
}

/**
 * The bare item text of a `created` row.
 *
 * New rows carry it on `reminder.text`. Rows written before that — and the record is append-only,
 * so they are still there and still open — only have the composed row text, so the «Erinnerung
 * gesetzt für {t}: » lead-in is peeled off it. The pattern is derived FROM the copy template rather
 * than hard-coded, so it keeps working in every locale and stays correct if the wording changes;
 * anything that does not match is returned untouched.
 *
 * Exported for the «wieder in …» re-raise (IncidentWorkspace): the new `created` row has to
 * carry the ITEM, not the closed row's sentence — same one implementation, both directions.
 */
export function bareText(e: TimelineEvent): string {
  const explicit = e.reminder?.text?.trim()
  if (explicit) return explicit
  const tpl = appConfig.copy.journal.reminderCreated
  const lead = tpl.slice(0, tpl.indexOf('{text}'))
  if (!lead || !tpl.includes('{text}')) return e.text
  const esc = lead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{t\\}', '.{0,12}?')
  const m = new RegExp(`^${esc}`).exec(e.text)
  return m ? e.text.slice(m[0].length).trim() || e.text : e.text
}

/** Only a TIMED Erinnerung can come due. A Pendenz has no due time and never alarms.
 *  `closedAt` (the Einsatzende): one due BEFORE the Einsatz was closed never comes due – reopening
 *  a weeks-old Einsatz for a Nachtrag must not ring stale alarms. The item itself stays open
 *  (ENT.4); only its reminder is silent. */
export function isDue(r: OpenReminder, nowMs: number, closedAt?: string | null): boolean {
  if (r.dueAt == null) return false
  const due = Date.parse(r.dueAt)
  const closedMs = closedAt ? Date.parse(closedAt) : NaN
  return due <= nowMs && !(Number.isFinite(closedMs) && due < closedMs)
}

/**
 * Open items whose own words match what is being typed — the composer offers them so an entry can
 * become a Meldung ON one of them without leaving the sheet.
 *
 * ⚠️ The match has to START A WORD of the item, at every length. `fuzzyScore` alone is a
 * subsequence match, which from three letters on hits almost anything — the same trap the name
 * suggestions documented and fixed (lib/journalEntry · startsAWord). Getting this wrong is worse
 * here than there: accepting a name inserts a word, accepting one of these changes what the entry
 * IS, so a coincidental match costs more than a wrong spelling.
 *
 * ⚠️ Matched against the WHOLE typed text, not the word under the cursor: «Werkhof meldet Fahrzeug
 * unterwegs» is a Meldung on «Absperrmaterial Kreuzung, Werkhof Oberwil», and the word that says so
 * («Werkhof») is nowhere near the caret by the time the sentence is finished.
 *
 * ⚠️ A word that names one of the app's own things («Trupp», «Lage», «Leitung», «Gebäude» …,
 * copy · journal.pendenzWeakWords) is never a hit, typed or in the item: half the Verlauf says it.
 * And an emergency gets no offer at all – a sentence with «Mayday» (journal.pendenzNeverWords) or
 * naming a Trupp in Notfall (`quiet`, lib/notfall · notfallTerms). Owner pick UX journeys B2·45,
 * 25.11.2026: «Trupp» offered to file a Mayday under an old Pendenz.
 */
export function suggestPendenzen<T extends Pick<OpenReminder, 'text' | 'createdAt'>>(
  text: string, open: readonly T[], limit = 2, quiet: readonly string[] = [],
): T[] {
  const C = appConfig.copy.journal
  const said = norm(text)
  const words = said.split(/[\s]+/).filter((w) => w.length >= 2)
  if (!words.length) return []
  const never = C.pendenzNeverWords.map(norm)
  if (words.some((w) => never.some((n) => w.startsWith(n)))) return []
  if (quiet.some((q) => q.trim() && said.includes(norm(q.trim())))) return []
  const weak = new Set(C.pendenzWeakWords.map(norm))
  const strong = words.filter((w) => !weak.has(w.replace(/[^\p{L}\p{N}]+$/u, '')))
  return open
    .map((r) => ({ r, score: Math.max(0, ...strong.map((w) => (startsAWord(w, r.text, weak) ? fuzzyScore(w, r.text) : 0))) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.r.createdAt.localeCompare(b.r.createdAt))
    .slice(0, limit)
    .map((m) => m.r)
}

/** …the same «must begin one of the target's words» rule the name suggestions use – never one of
 *  the `weak` words (see suggestPendenzen). */
function startsAWord(word: string, target: string, weak: ReadonlySet<string>): boolean {
  return norm(target).split(/[\s(/,.:;!?-]+/).some((w) => !weak.has(w) && w.startsWith(word))
}
