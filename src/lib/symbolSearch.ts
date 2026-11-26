import { appConfig } from '../config/appConfig'
import { formatSymbolName } from './format'
import { matchesQuery, searchQuery } from './search'
import type { SymbolMeta } from '../types'

// Palette search matching — one place that decides what a query finds. A symbol matches when
// the query is a substring of any of: the raw FireGIS key, the localized display label, the
// configured synonyms (copy.symbolAliases), or its category heading (raw + localized) — so
// "wasser" surfaces every Hydrant and "UN"/"ADR" surface the Gefahrentafel.
//
// The tolerance itself lives in lib/search and is the same one every person picker uses:
// umlaut-neutral both ways (the raw keys spell «Sanitaet» where the display name has «Sanität»)
// and one typo forgiven from four characters up.

/** All searchable terms for a symbol. */
function haystack(s: SymbolMeta): string[] {
  const copy = appConfig.copy // read per call — module-level capture would freeze the locale
  return [
    s.name,
    formatSymbolName(s.name),
    ...(copy.symbolAliases[s.name] ?? []),
    s.cat,
    copy.symbolCategories[s.cat] ?? '',
  ].filter(Boolean)
}

/**
 * The station's OWN vehicles a query finds (owner picks UX journeys M·9 + M·10, 25.11.2026): «TLF»
 * found nothing, so a walker set a bare «Fahrzeug» and went looking for its name. `names` is the
 * generic Fahrzeug's Bezeichnung list (fleet.attributeLists · VKF Fahrzeug · title – what a placed
 * Fahrzeug can be called, so the palette and the editor agree; lib/symbols · symbolTitleOptions).
 * The palette shows them first, and the symbol is placed already named. Empty query → nothing.
 */
export function vehicleHits(names: readonly string[] | undefined, query: string): string[] {
  const q = searchQuery(query)
  if (!q || !names) return []
  return names.filter((n) => matchesQuery(q, n))
}

export function symbolMatchesQuery(s: SymbolMeta, query: string): boolean {
  // ⚠️ An empty query matches NOTHING here (the palette shows its categories instead), which is
  // the opposite of a list filter — hence the explicit check rather than `matchesRaw`.
  const q = searchQuery(query)
  if (!q) return false
  return haystack(s).some((t) => matchesQuery(q, t))
}
