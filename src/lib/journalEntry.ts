import { appConfig } from '../config/appConfig'
import type { JournalEntryType, Person, AttendanceState } from '../types'
import { isPresent } from './attendanceIntervals'
import { rankOrder } from './rank'
import { getDeploymentConfig } from './deploymentConfig'
import { fuzzyScore } from './quickPhrases'

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
export function journalSources(personnel: Person[], attendance: AttendanceState): JournalSource[] {
  return personnel
    .filter((p) => p.active)
    .map((p) => ({ id: p.id, name: p.displayName, present: isPresent(attendance[p.id]) }))
    // ⚠️ EVERYBODY, not just the crew on scene. Whoever is being talked about in a journal
    // entry is very often somebody who is not ticked present — the AdF still driving in, the
    // Kommandant on the phone — and a suggestion list that cannot spell their name is worse
    // than none. Attendance only decides the ORDER.
    .sort((a, b) => Number(b.present) - Number(a.present)
      || rankOrder(personnel.find((p) => p.id === a.id)?.rank) - rankOrder(personnel.find((p) => p.id === b.id)?.rank)
      || a.name.localeCompare(b.name, 'de'))
}

/** The station's Mittel, offered the same way a name is: «Ölbind» completes to «Ölbinder
 *  (Granulat)», so the Verlauf and the Mittel list call the same thing the same thing. */
export function journalMaterials(): JournalSource[] {
  const cat = getDeploymentConfig().mittel?.catalogue ?? []
  return cat.map((m) => ({ name: m.label })).filter((m) => !!m.name?.trim())
}


/** The word being typed: everything after the last space or newline. Deliberately NOT the
 *  Textbaustein fragment (lib/quickPhrases · currentFragment), which reaches back to the last
 *  sentence boundary — a name is one word, and «Meier meldet Baum» must offer Baumann, not
 *  search the roster for the whole sentence. */
export function currentWord(text: string): string {
  return text.split(/[\s]/).pop() ?? ''
}

/** A name is worth offering from this many letters on. Two would put half the Mannschaft under
 *  every «zu», «am», «in» somebody types. */
const MIN_NAME_FRAGMENT = 3

/**
 * Roster names that match the word being typed.
 *
 * The point is that it costs nothing: you write the sentence you were going to write anyway,
 * and the spelling of the name comes for free — «Baum» becomes «Baumann Michael», which is what
 * the Rapport, the Anwesenheit and the statistics export all call that person. A journal full of
 * «Baumann», «Baumann M.» and «Bauman» is a journal nobody can search afterwards.
 */
export function suggestNames(text: string, sources: JournalSource[], limit = 3): JournalSource[] {
  const word = currentWord(text)
  if (word.length < MIN_NAME_FRAGMENT) return []
  const written = text.toLowerCase().trimEnd()
  return sources
    .map((s) => ({ s, score: fuzzyScore(word, s.name) }))
    // ⚠️ Compared against the whole TEXT, not against the word. A full name is two words, so
    // after accepting «Baumann Michael» the word under the cursor is «Michael» — which still
    // matches, so the chip kept offering the same name and a second tap wrote
    // «Baumann Baumann Michael».
    .filter((m) => m.score > 0 && !written.endsWith(m.s.name.toLowerCase()))
    // score first — a better spelling match beats being on scene. Attendance breaks the tie:
    // two people whose names start the same way, and the one who is here is the likelier one.
    .sort((a, b) => b.score - a.score || Number(b.s.present) - Number(a.s.present)
      || a.s.name.localeCompare(b.s.name, 'de'))
    .slice(0, limit)
    .map((m) => m.s)
}

/** Replace the word being typed with the accepted name, keeping everything before it. */
export function acceptName(text: string, name: string): string {
  const word = currentWord(text)
  const head = word.length ? text.slice(0, text.length - word.length) : text
  return `${head}${name} `
}

/** Where the known names sit in the text, so the field can mark them. Longest first, so
 *  «Meier Anna» wins over a «Meier» that is a prefix of it and the two never overlap. */
export function nameRanges(text: string, sources: JournalSource[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  const taken = (a: number, b: number) => out.some((r) => a < r.end && r.start < b)
  for (const s of [...sources].sort((a, b) => b.name.length - a.name.length)) {
    if (!s.name.trim()) continue
    const hay = text.toLowerCase()
    const needle = s.name.toLowerCase()
    let from = 0
    for (;;) {
      const i = hay.indexOf(needle, from)
      if (i < 0) break
      const end = i + needle.length
      if (!taken(i, end)) out.push({ start: i, end })
      from = end
    }
  }
  return out.sort((a, b) => a.start - b.start)
}
