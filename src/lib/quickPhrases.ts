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
}

const norm = (s: string) =>
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

/** The fragment being typed: everything after the last sentence boundary (newline, '. ', '; '). */
export function currentFragment(text: string): string {
  const tail = text.split(/\n|(?<=[.;!?])\s+/).pop() ?? ''
  return tail.trimStart()
}

const MIN_FRAGMENT = 2
const MAX_SUGGESTIONS = 3

/** Best phrase completions for what's being typed — empty until the fragment is meaningful,
 *  and a phrase already typed out in full stops suggesting itself. */
export function suggestPhrases(text: string, phrases: readonly string[]): PhraseMatch[] {
  const frag = currentFragment(text)
  if (frag.length < MIN_FRAGMENT) return []
  return phrases
    .map((phrase) => ({ phrase, score: fuzzyScore(frag, phrase) }))
    .filter((m) => m.score > 0 && norm(m.phrase) !== norm(frag))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS)
}

/** Replace the typed fragment with the accepted phrase, keeping everything before it. */
export function acceptPhrase(text: string, phrase: string): string {
  const frag = currentFragment(text)
  const head = frag.length ? text.slice(0, text.length - frag.length) : text
  return `${head}${phrase}`
}
