import { appConfig } from '../config/appConfig'
import { formatSymbolName } from './format'
import type { SymbolMeta } from '../types'

// Palette search matching — one place that decides what a query finds. A symbol matches when
// the query is a substring of any of: the raw FireGIS key, the localized display label, the
// configured synonyms (copy.symbolAliases), or its category heading (raw + localized) — so
// "wasser" surfaces every Hydrant and "UN"/"ADR" surface the Gefahrentafel. Umlaut-tolerant
// both ways: each term is also compared in its ae/oe/ue transliteration, mirroring how the
// raw keys ("Sanitaet") already pair with the umlaut display names ("Sanität").

const fold = (s: string) =>
  s.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')

/** All searchable terms for a symbol, lowercased (original + transliterated forms). */
function haystack(s: SymbolMeta): string[] {
  const copy = appConfig.copy // read per call — module-level capture would freeze the locale
  const terms = [
    s.name,
    formatSymbolName(s.name),
    ...(copy.symbolAliases[s.name] ?? []),
    s.cat,
    copy.symbolCategories[s.cat] ?? '',
  ].filter(Boolean)
  return terms.flatMap((t) => [t.toLowerCase(), fold(t)])
}

export function symbolMatchesQuery(s: SymbolMeta, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  const qFold = fold(q)
  return haystack(s).some((t) => t.includes(q) || t.includes(qFold))
}
