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

/**
 * What a marked stretch of text can be: one of the Einsatz's own words — or an address.
 *
 * A URL is the one mark that is not vocabulary. Nobody configures it and nothing completes it;
 * it is simply what somebody typed or pasted — the Meldung's ticket, a Merkblatt, the
 * Wetterradar they were reading off — and it should be openable everywhere the entry is read
 * rather than a string to copy out by hand.
 *
 * A phone number is the same kind of thing, and it is where a Meldung's callback number actually
 * lands: «Melder 079 123 45 67, wartet vor dem Haus». On the printed Rapport that number is read
 * off paper — or off a PDF on the phone that is about to dial it, which is what makes it worth
 * anchoring. See `MarkOptions.phone`: it is marked for PRINT only.
 */
export type MarkKind = LinkKind | 'url' | 'phone'

/**
 * What a pass over an entry's text marks beyond the vocabulary and the addresses.
 *
 * ⚠️ `phone` is OFF by default, and that is deliberate — the on-screen Verlauf stays TEXT-ONLY on
 * phone numbers. The screen renders a non-`url` mark as a coloured bold term (`Journal.tsx` ·
 * `.jr-link-*`), which is the app saying «this is one of the Einsatz's own words»; a phone number
 * is not, and dressing it up as one would be a lie about the vocabulary. A `tel:` anchor there
 * would also be a link that does nothing on the desktops the Verlauf is read on, and the composer
 * reads the last mark of a sentence to decide whether to offer the «→» («EL → Sanität»), which a
 * number must not trigger. On paper none of that applies: the anchor is the only way the number
 * gets dialled, so `linkMarkup` — the print path, and its only caller is `lib/report.ts` — turns
 * it on.
 */
export interface MarkOptions {
  /** mark Swiss phone numbers as `tel:` links. Print only — see above. */
  phone?: boolean
}

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
  /** What this person is doing right now — «Trupp 2», «Sicherungstrupp». Shown on the SUGGESTION
   *  CHIP only, never inserted and never printed: it answers «which Meier do I mean» at the moment
   *  of typing and stops being true ten minutes later, so it has no business in a record that is
   *  read six months on. (The `role` above is the opposite: it is stable for this Einsatz and does
   *  print.) */
  hint?: string
  /** match only as a WHOLE word. Off by default: a name is long enough that a substring match is
   *  almost always the name. It is on for the command posts, where «EL» would otherwise light up
   *  inside Melder, Keller and Schnellangriff (see commandRoles). */
  word?: boolean
}

/**
 * The whole linkable vocabulary, best-first within each kind.
 *
 * ⚠️ People are NOT filtered by attendance. Whoever an entry is about is very often somebody who
 * is not ticked present — the AdF still driving in, the Kommandant on the phone — and a list
 * that cannot spell their name is worse than none. Presence only orders.
 */
