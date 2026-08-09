import { appConfig } from '../config/appConfig'
import type { JournalEntryType } from '../types'
import type { JournalLink } from './journalLinks'
import { fuzzyScore } from './quickPhrases'

/**
 * «Wer hat es gesagt» and «was für eine Aussage ist das» — on one line.
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
  opts: { entryType?: JournalEntryType } = {},
): string {
  const body = text.trim()
  // ⚠️ No «Von» any more (09.08.). It asked what the sentence already answers — whoever writes
  // «Meier meldet Kellerbrand bestätigt» has said who reported it — and a second field asking
  // the same thing is a second thing to fill in. What was wanted is that the NAMES are real and
  // visible as links; that is lib/journalLinks, and it needs no field at all.
  const tag = opts.entryType && opts.entryType !== 'info'
    ? appConfig.copy.journal.entryTypes[opts.entryType]
    : undefined
  if (!tag) return body
  return body ? `${tag} · ${body}` : tag
}

/**
 * Vocabulary entries that match the word being typed.
 *
 * The point is that it costs nothing: you write the sentence you were going to write anyway,
 * and the SPELLING comes for free — «Baum» becomes «Baumann Michael», «Ölbind» becomes
 * «Ölbinder (Granulat)». A journal holding «Baumann», «Baumann M.» and «Bauman» is one nobody
 * can search afterwards, and a Mittel spelled three ways is three materials in the Rapport.
 */
export function suggestLinks(text: string, vocab: JournalLink[], limit = 4): JournalLink[] {
  const word = currentWord(text)
  if (word.length < MIN_NAME_FRAGMENT) return []
  const written = text.toLowerCase().trimEnd()
  const strict = word.length === MIN_NAME_FRAGMENT
  return vocab
    .filter((l) => !strict || startsAWord(word, l.name))
    .map((l) => ({ l, score: fuzzyScore(word, l.name) }))
    // ⚠️ Compared against the whole TEXT, not the word. A full name is two words, so after
    // accepting «Baumann Michael» the word under the cursor is «Michael» — which still matches,
    // so the chip kept offering the same name and a second tap wrote it twice.
    .filter((m) => m.score > 0 && !written.endsWith(m.l.name.toLowerCase()))
    // score first — a better spelling match beats being on scene. Presence breaks the tie:
    // two people whose names start the same way, and the one who is here is the likelier one.
    .sort((a, b) => b.score - a.score || Number(b.l.present) - Number(a.l.present)
      || a.l.name.localeCompare(b.l.name, 'de'))
    .slice(0, limit)
    .map((m) => m.l)
}

/** The word being typed: everything after the last space or newline. Deliberately NOT the
 *  Textbaustein fragment (lib/quickPhrases · currentFragment), which reaches back to the last
 *  sentence boundary — a name is one word, and «Meier meldet Baum» must offer Baumann, not
 *  search the vocabulary for the whole sentence. */
export function currentWord(text: string): string {
  return text.split(/[\s]/).pop() ?? ''
}

/** A term is worth offering from this many letters on. */
const MIN_NAME_FRAGMENT = 2

/** …but at exactly two letters only a WORD START counts. Two letters of fuzzy subsequence put
 *  half the Mannschaft under every «zu», «am», «in» somebody types; «Ba» → «Baumann Michael»
 *  and «Mi» → «Baumann Michael» is what the two letters were actually meant to do. */
function startsAWord(word: string, name: string): boolean {
  const q = word.toLowerCase()
  return name.toLowerCase().split(/[\s(/-]+/).some((w) => w.startsWith(q))
}

/** Replace the word being typed with the accepted term, keeping everything before it. */
export function acceptName(text: string, name: string): string {
  const word = currentWord(text)
  const head = word.length ? text.slice(0, text.length - word.length) : text
  return `${head}${name} `
}
