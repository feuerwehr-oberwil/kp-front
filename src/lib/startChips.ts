import type { TimelineEvent } from '../types'

/** One chip offered while the field is still empty: what it says, and what it writes. */
export interface StartChip {
  label: string
  /** the text the field is set to — an opener keeps the caret going, a phrase is the sentence */
  insert: string
  /** an opener starts the line («EL → »), a phrase IS the line — they are inked differently */
  kind: 'opener' | 'phrase'
}

/**
 * What the composer offers before a single letter is typed.
 *
 * ⚠️ There has been no static chip row here since 02.07.2026 — the Textbausteine became
 * autocomplete because a permanent strip of them competed with the sentence. This is the other
 * half of that decision, not a reversal: the chips exist ONLY while the field is empty and are
 * gone with the first keystroke, so nothing competes while anybody is writing. What they buy is
 * the first tap of an entry, which is the one moment a blank field says nothing about what goes
 * in it.
 *
 * The order is deliberate:
 *   1. the OPENER («EL → »). A Verlauf is a Funkprotokoll and its most common first token is a
 *      post, not a word — and unlike a phrase it is right on every kind of Einsatz.
 *   2. what THIS Einsatz has already written. The second «Rückmeldung an ELZ» of the night is far
 *      likelier than any list's favourite, and it needs no configuration to be right.
 *   3. the station's own list, in its own order (deployment config journal.quickPhrases) — which
 *      is where a Wehr defines what its people should find here.
 *
 * Derived from the timeline, so it costs no stored state: the record already knows what was
 * written on this Einsatz.
 */
export function startChips(
  timeline: readonly TimelineEvent[],
  phrases: readonly string[],
  opener?: string,
  limit = 4,
): StartChip[] {
  const out: StartChip[] = []
  if (opener) out.push({ label: opener.trim(), insert: `${opener.trim()} `, kind: 'opener' })

  // how often each configured phrase stands in this incident's own rows. `includes`, because the
  // row text carries the Art tag in front of it («Auftrag · Wasserversorgung erstellt»).
  const used = new Map<string, number>()
  for (const e of timeline) {
    if (!e.text) continue
    for (const p of phrases) if (e.text.includes(p)) used.set(p, (used.get(p) ?? 0) + 1)
  }
  const ranked = [...used.entries()]
    // ties by the station's own order, so the list stays predictable early in an Einsatz
    .sort((a, b) => b[1] - a[1] || phrases.indexOf(a[0]) - phrases.indexOf(b[0]))
    .map(([p]) => p)

  for (const p of [...ranked, ...phrases]) {
    if (out.length >= limit) break
    if (out.some((c) => c.label === p)) continue
    out.push({ label: p, insert: p, kind: 'phrase' })
  }
  return out
}
