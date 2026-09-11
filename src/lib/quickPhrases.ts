/**
 * Textbausteine as a typing companion: no static chip row — while the operator types,
 * the current fragment fuzzy-matches against the station's phrase list and the best
 * completions surface as tappable suggestions (2026-07-02 decision: entries are short
 * prefixes to expand, so suggestions replace the fragment, then editing continues).
 *
 * The list lives in deployment config (journal.quickPhrases, admin-editable) over the
 * app's national defaults.
 */

export interface PhraseMatch {
  phrase: string
  score: number
  /** the exact stretch of text this suggestion would replace. Carried on the match rather than
   *  recomputed on accept: the two used to derive it separately, and the moment they could
   *  disagree — which is the moment a suggestion matched something other than the whole
   *  fragment — accepting would have eaten the sentence in front of it. */
  frag: string
}

/** Case- and umlaut-folded for matching. Exported so the name matcher folds identically —
 *  two normalisers that disagree let a term score well and then be filtered out again. */
export const norm = (s: string) =>
  s.toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/é|è/g, 'e')

/**
 * Subsequence fuzzy score with word-prefix weighting: every query char must appear in
 * order; contiguous runs and word starts score higher; a plain prefix match wins.
 * Returns 0 when the query does not match at all.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = norm(query)
  const t = norm(target)
  if (!q) return 0
  if (t.startsWith(q)) return 1000 - t.length // prefix beats everything, shorter first
  let score = 0
  let ti = 0
  let run = 0
  for (const ch of q) {
    let found = -1
    for (let i = ti; i < t.length; i++) {
      if (t[i] === ch) { found = i; break }
    }
    if (found === -1) return 0
    const wordStart = found === 0 || t[found - 1] === ' '
    run = found === ti ? run + 1 : 1
    score += 1 + run + (wordStart ? 3 : 0)
    ti = found + 1
  }
  return score
}

/**
 * Is what was typed ONE typo away from the beginning of one of this term's words?
 *
 * The fallback tier under `startsAWord` (lib/journalEntry · suggestLinks), and the answer to what
 * the real prod Verlauf shows the phone keyboard doing to Feuerwehr words: «MaWa» was autocorrected
 * to «Mama» in a live Einsatz, «Absperrung» came out «Abspereung», «Brandwohnung» «Braundwohnung».
 * `fuzzyScore` cannot see any of those — it is a strict subsequence match, so a single inserted or
 * swapped letter takes the term from «best match» to «no match», silencing the suggestion at
 * exactly the keystroke where it would have saved the record.
 *
 * ⚠️ Compared against the term's word cut to the TYPED length (±1), not against the whole word:
 * somebody four letters into «Brandwohnung» has typed a prefix, and a distance to the full word
 * would be twelve. ⚠️ From four letters on. Below that, one edit is most of the word, and «Ma»
 * would be a near miss of half the roster.
 * ⚠️ And the FIRST letter has to survive. Without that rule this tier walked straight back into
 * the coincidence `suggestLinks` was built to stop: «sani» is one substitution from «Dani»el and
 * offered Wyss Daniel. Every real case keeps its first letter — the phone mangles «MaWa» into
 * «Mama» and «Wasser» into «Waser», it does not change what the word starts with — so the rule
 * costs nothing and buys back the whole class of false offers.
 */
