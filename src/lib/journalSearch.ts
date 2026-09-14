import type { TimelineEvent } from '../types'
import { matchesQuery, searchQuery, type SearchQuery } from './search'

// The Verlauf drawer's search: which rows a typed query keeps. The tolerance is the person
// search's (lib/search) – umlauts fold both ways, one typo is forgiven from four characters up
// and only against word starts – so a query behaves the same here as in Anwesenheit.
//
// One difference: a multi-word query is split, and EVERY word has to match somewhere on the
// row. lib/search keeps «müller hans» literal because a picker matches one name; a log line is
// a sentence, and «trupp 2 austritt» should find «Trupp 2 (…): Austritt» without the words
// standing in that order.

/** What a row is searched by: its sentence, the «Wer» a Pendenz names, and the words a memo
 *  turned out to hold. A TimelineEvent carries no author field of its own – whoever wrote or is
 *  meant by a row stands in its text (lib/journalLinks marks them there), which is searched. */
function haystack(e: TimelineEvent): string[] {
  const out = [e.text]
  if (e.reminder?.assignee) out.push(e.reminder.assignee)
  if (e.reminder?.text) out.push(e.reminder.text)
  if (e.transcript) out.push(e.transcript)
  for (const s of e.transcriptSections ?? []) out.push(s.text)
  return out
}

/** Prepare a raw query once per keystroke: one SearchQuery per word. `null` for a blank query –
 *  «everything matches», same contract as lib/search · searchQuery. */
export function journalQuery(raw: string): SearchQuery[] | null {
  const words = raw.split(/\s+/).map(searchQuery).filter((q): q is SearchQuery => q != null)
  return words.length ? words : null
}

/** Does this row survive the query – every word found in at least one of its fields. */
export function matchesJournalQuery(e: TimelineEvent, query: string | SearchQuery[] | null): boolean {
  const words = typeof query === 'string' ? journalQuery(query) : query
  if (!words) return true
  const fields = haystack(e)
  return words.every((w) => fields.some((f) => matchesQuery(w, f)))
}

/** The rows a query keeps, in their given order. A blank query returns the list as is. */
export function filterJournal(events: readonly TimelineEvent[], raw: string): TimelineEvent[] {
  const words = journalQuery(raw)
  if (!words) return [...events]
  return events.filter((e) => matchesJournalQuery(e, words))
}