export function journalVocabulary(
  personnel: Person[],
  attendance: AttendanceState,
  /** personId → the Trupp they are in right now, for the chip's hint (see JournalLink.hint) */
  truppOf?: Map<string, string>,
): JournalLink[] {
  const cfg = getDeploymentConfig()
  const people: JournalLink[] = personnel
    .filter((p) => p.active)
    .map((p) => ({
      name: p.displayName, kind: 'person' as const, id: p.id, present: isPresent(attendance[p.id]),
      role: shortRole((attendance[p.id]?.note ?? '').trim()),
      hint: truppOf?.get(p.id),
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
  const heldAt = new Map(Object.entries(attendance).flatMap(([id, a]) => (a.noteAt ? [[id, a.noteAt] as const] : [])))
  return [...commandRoles(people, heldAt), ...people, ...materials, ...partners, ...vehicles, ...groups]
    .filter((l) => !!l.name?.trim())
}

/**
 * «EL» and «Stv. EL» as words of their own.
 *
 * A Verlauf is a Funkprotokoll, and its most-written participant is a POST, not a name: «EL →
 * Sanität: Patient stabil». Written as plain prose those two letters were the only thing in such
 * a line that was not a link — the one term the record could not resolve, for the one job that
 * decides everything on the Schadenplatz.
 *
 * ⚠️ The name rides along as the `role` suffix, which is the same mechanism reversed: a person's
 * entry prints «Widmer Céline (EL)», the post's entry prints «EL (Widmer Céline)». Both directions
 * of the same fact, so it does not matter which way round the operator writes the sentence.
 * ⚠️ And when nobody holds the post — the first minutes, an exercise, a Nachbarwehr's copy — the
 * term stays, without a suffix. «EL» is then still what was said; there is simply nobody yet to
 * name. Dropping the term instead would make the marking come and go with the Anwesenheit.
 * ⚠️ Resolved at RENDER time, like every other role suffix, so an Ablösung re-labels older rows
 * too. The row's own `text` — the record, the hash chain, the paper — never changes.
 */
function commandRoles(people: JournalLink[], heldAt?: Map<string, string>): JournalLink[] {
  const A = appConfig.copy.anwesenheit
  return [A.roleEinsatzleiterShort, A.roleEinsatzleiterStvShort]
    .filter((short) => !!short?.trim())
    .map((short) => {
      // ⚠️ The one who took it on LAST. A handover leaves the previous EL's Bemerkung standing
      // (the app warns, it does not overwrite what somebody wrote), so «find the first» answered
      // with whoever the roster sort happened to put on top — and the journal could name a person
      // who handed over an hour ago. Entries with no stamp sort last: they are the old ones.
      const holder = people
        .filter((p) => p.role === short)
        .sort((a, b) => (heldAt?.get(b.id ?? '') ?? '').localeCompare(heldAt?.get(a.id ?? '') ?? ''))[0]
      return {
        name: short, kind: 'person' as const, id: holder?.id, present: holder?.present,
        role: holder?.name,
        // ⚠️ «el» is two letters and lives inside Melder, Schnellangriff, Winkel, Keller … — the
        // one term in this vocabulary that MUST NOT match inside a word (see linkRanges · word).
        word: true,
      }
    })
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
  kind: MarkKind
  /** the job the named person holds — set on the FIRST mention in this text only */
  role?: string
  /** what to open — the absolute address for a `url`, the `tel:` number for a `phone`, and
   *  nothing for every other kind. Resolved here rather than at every render site, so a bare
   *  «www.…» gets its scheme and a spaced-out number its dialable form in exactly one place. */
  href?: string
}

/**
 * Where the vocabulary appears in a piece of text.
 *
 * Longest first, so «Meier Anna» wins over a «Meier» that is a prefix of it and the two can
 * never overlap. Case-insensitive, because an entry typed at 3am is not typed carefully — but
 * the MATCH is on the canonical spelling, so what gets marked is only ever a real name.
 *
 * ⚠️ Addresses are found FIRST and keep what they claim. A Fahrzeug called «TLF» must not bold
 * up in the middle of a link: it would break the address on paper and split the anchor on
 * screen, for a match that was never the Fahrzeug in the first place. Phone numbers come next,
 * for the same reason in the other direction: the digits inside an already-claimed address are
 * part of it, never a number to dial.
 */
export function linkRanges(text: string, vocab: JournalLink[], opts?: MarkOptions): LinkRange[] {
  const out: LinkRange[] = urlRanges(text)
  const overlaps = (a: number, b: number) => out.some((r) => a < r.end && r.start < b)
  if (opts?.phone) for (const r of phoneRanges(text)) if (!overlaps(r.start, r.end)) out.push(r)
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
      // …and a `word` term only counts with nothing word-ish on either side of it: «EL» is two
      // letters, and without this it lit up in Melder, Keller and Schnellangriff.
      if (l.word && (isWordChar(hay[i - 1]) || isWordChar(hay[end]))) { from = i + 1; continue }
      if (!overlaps(i, end)) {
        out.push({ start: i, end, kind: l.kind, role: roleSaid ? undefined : l.role })
        roleSaid = true
      }
      from = end
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Letters (incl. umlauts and accents) and digits — what a word may not be glued to. */
function isWordChar(ch: string | undefined): boolean {
  return ch != null && /[\p{L}\p{N}]/u.test(ch)
}

/**
 * The addresses in a piece of text.
 *
 * Two spellings, because those are the two people write: a full `https://…`, and the bare
 * `www.…` that every browser and every printed Merkblatt still uses. The bare form gets its
 * `https://` in the `href` and keeps the short form on screen — the entry prints what was said.
 */
function urlRanges(text: string): LinkRange[] {
  // ⚠️ The excluded characters are not cosmetic: `"` is what closes the href attribute in the
  // printed markup, and `<`/`>` what would open a tag inside it.
  const re = /(?:https?:\/\/|www\.)[^\s<>"«»]+/gi
  const out: LinkRange[] = []
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    // «…undwww.vkf.ch» is a missing space, not an address the writer meant to leave there
    if (isWordChar(text[m.index - 1])) continue
    const raw = trimUrlTail(m[0])
    // a bare scheme, or a «www.» with nothing behind it, is somebody half-way through typing
    if (!/^(?:https?:\/\/|www\.)[^\s/?#]/i.test(raw)) continue
    out.push({
      start: m.index, end: m.index + raw.length, kind: 'url',
      href: /^www\./i.test(raw) ? `https://${raw}` : raw,
    })
  }
  return out
}

/** Punctuation that ends a sentence rather than an address — «Merkblatt unter www.vkf.ch.» is a
 *  full stop, «(www.vkf.ch)» a bracket the writer opened. Both are prose, and neither belongs in
 *  the href or in the underline. The German quotes are not in this list because the match above
 *  never takes them in the first place. */
const URL_TAIL = '.,;:!?)'

/**
 * …trimmed off the end, with the one exception every link-detector needs: a «)» that closes a
 * «(» the address itself contains stays part of it (the Wikipedia case,
 * `…/wiki/Nirvana_(Band)`). Counting brackets over the candidate is what tells the two apart —
 * a link the writer put in brackets has the closer without an opener.
 */
function trimUrlTail(url: string): string {
  let end = url.length
  for (; end > 0; end--) {
    const ch = url[end - 1]
    if (!URL_TAIL.includes(ch)) break
    const head = url.slice(0, end)
    if (ch === ')' && head.split('(').length >= head.split(')').length) break
  }
  return url.slice(0, end)
}

/**
 * The Swiss phone numbers in a piece of text.
 *
 * ⚠️ Deliberately ONE shape, and a narrow one: the ten digits of a Swiss number, written either
 * nationally («079 123 45 67», «044 123 45 67») or internationally («+41 79 123 45 67»), grouped
 * 3-3-2-2 the way the Post writes them, with a space, «/», «.» or «-» between the groups or
 * nothing at all («0791234567»). Everything else stays prose. A Verlauf is FULL of numbers that
 * are not numbers to call — «14:31» (the colon is not a separator here), «250 bar», «Leitung 3»,
 * «01.09.2026» (eight digits, and neither half is three long) — and a matcher that guesses wrong
 * puts a dead tap target in the middle of the legal record. What this does not take: the short
 * emergency numbers (118/144 are three digits and unmistakable on paper anyway), «00 41 …», and
 * the «+41 (0)79» form, whose bracketed zero has to be dropped from the href rather than dialled.
 */
function phoneRanges(text: string): LinkRange[] {
  // `0` + area code, or «+41» + the same code without its zero, then 3-2-2
  const re = /(?:\+41[ ./-]?|0)\d{2}[ ./-]?\d{3}[ ./-]?\d{2}[ ./-]?\d{2}/g
  const out: LinkRange[] = []
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const end = m.index + m[0].length
    // ⚠️ Glued to a letter or another digit it is a longer number (an Einsatz-ID, a Zählerstand,
    // a bank reference) that happens to contain ten digits — not a number anybody dials. The
    // leading «+» is checked separately: it never survives `isWordChar`.
    if (isWordChar(text[m.index - 1]) || text[m.index - 1] === '+' || isWordChar(text[end])) continue
    // dialable: digits only, keeping the country code's «+». The printed text stays exactly as
    // the operator typed it — the Rapport prints what was said, spacing included.
    out.push({ start: m.index, end, kind: 'phone', href: `tel:${m[0].replace(/[^\d+]/g, '')}` })
  }
  return out
}

/** One stretch of an entry as it gets rendered — plain, or marked. */
export interface LinkPart {
  text: string
  kind?: MarkKind
  /** the job the named person holds, on their first mention */
  role?: string
  /** where a `url` or a `phone` part points (see LinkRange.href) */
  href?: string
}

/** The text split into plain stretches and marked ones — one shape the composer's backdrop, the
 *  Verlauf and the Wiedergabe all render from, so no two of them can mark different things. */
export function linkParts(text: string, vocab: JournalLink[], opts?: MarkOptions): LinkPart[] {
  const ranges = linkRanges(text, vocab, opts)
  const parts: LinkPart[] = []
  let at = 0
  for (const r of ranges) {
    if (r.start > at) parts.push({ text: text.slice(at, r.start) })
    parts.push({ text: text.slice(r.start, r.end), kind: r.kind, role: r.role, href: r.href })
    at = r.end
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}

/**
 * Marked-up text for the PRINTED journal: every named term in bold, every address and every phone
 * number underlined and anchored. The Rapport has no colour to spend — bold is what a reader
 * already reads as «this is a name», and an underline what they read as «this can be followed».
 * The PDF's own reader turns the anchor into a tap — a `tel:` one straight into a call, which is
 * the whole point of the callback number a Meldung leaves in the entry text; on paper the address
 * and the number are still written out, which is why the text and not a label gets printed.
 *
 * ⚠️ This is the ONE place phone numbers are marked (`MarkOptions.phone`): the on-screen Verlauf
 * stays text-only on them, deliberately — see `MarkOptions`.
 *
 * `esc` is the caller's XML escaping and is applied to the href as well — an address can carry
 * an «&» between its query parameters, and one unescaped ampersand costs the whole page.
 *
 * ⚠️ Returns `undefined` when the row marked nothing at all, so the backend falls back to its own
 * escaping of the plain text rather than storing markup that says nothing (see report.ts).
 */
export function linkMarkup(text: string, vocab: JournalLink[], esc: (s: string) => string): string | undefined {
  const parts = linkParts(text, vocab, { phone: true })
  if (!parts.some((p) => p.kind)) return undefined
  return parts
    .map((p) => {
      if (!p.kind) return esc(p.text)
      if (p.kind === 'url' || p.kind === 'phone') {
        return `<a href="${esc(p.href ?? p.text)}"><u>${esc(p.text)}</u></a>`
      }
      // the job in plain weight after the bold name: it is context for the name, not a second name
      return p.role ? `<b>${esc(p.text)}</b> (${esc(p.role)})` : `<b>${esc(p.text)}</b>`
    })
    .join('')
}
