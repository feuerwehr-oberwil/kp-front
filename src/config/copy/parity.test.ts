import { describe, it, expect } from 'vitest'
import { de } from './de'
import { en } from './en'
import { fr } from './fr'
import { it as itLoc } from './it'

// The i18n contract has two halves. copy.test.ts pins the first — a missing key falls back to
// German, so a half-translated locale is always COMPLETE. This file pins the second: no locale
// is half-translated in the first place.
//
// The fallback is what makes that guard necessary rather than optional. A forgotten string does
// not break anything or show up in a test; it just quietly renders in German, and a French crew
// meets it for the first time during an Einsatz. Before 2026-08-14 that was 567 strings in en
// and 867 in fr/it — whole surfaces (Mittel, Zeitplan, Schichten) in German. Nobody had a way
// to see it.
//
// So: add a German string, and this fails until every locale has one too.

/** German ON PURPOSE — never translate these, and the overlays deliberately omit them.
 *
 *  ⚠️ None of these are copy. They are values something else MATCHES AGAINST, so translating
 *  them breaks the match rather than localising anything:
 *    • intake.kategorien / kategorieGuess — mirror the backend's VKF Schadenkategorien and are
 *      matched against German alarm keyword text (app/divera.py · data/alarm_keywords.json).
 *    • contextPanel.unField / stoffField — detail-row DATA keys the UN→substance autofill reads.
 *    • contextPanel.unLookupUrl — an address.
 *    • primarySymbol.id / icon — a tool id and a sprite name; «plus-bold» translated renders
 *      no icon at all.
 *    • journal.reminderChips — minute values, not words. */
const INTENTIONALLY_GERMAN = new Set([
  'intake.kategorien',
  'intake.kategorieGuess',
  'contextPanel.unField',
  'contextPanel.stoffField',
  'contextPanel.unLookupUrl',
  'primarySymbol.id',
  'primarySymbol.icon',
  'journal.reminderChips',
])

type Any = Record<string, unknown>

/** Every leaf of the German base that this overlay does not carry, as dotted paths.
 *  Functions are skipped: a locale inherits them by design (see copy.test.ts). */
function untranslated(base: Any, over: Any | undefined, path = '', out: string[] = []): string[] {
  for (const [k, v] of Object.entries(base)) {
    const p = path ? `${path}.${k}` : k
    if (typeof v === 'function' || INTENTIONALLY_GERMAN.has(p)) continue
    const o = over?.[k]
    // an array is replaced wholesale by an overlay, so it is one leaf, not a list of them
    if (Array.isArray(v)) { if (o === undefined) out.push(p); continue }
    if (v && typeof v === 'object') { untranslated(v as Any, o as Any | undefined, p, out); continue }
    if (o === undefined) out.push(p)
  }
  return out
}

describe('every locale is fully in sync with the German base', () => {
  for (const [name, overlay] of [['en', en], ['fr', fr], ['it', itLoc]] as const) {
    it(`${name} leaves nothing to fall back to German`, () => {
      // the message names the offenders — a bare «expected 12 to be 0» would send you hunting
      expect(untranslated(de as unknown as Any, overlay as unknown as Any)).toEqual([])
    })
  }
})
