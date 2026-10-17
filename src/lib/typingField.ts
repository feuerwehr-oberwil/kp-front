/*
 * **A field iOS must not take for a contact form** (review round 3, 17.10.2026: the owner's iPhone
 * offered «AutoFill Contact» over the Karte's search and over the Gefahrgut UN field, with «home /
 * work» addresses as suggestions).
 *
 * Safari ignores `autocomplete="off"` for its contact AutoFill. It GUESSES from the field's name,
 * id, label and placeholder: «Adresse» reads as a postal address, «Nr.» as a phone or a house
 * number. What it does respect:
 *   · a field it classifies as a SEARCH — `name` containing «search» — gets no contact AutoFill;
 *   · words it cannot match: `defuseAutofill` puts an invisible WORD JOINER (U+2060 — no width, no
 *     line break, not read aloud) after a word's first letter, so «Adresse» still reads «Adresse»
 *     but no longer matches Safari's keyword list. Only for a field's own label / placeholder.
 * Plus the attributes every engine honours: no autocomplete, autocorrect, autocapitalise or spell
 * check (a UN number or «Stallenmattstr» corrected into a word is wrong), and the return key's
 * label (`enterKeyHint`).
 *
 * ONE helper for every text field on a surface that must not autofill (KarteApp's search, the
 * Gefahrgut UN field) — spread it, then the field's own props.
 */

import type { InputHTMLAttributes } from 'react'

export type TypingKind = 'search' | 'number'

/** `name` must stay unique per field on a page: `slug` is this field's own word. */
export function typingFieldProps(kind: TypingKind, slug: string): InputHTMLAttributes<HTMLInputElement> & Record<`data-${string}`, string> {
  return {
    name: `search-${slug}`,
    autoComplete: 'off',
    autoCorrect: 'off',
    autoCapitalize: 'none',
    spellCheck: false,
    enterKeyHint: 'search',
    inputMode: kind === 'number' ? 'numeric' : 'search',
    // password managers that inject their own AutoFill (1Password, LastPass, Bitwarden)
    'data-1p-ignore': 'true',
    'data-lpignore': 'true',
    'data-bwignore': 'true',
    'data-form-type': 'other',
  }
}

const JOINER = '⁠'

/** «Adresse oder Objekt» → «A⁠dresse o⁠der O⁠bjekt»: the same on screen and to a screen reader, no
 *  keyword for Safari's contact guess. Idempotent. */
export function defuseAutofill(text: string): string {
  return text.replace(new RegExp(JOINER, 'g'), '').replace(/(\p{L})(?=\p{L})/gu, (m, _c, offset: number, all: string) => {
    // only after a word's FIRST letter
    const prev = offset > 0 ? all[offset - 1] : ''
    return /\p{L}/u.test(prev) ? m : m + JOINER
  })
}
