import type { TimelineEvent } from '../types'
import { currentWord, suggestLinks } from './journalEntry'
import { linkParts, linkRanges, suggestNext, type JournalLink, type LinkKind } from './journalLinks'
import { fuzzyScore, norm, suggestPhrases } from './quickPhrases'
import type { StartChip } from './startChips'

export interface TextSelection { start: number; end: number }

export interface JournalSuggestion {
  label: string
  insert: string
  from: number
  to: number
  source: 'name' | 'phrase' | 'next' | 'starter' | 'arrow'
  kind?: LinkKind
  hint?: string
  opener?: boolean
}

/** One ranked, deduplicated band. Every offer carries the exact edit it will make. */
export function journalSuggestions(text: string, selection: TextSelection, opts: {
  vocab: JournalLink[]
  phrases: readonly string[]
  timeline: readonly TimelineEvent[]
  starters?: readonly StartChip[]
}): JournalSuggestion[] {
  if (selection.start !== selection.end) return []
  const caret = Math.max(0, Math.min(text.length, selection.start))
  const before = text.slice(0, caret)
  const word = currentWord(before)
  // When editing inside a word, replace its remainder too, but never the next word or punctuation.
  const wordEnd = word ? caret + (text.slice(caret).match(/^[\p{L}\p{N}_-]+/u)?.[0].length ?? 0) : caret
  const existingName = linkRanges(text, opts.vocab).find((r) => r.start < caret && caret <= r.end
    && r.kind !== 'url' && r.kind !== 'phone')
  const candidates: (JournalSuggestion & { score: number })[] = []
  for (const n of suggestLinks(before, opts.vocab)) {
    const range = existingName ? { from: existingName.start, to: existingName.end }
      : completionRange(text, caret, caret - word.length, wordEnd, n.name)
    candidates.push({ label: n.name, insert: `${n.name} `, ...range,
      source: 'name', kind: n.kind, hint: n.hint, score: 2000 + fuzzyScore(word, n.name) + word.length * 10 })
  }
  for (const m of suggestPhrases(before, opts.phrases)) {
    // Loose matches must not displace arrows or learned continuations after a completed name.
    const score = norm(m.phrase).startsWith(norm(m.frag))
      ? 2000 + m.score + m.frag.length * 10 : 500 + m.score
    candidates.push({ label: m.phrase, insert: m.phrase, ...completionRange(text, caret, caret - m.frag.length, wordEnd, m.phrase),
      source: 'phrase', score })
  }
  // Continuations only belong at the end; inside existing text we complete the local word.
  if (caret === text.length) {
    const last = linkParts(before.trimEnd(), opts.vocab).pop()
    if (last?.kind && last.kind !== 'url' && last.kind !== 'phone') {
      for (const arrow of ['→', '←']) candidates.push({ label: arrow, insert: `${arrow} `,
        from: caret, to: caret, source: 'arrow', score: 1500 })
    }
    suggestNext(before, opts).forEach((c, i) => candidates.push({
      label: c.label, insert: c.insert, kind: c.kind, from: caret, to: caret,
      source: 'next', score: 1000 - i,
    }))
    opts.starters?.forEach((c, i) => {
      if (norm(before).includes(norm(c.label))) return
      candidates.push({ label: c.label, insert: c.insert, from: caret, to: caret,
        source: 'starter', opener: c.kind === 'opener', score: 500 - i })
    })
  }
  const seen = new Set<string>()
  return candidates.sort((a, b) => b.score - a.score)
    .filter((c) => {
      const key = norm(c.label.trim())
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 6)
    .map(({ score: _score, ...c }) => c)
}

/** Include a name's already-written first/last words when the caret is inside that name. */
function completionRange(text: string, caret: number, from: number, to: number, label: string) {
  const hay = norm(text)
  const target = norm(label)
  for (let at = Math.max(0, caret - label.length); at <= from; at++) {
    if (at > 0 && /[\p{L}\p{N}_-]/u.test(text[at - 1])) continue
    if (hay.slice(at, at + label.length) === target && at + label.length >= caret
      && !/[\p{L}\p{N}_-]/u.test(text[at + label.length] ?? '')) {
      return { from: at, to: at + label.length }
    }
    if (target.startsWith(hay.slice(at, caret))) {
      // A misspelled word may still be followed by the correct rest of the name/phrase.
      const relative = caret - at
      const remainder = label.slice(relative).replace(/^[\p{L}\p{N}_-]+/u, '')
      if (remainder && hay.slice(to, to + remainder.length) === norm(remainder)
        && !/[\p{L}\p{N}_-]/u.test(text[to + remainder.length] ?? '')) to += remainder.length
      return { from: at, to }
    }
  }
  return { from, to }
}

/** Apply only the offered range and return the caret directly after the insertion. */
export function acceptJournalSuggestion(text: string, suggestion: JournalSuggestion): { text: string; caret: number } {
  const { from, to } = suggestion
  const head = text.slice(0, from)
  const tail = text.slice(to)
  let insert = suggestion.insert
  if (from === to && head && !/\s$/.test(head)) insert = ` ${insert}`
  if (/^[\s.,;:!?)]/.test(tail)) insert = insert.trimEnd()
  return { text: head + insert + tail, caret: head.length + insert.length }
}