export function nearMiss(word: string, name: string): boolean {
  const q = norm(word)
  if (q.length < MIN_NEAR_MISS) return false
  return norm(name).split(/[\s(/-]+/).some((w) => {
    if (!w || w[0] !== q[0]) return false
    for (const len of [q.length - 1, q.length, q.length + 1]) {
      if (len > 0 && len <= w.length && within1(q, w.slice(0, len))) return true
    }
    return false
  })
}

/** Short of this, a one-letter edit is not a typo but a different word. */
const MIN_NEAR_MISS = 4

/** Damerau-Levenshtein «distance ≤ 1», decided in one pass instead of building a matrix: equal,
 *  one substitution, one insertion/deletion, or one transposition («Farhzeug» → «Fahrzeug»). */
function within1(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (i === a.length || i === b.length) return true // the rest is one trailing character
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2) // swap
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

/** The fragment being typed: everything after the last sentence boundary (newline, '. ', '; '). */
export function currentFragment(text: string): string {
  const tail = text.split(/\n|(?<=[.;!?])\s+/).pop() ?? ''
  return tail.trimStart()
}

/**
 * ⚠️ ONE since 10.09. — a completion that waits for a second letter is a completion the thumb has
 * already outrun. At a single letter only a real PREFIX qualifies (see `MIN_LOOSE` below): the
 * loose subsequence match is what needs a couple of letters to mean anything, not the lookup.
 */
const MIN_FRAGMENT = 1
/** From this many letters on, a phrase may also be reached by the loose subsequence match. Below
 *  it, «a» is a subsequence of very nearly every phrase in the list and three junk offers are
 *  worse than none. */
const MIN_LOOSE = 2
/** …but a TAIL has to be a little more than that. Matched loosely, a trailing «im» or «am» is a
 *  subsequence of half the phrase list, and three wrong suggestions are worse than none. */
const MIN_TAIL = 3
const MAX_SUGGESTIONS = 3
/** How far back into the sentence a suggestion may still be triggered. A Textbaustein is a short
 *  prefix to expand, so the words that could start one are the last few — and this bounds the
 *  work per keystroke on an entry somebody has been typing for a while. */
const MAX_TAIL_WORDS = 5

/**
 * The stretches of the sentence a suggestion is allowed to complete, LONGEST FIRST: the whole
 * fragment, then the same fragment with its leading words dropped one at a time.
 *
 * ⚠️ The tails are the point. Matching only the whole fragment meant Textbausteine worked for
 * exactly as long as the entry was one phrase: the moment the operator had written «Rauch aus
 * Fenster 2. OG, Brand unter», the fragment was that whole string, no phrase in the list matched
 * it, and the suggestions stopped for the rest of the sentence — precisely when a long entry is
 * being typed with one thumb and the completion is worth the most. Longest first, so «unter
 * Kontrolle» is preferred over the bare «Kontrolle» that is inside it.
 */
function fragmentTails(frag: string): string[] {
  const out = [frag]
  // ⚠️ SLICED out of the fragment, never re-joined from split words: `acceptPhrase` finds the
  // stretch again by substring, and a tail rebuilt with single spaces would not be found in a
  // fragment that happens to contain two.
  const starts: number[] = []
  for (let i = 1; i < frag.length; i++) {
    if (/\s/.test(frag[i - 1]) && !/\s/.test(frag[i])) starts.push(i)
  }
  for (const at of starts.slice(-MAX_TAIL_WORDS)) {
    const tail = frag.slice(at)
    if (tail.length >= MIN_TAIL) out.push(tail)
  }
  return out
}

/** Best phrase completions for what's being typed — empty until the fragment is meaningful,
 *  and a phrase already typed out in full stops suggesting itself. */
export function suggestPhrases(text: string, phrases: readonly string[]): PhraseMatch[] {
  const frag = currentFragment(text)
  if (frag.length < MIN_FRAGMENT) return []
  for (const cand of fragmentTails(frag)) {
    const hits = phrases
      .map((phrase) => ({ phrase, score: fuzzyScore(cand, phrase), frag: cand }))
      // ⚠️ «already typed out» is judged against the WHOLE fragment, not the tail being matched.
      // Against the tail alone, «Feuer aus» typed in full fell through to the tail «aus», which
      // the phrase contains — so the completion the operator had just finished typing offered
      // itself back to them.
      .filter((m) => m.score > 0 && !norm(frag).endsWith(norm(m.phrase)))
      // one letter reaches only what it actually begins — see MIN_LOOSE
      .filter((m) => cand.length >= MIN_LOOSE || norm(m.phrase).startsWith(norm(cand)))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUGGESTIONS)
    // the longest stretch that completes to something wins; only fall back to a shorter tail
    // when the longer one matches nothing at all
    if (hits.length) return hits
  }
  return []
}

/** Replace the matched stretch with the accepted phrase, keeping everything before it.
 *  `frag` comes off the PhraseMatch — see PhraseMatch.frag for why it is not recomputed here. */
export function acceptPhrase(text: string, phrase: string, frag: string): string {
  const at = frag ? text.lastIndexOf(frag) : -1
  // -1 can only mean the text moved on since the suggestion was computed; appending beats
  // slicing by a negative index, which would silently eat the last character of the entry
  return `${at >= 0 ? text.slice(0, at) : text}${phrase}`
}
