import { appConfig } from '../config/appConfig'
import type { AttendanceState, Person } from '../types'
import { isPresent } from './attendanceIntervals'
import { getDeploymentConfig } from './deploymentConfig'
import { rankOrder } from './rank'

/**
 * Everything a journal entry can NAME — and therefore everything it can link to.
 *
 * The «Von» field is gone (09.08.). It asked a question the sentence already answers: whoever
 * writes «Meier meldet Kellerbrand bestätigt» has said who reported it, and a second field
 * asking the same thing is a second thing to fill in. What was actually wanted is that the
 * NAMES in the sentence are real — spelled the way the rest of the app spells them, and visible
 * as links rather than as prose.
 *
 * So the vocabulary is everything the Einsatz has words for: the Mannschaft, the station's
 * Mittel, the Partnerorganisationen, the Fahrzeuge and the Alarmgruppen. Typing three letters
 * of any of them offers the full form; whatever is in the text afterwards is marked, in the
 * composer, in the Verlauf and on the printed Rapport.
 */
export type LinkKind = 'person' | 'material' | 'partner' | 'vehicle' | 'group'

export interface JournalLink {
  /** the canonical spelling — what typing completes to and what gets marked */
  name: string
  kind: LinkKind
  /** roster id, for a person; absent for everything else */
  id?: string
  /** somebody ticked present — the only thing that breaks a tie between equal matches */
  present?: boolean
  /** the job this person holds on THIS Einsatz — «EL», «Stv. EL», «Fahrer TLF» — read off their
   *  Anwesenheits-Bemerkung. Printed after the name on its first mention in an entry, so a row
   *  reads «Rückmeldung an ELZ durch Widmer Céline (EL)» rather than naming somebody the reader
   *  has to look up. Absent for anybody without a job, which is most people. */
  role?: string
}

/**
 * The whole linkable vocabulary, best-first within each kind.
 *
 * ⚠️ People are NOT filtered by attendance. Whoever an entry is about is very often somebody who
 * is not ticked present — the AdF still driving in, the Kommandant on the phone — and a list
 * that cannot spell their name is worse than none. Presence only orders.
 */
export function journalVocabulary(personnel: Person[], attendance: AttendanceState): JournalLink[] {
  const cfg = getDeploymentConfig()
  const people: JournalLink[] = personnel
    .filter((p) => p.active)
    .map((p) => ({
      name: p.displayName, kind: 'person' as const, id: p.id, present: isPresent(attendance[p.id]),
      role: shortRole((attendance[p.id]?.note ?? '').trim()),
    }))
    .sort((a, b) => Number(b.present) - Number(a.present)
      || rankOrder(personnel.find((p) => p.id === a.id)?.rank) - rankOrder(personnel.find((p) => p.id === b.id)?.rank)
      || a.name.localeCompare(b.name, 'de'))
  const materials: JournalLink[] = (cfg.mittel?.catalogue ?? [])
    .map((m) => ({ name: m.label, kind: 'material' as const }))
  const partners: JournalLink[] = (cfg.report?.partnerOrgs ?? [])
    .map((o) => ({ name: o, kind: 'partner' as const }))
  const vehicles: JournalLink[] = (cfg.fleet?.vehicles ?? [])
    .map((v) => ({ name: v.label, kind: 'vehicle' as const }))
  // «Gr. 1 (Kdo)» is how the Rapport names a group, so that is the form the journal links to
  const groups: JournalLink[] = (cfg.alarms?.groups ?? [])
    .map((g) => ({ name: g.color ? `${g.label} (${g.color})` : g.label, kind: 'group' as const }))
  return [...people, ...materials, ...partners, ...vehicles, ...groups]
    .filter((l) => !!l.name?.trim())
}

/**
 * The Bemerkung, shortened for a line of prose.
 *
 * «Einsatzleiter» inside a sentence that already names the person is four syllables of the
 * reader's attention for one letter of information, and the Verlauf is read in a hurry. The
 * doctrine words get their abbreviations; everything else («Fahrer TLF», «Verkehrsdienst») is
 * already short and stays exactly as it was typed — the Bemerkung is the operator's wording and
 * nothing here is entitled to rewrite it.
 */
function shortRole(note: string): string | undefined {
  if (!note) return undefined
  const A = appConfig.copy.anwesenheit
  if (note === A.roleEinsatzleiter) return A.roleEinsatzleiterShort
  if (note === A.roleEinsatzleiterStv) return A.roleEinsatzleiterStvShort
  return note
}

/** One marked stretch of an entry's text. */
export interface LinkRange {
  start: number
  end: number
  kind: LinkKind
  /** the job the named person holds — set on the FIRST mention in this text only */
  role?: string
}

/**
 * Where the vocabulary appears in a piece of text.
 *
 * Longest first, so «Meier Anna» wins over a «Meier» that is a prefix of it and the two can
 * never overlap. Case-insensitive, because an entry typed at 3am is not typed carefully — but
 * the MATCH is on the canonical spelling, so what gets marked is only ever a real name.
 */
export function linkRanges(text: string, vocab: JournalLink[]): LinkRange[] {
  const out: LinkRange[] = []
  const overlaps = (a: number, b: number) => out.some((r) => a < r.end && r.start < b)
  const hay = text.toLowerCase()
  for (const l of [...vocab].sort((a, b) => b.name.length - a.name.length)) {
    const needle = l.name.trim().toLowerCase()
    if (needle.length < 2) continue
    let from = 0
    // ⚠️ ONCE per entry. «Widmer Céline (EL) meldet … Widmer Céline (EL) übernimmt» is the same
    // fact printed twice in one sentence, and a row that repeats itself reads as a bug.
    let roleSaid = false
    for (;;) {
      const i = hay.indexOf(needle, from)
      if (i < 0) break
      const end = i + needle.length
      if (!overlaps(i, end)) {
        out.push({ start: i, end, kind: l.kind, role: roleSaid ? undefined : l.role })
        roleSaid = true
      }
      from = end
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** The text split into plain stretches and marked ones — one shape both the composer's
 *  backdrop and the Verlauf render from, so the two can never mark different things. */
export function linkParts(text: string, vocab: JournalLink[]): { text: string; kind?: LinkKind; role?: string }[] {
  const ranges = linkRanges(text, vocab)
  const parts: { text: string; kind?: LinkKind; role?: string }[] = []
  let at = 0
  for (const r of ranges) {
    if (r.start > at) parts.push({ text: text.slice(at, r.start) })
    parts.push({ text: text.slice(r.start, r.end), kind: r.kind, role: r.role })
    at = r.end
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}

/** Marked-up text for the PRINTED journal: every linked term in bold. The Rapport has no
 *  colour to spend, and bold is what a reader already reads as «this is a name». */
export function linkMarkup(text: string, vocab: JournalLink[], esc: (s: string) => string): string {
  return linkParts(text, vocab)
    .map((p) => {
      if (!p.kind) return esc(p.text)
      // the job in plain weight after the bold name: it is context for the name, not a second name
      return p.role ? `<b>${esc(p.text)}</b> (${esc(p.role)})` : `<b>${esc(p.text)}</b>`
    })
    .join('')
}

/** How a linked term is announced — «Person», «Material», «Partner», «Fahrzeug», «Gruppe». */
export function linkKindLabel(kind: LinkKind): string {
  return appConfig.copy.journal.linkKinds[kind] ?? kind
}
