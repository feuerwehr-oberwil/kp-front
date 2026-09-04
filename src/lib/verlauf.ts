import { appConfig } from '../config/appConfig'
import { formatTime } from './format'
import type { TimelineEvent } from '../types'

/**
 * Verlauf display helpers: localized row times, the Nachtrag boundary, and day grouping.
 *
 * An incident's journal can span days (Hochwasser) or carry corrections appended weeks
 * after the Einsatzende (archive → reopen, the correction path). Bare HH:MM rows made a
 * three-weeks-later Nachtrag look like it happened on incident day — these helpers give
 * the drawer date separators and let rows after `closed_at` carry a Nachtrag badge.
 */

/** Display time from the absolute timestamp when present (server rows ship t='' and the
 *  server clock is UTC — the client localises); legacy rows fall back to their baked t. */
export const rowTime = (e: TimelineEvent): string => (e.at ? formatTime(new Date(e.at)) : e.t)

/** appended after the Einsatzende (closed_at) → renders as a Nachtrag */
export const isNachtrag = (e: TimelineEvent, closedAt?: string | null): boolean =>
  !!closedAt && !!e.at && Date.parse(e.at) > Date.parse(closedAt)

export interface DayGroup {
  /** localized date label for the separator — null for today's rows (no separator) */
  label: string | null
  events: TimelineEvent[]
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/** Group a newest-first Verlauf into calendar-day runs. Rows without `at` (old data)
 *  stick to the running group rather than fragmenting the list. */
export function groupByDay(events: readonly TimelineEvent[], now: Date = new Date()): DayGroup[] {
  const todayKey = dayKey(now)
  const groups: DayGroup[] = []
  let currentKey: string | undefined
  for (const e of events) {
    const d = e.at ? new Date(e.at) : null
    const k = d && !Number.isNaN(d.getTime()) ? dayKey(d) : (currentKey ?? todayKey)
    if (k !== currentKey || groups.length === 0) {
      currentKey = k
      groups.push({
        label:
          k === todayKey
            ? null
            : (d ?? now).toLocaleDateString(appConfig.locale, {
                weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
              }),
        events: [],
      })
    }
    groups[groups.length - 1].events.push(e)
  }
  return groups
}

/** Every picture on a row, old shape and new: rows written before 2026-08-06 carry a single
 *  `photoUrl`, newer ones a `photoUrls` list. Readers use THIS, never the fields. */
export function rowPhotos(e: { photoUrl?: string; photoUrls?: string[] }): string[] {
  return e.photoUrls?.length ? e.photoUrls : e.photoUrl ? [e.photoUrl] : []
}

/**
 * The text a photo row should SHOW — its own caption, else the bare word «Foto».
 *
 * ⚠️ REVERSED 31.08. This used to blank the caption on a wordless picture, on the argument that
 * «Foto» over a photo says the one thing the reader can already see. In the field it read as a
 * broken row instead: a run of pictures came out as a column of timestamps with nothing beside
 * them, and neither the Verlauf nor the printed Rapport said what those rows even were. The
 * duplication is the cheaper mistake — a Rapport is read by people who were not there.
 *
 * Render-only, in both directions — the same rule (and the same reason) as `withoutAreaPrefix`
 * in lib/report: the Verlauf is append-only and hash-chained, so nothing here writes to the
 * record. Rows written before 06.08. carry the word themselves and simply keep it; newer ones
 * carry no text at all (IncidentWorkspace · addJournal) and borrow it from the live copy, so
 * the placeholder answers in the deployment's own locale.
 *
 * A row whose photo never arrived is NOT a photo row here — it keeps whatever it was written
 * with, which is the only thing left saying a picture was meant.
 */
export function rowText(e: { text: string; photoUrl?: string; photoUrls?: string[] }): string {
  if (!rowPhotos(e).length) return e.text
  return e.text.trim() || appConfig.copy.journal.photoNote
}

/** Replace one URL in a row's photo list, keeping the others and the order. Used when one of
 *  several attached pictures finishes uploading: the row's other photos (still local blob:
 *  URLs, or already uploaded) must survive that patch untouched. */
export function swapUrl(list: string[] | undefined, from: string, to: string): string[] {
  const arr = list ?? []
  return arr.includes(from) ? arr.map((u) => (u === from ? to : u)) : [...arr, to]
}

/**
 * Did a HUMAN write this line, in their own words?
 *
 * Only those rows may be corrected (see Journal · the pen). Everything else in the Verlauf is
 * the app reporting what happened — «Symbol gesetzt», «Trupp 2 eingerückt», «Haken bei
 * Bereitstellung» — and a sentence the app wrote about an action is not a sentence anybody may
 * rewrite: it would say the action went differently than it did, in a record whose whole point
 * is that it does not.
 *
 * ⚠️ The kind alone is not enough. A Checklisten-Haken is written as `kind: 'journal'` too (it
 * IS a documented decision, see report · journalArea), but its text is composed from the item —
 * so the icon has to agree as well. The three icons here are exactly what the composer stamps:
 * `type` for text, `mic` for a Sprachnotiz, `photo` for pictures.
 */
export function isHandWritten(e: TimelineEvent): boolean {
  if (e.kind !== 'journal' && e.kind !== 'audio' && e.kind !== 'photo') return false
  return e.icon === 'type' || e.icon === 'mic' || e.icon === 'photo'
}

/** How close two identical lines have to be for the second to read as a REPEAT rather than as
 *  news. Deliberately short: the ping that spams is a state the app re-states every few seconds
 *  (an überfällige Kontaktuhr) or a button tapped six times in two seconds, while a genuinely
 *  new Überfällig is at least one Funkkontakt-Intervall away. Nothing is ever collapsed across
 *  a gap longer than this, so a second turnus keeps its own line. */
const REPEAT_WINDOW_MS = 2 * 60_000

/**
 * Runs of the SAME line about the SAME object repeated within {@link REPEAT_WINDOW_MS} — the
 * Verlauf and the printed journal show the first of them and say how often it repeated, instead
 * of the same sentence twenty times.
 *
 * The run key is **text + object** (`entityId ?? annoId ?? subjectId`), never text alone. Two
 * different Notizen dropped seconds apart both write «Notiz gesetzt», and two shapes drawn in one
 * burst both write the same line — on text alone those collapsed to «Notiz gesetzt 2×», which
 * claims one thing happened twice where two things happened once. Rows about no object at all (an
 * überfällige Kontaktuhr) share the empty object key and collapse exactly as before.
 *
 * ⚠️ `subjectId` is the half that was missing (04.09.). A DELETION names its object and then
 * cannot point at it, and a drawing edit has no jump target at all, so both wrote rows with no
 * object key — and the 03.09. Rapport printed «Feuerwehr gelöscht 2×», «Polizei gelöscht 2×»,
 * «Lüfter gelöscht 2×» where each pair was two different symbols removed a few seconds apart.
 * See types · TimelineEvent.subjectId for why it is not simply `entityId`.
 *
 * ⚠️ Display only. Every row stays in the append-only record and in the hash chain; this decides
 * what is worth READING. The count is shown («6×») rather than silently swallowed — a reader has
 * to be able to tell «this happened once» from «this happened and would not stop».
 *
 * ⚠️ Hand-written rows are never collapsed. Somebody who types the same sentence twice meant it
 * both times, and the journal is their record, not the app's.
 */
export function repeatRuns(events: TimelineEvent[]): {
  counts: Map<string, number>
  hidden: Set<string>
  /** ISO instant of the LAST repeat in each run — the detail sheet says «6× bis 14:34», because
   *  «6×» alone leaves a reader unable to tell a burst from something that ran for two minutes. */
  lastAt: Map<string, string>
} {
  const counts = new Map<string, number>()
  const hidden = new Set<string>()
  const lastAt = new Map<string, string>()
  const open = new Map<string, { id: string; lastMs: number }>()
  const chrono = events
    .filter((e) => e.at && !isHandWritten(e))
    .sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!))
  for (const e of chrono) {
    const text = e.text.trim()
    if (!text) continue
    // NUL joins the two halves so an object id can never run into the text and fake a match.
    const key = `${e.entityId ?? e.annoId ?? e.subjectId ?? ''}\u0000${text}`
    const ms = Date.parse(e.at!)
    if (!Number.isFinite(ms)) continue
    const run = open.get(key)
    if (run && ms - run.lastMs <= REPEAT_WINDOW_MS) {
      counts.set(run.id, (counts.get(run.id) ?? 1) + 1)
      hidden.add(e.id)
      lastAt.set(run.id, e.at!)
      run.lastMs = ms
      continue
    }
    open.set(key, { id: e.id, lastMs: ms })
  }
  return { counts, hidden, lastAt }
}
