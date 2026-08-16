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

/** Arrays an overlay has to match ELEMENT BY ELEMENT, keyed by the field that identifies an
 *  element – everywhere else an array is one leaf, because `deepMerge` replaces it wholesale.
 *
 *  ⚠️ That wholesale replacement is exactly why this list exists. A shorter overlay array does
 *  not fall back to German per entry; it DELETES the entries it does not repeat. `help.sections`
 *  carried 16 chapters in German and 13 in en/fr/it, so «Tastaturkürzel», «Rapport & Abschluss»
 *  and «Erfassung per QR» did not exist at all for a French or Italian station – and `locale` is
 *  a per-deployment setting, so nobody could reach them. Treating the array as a leaf made the
 *  gap invisible to the very test that promises it cannot happen. */
const KEYED_ARRAYS: Record<string, string> = { 'help.sections': 'id' }

type Any = Record<string, unknown>

/** The `{name}` placeholders a string carries, deduplicated and sorted. */
const tokensOf = (s: string): string[] => [...new Set(s.match(/\{[A-Za-z0-9_]+\}/g) ?? [])].sort()

type Findings = {
  /** German leaves this overlay does not carry, as dotted paths. */
  missing: string[]
  /** Translated strings whose interpolation placeholders no longer match the German original. */
  tokens: string[]
}

/** Walk the German base against one overlay. Functions are skipped: a locale inherits them by
 *  design (see copy.test.ts). */
function compare(base: Any, over: Any | undefined, path: string, out: Findings): Findings {
  for (const [k, v] of Object.entries(base)) {
    const p = path ? `${path}.${k}` : k
    if (typeof v === 'function' || INTENTIONALLY_GERMAN.has(p)) continue
    const o = over?.[k]
    if (Array.isArray(v)) {
      const idKey = KEYED_ARRAYS[p]
      if (idKey === undefined) { if (o === undefined) out.missing.push(p); continue }
      if (!Array.isArray(o)) { out.missing.push(p); continue }
      const byId = new Map(o.map((e) => [String((e as Any)?.[idKey]), e as Any]))
      for (const entry of v as Any[]) {
        const id = String(entry?.[idKey])
        const match = byId.get(id)
        if (match === undefined) { out.missing.push(`${p}[${idKey}=${id}]`); continue }
        compare(entry, match, `${p}[${id}]`, out)
      }
      continue
    }
    if (v && typeof v === 'object') { compare(v as Any, o as Any | undefined, p, out); continue }
    if (o === undefined) { out.missing.push(p); continue }
    // A dropped {token} renders the placeholder's VALUE nowhere – the pressure in an Atemschutz
    // Verlauf entry, the vehicle in a milestone. The string still reads as a sentence, which is
    // why nothing but a test catches it.
    if (typeof v === 'string' && typeof o === 'string') {
      const want = tokensOf(v)
      const got = tokensOf(o)
      if (want.join(' ') !== got.join(' ')) out.tokens.push(`${p}: expected ${want.join(' ') || '(none)'}, got ${got.join(' ') || '(none)'}`)
    }
  }
  return out
}

describe('every locale is fully in sync with the German base', () => {
  for (const [name, overlay] of [['en', en], ['fr', fr], ['it', itLoc]] as const) {
    const found = compare(de as unknown as Any, overlay as unknown as Any, '', { missing: [], tokens: [] })
    // the messages name the offenders — a bare «expected 12 to be 0» would send you hunting
    it(`${name} leaves nothing to fall back to German`, () => {
      expect(found.missing).toEqual([])
    })
    it(`${name} keeps every {placeholder} the German string carries`, () => {
      expect(found.tokens).toEqual([])
    })
  }
})
