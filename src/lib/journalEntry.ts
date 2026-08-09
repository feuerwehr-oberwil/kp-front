import { appConfig } from '../config/appConfig'
import type { JournalEntryType, Person, AttendanceState } from '../types'
import { isPresent } from './attendanceIntervals'
import { rankOrder } from './rank'

/**
 * «Wer hat es gesagt» und «was für eine Aussage ist das» — auf einer Zeile.
 *
 * The two fields are composed INTO the row's text rather than printed from side fields, because
 * `text` is the record: the Verlauf, the Rapport and the hash chain all read that one string,
 * and a row whose meaning lived somewhere else would read differently in the app than on the
 * paper. The structured fields ride along for filtering, not for rendering.
 *
 * `info` prints no tag at all. It is the ordinary case, and a marker on the ordinary case is a
 * marker on every line — which is how a signal becomes wallpaper.
 *
 *   «Kellerbrand bestätigt»                          — nothing set
 *   «Meier Anna: Kellerbrand bestätigt»              — source only
 *   «Auftrag · Einsatzleiter: Trupp 2 sichert …»     — both
 */
export function composeJournalText(
  text: string,
  opts: { source?: { name: string }; entryType?: JournalEntryType } = {},
): string {
  const body = text.trim()
  const who = opts.source?.name.trim()
  const tag = opts.entryType && opts.entryType !== 'info'
    ? appConfig.copy.journal.entryTypes[opts.entryType]
    : undefined
  const head = [tag, who ? `${who}:` : undefined].filter(Boolean).join(' · ')
  if (!head) return body
  // an entry with a source but no words is still a row worth having — «Meier Anna» beside a
  // photo says who brought it
  return body ? `${head} ${body}` : head.replace(/:$/, '')
}

/** One offer in the «Von» row. `id` present = a roster person, so the row can link to them. */
export interface JournalSource {
  id?: string
  name: string
  /** somebody currently ticked present — offered first, because they are who is talking */
  present?: boolean
}

/**
 * Who the composer offers WITHOUT anybody searching for anything.
 *
 * The point of the field is that it costs nothing: a search box would make «wer hat es gesagt»
 * more work than typing the name into the sentence, and then nobody fills it in. So the people
 * who are on scene right now are simply there — most reports at a Kommandoposten come from one
 * of six people — with the officers first, because they are the ones who report.
 *
 * `limit` is what fits two rows of chips; everybody else is reachable through the search that
 * sits at the end of the row. Present crew ONLY: somebody who has gone home is not reporting.
 */
export function journalSources(
  personnel: Person[], attendance: AttendanceState, limit = 6,
): JournalSource[] {
  return personnel
    .filter((p) => p.active && isPresent(attendance[p.id]))
    .sort((a, b) => rankOrder(a.rank) - rankOrder(b.rank) || a.displayName.localeCompare(b.displayName, 'de'))
    .slice(0, limit)
    .map((p) => ({ id: p.id, name: p.displayName, present: true }))
}
