// One decision about what a typed query finds — shared by every picker that has a search box
// (Anwesenheit, the person fields, the Trupp form, the symbol palette).
//
// Two things it forgives, both of them things people actually do at 3am with gloves on:
//
//  · **Umlauts, in either direction.** «Mueller» finds Müller and «Müller» finds Mueller,
//    because both sides are folded the same way. A roster synced from Divera spells names one
//    way, the keyboard in front of you often the other, and neither is wrong.
//  · **One typo.** A wrong, missing, extra or swapped letter still finds the name — an
//    Einsatzleiter looking for «Widmer» must not come up empty on «Widemr». Only from four
//    characters up: on a two-letter query one typo matches half the Mannschaft, which is worse
//    than no match at all.
//
// A typo is only forgiven against the START of a word, not anywhere inside one. Searching is
// typing a name from the front; «uell» is a fragment somebody meant, «uelo» is not.

/** Umlaut-neutral, accent-neutral, case-neutral form. ⚠️ Applied to BOTH sides — that is what
 *  makes the tolerance work in both directions rather than only ae → ä.
 *
 *  ⚠️ The German pairs go FIRST and spell themselves out (ä → ae), because that is how the same
 *  name is written when a keyboard has no umlaut. Everything else loses its diacritic instead
 *  (é → e), which is how «Celine» finds Céline — spelling that one «Ceeline» would find nothing. */
export const fold = (s: string): string =>
  s.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')

/** Below this a typo is not forgiven — the query is too short to stay distinctive. */
const MIN_FUZZY_LEN = 4

/**
 * Damerau-Levenshtein distance ≤ 1: equal, or one substitution, insertion, deletion or
 * transposition of adjacent characters apart. Written out rather than as a DP matrix — the
 * bound is 1, so every case is a single scan, and this runs per candidate per keystroke.
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    let i = 0
    while (i < a.length && a[i] === b[i]) i += 1
    // substitution: everything after the first difference is identical
    if (a.slice(i + 1) === b.slice(i + 1)) return true
    // transposition: the two differing characters are each other's, swapped
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a]
  let i = 0
  while (i < short.length && long[i] === short[i]) i += 1
  return long.slice(i + 1) === short.slice(i)
}

/** A prepared query: folded once per keystroke rather than once per candidate. */
export interface SearchQuery {
  /** the folded needle — a plain substring test against folded text */
  term: string
  /** whether a typo is forgiven (long enough, and a single word) */
  fuzzy: boolean
}

/** Prepare what the user typed. `null` for a blank query — «everything matches». */
export function searchQuery(raw: string): SearchQuery | null {
  const term = fold(raw.trim())
  if (!term) return null
  // A multi-word query («müller h») is matched literally: the typo rule works on word starts,
  // and splitting the query as well would make «a b» find almost anything.
  return { term, fuzzy: term.length >= MIN_FUZZY_LEN && !/\s/.test(term) }
}

/** Does this candidate match — exactly, or within the one typo the query is allowed? */
export function matchesQuery(q: SearchQuery, text: string): boolean {
  const hay = fold(text)
  if (hay.includes(q.term)) return true
  if (!q.fuzzy) return false
  const n = q.term.length
  for (const word of hay.split(/[^a-z0-9]+/)) {
    if (!word) continue
    // …against the word's opening n−1 / n / n+1 characters, which is what makes a missing or an
    // extra letter forgivable rather than only a wrong one. `slice` clamps, so a short word is
    // simply compared whole.
    if (withinOneEdit(q.term, word.slice(0, n))
      || withinOneEdit(q.term, word.slice(0, n + 1))
      || withinOneEdit(q.term, word.slice(0, n - 1))) return true
  }
  return false
}

/** The whole thing in one call, for a single candidate against a raw query. */
export function matchesRaw(raw: string, text: string): boolean {
  const q = searchQuery(raw)
  return !q || matchesQuery(q, text)
}
