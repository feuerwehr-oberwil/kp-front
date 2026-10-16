import { Icon } from '../lib/icons'
import { planGlyph } from '../lib/navRail'
import type { PlanDocument } from '../types'

// precomposed Unicode fraction glyphs for combined-module monograms (clean proper fractions);
// anything without one falls back to a compact diagonal rendering.
const FRAC_GLYPH: Record<string, string> = {
  '1/2': '½', '1/3': '⅓', '2/3': '⅔', '1/4': '¼', '3/4': '¾', '1/6': '⅙', '5/6': '⅚',
}

/** the glyph a plan tile wears — the document's monogram chip or its icon. Shared by the
 *  per-document tiles of the vertical rail, by the phone's ONE folded «Pläne» tile, which
 *  shows the glyph of whichever document is loaded, and by «Karte & Objekte» (components/karte). */
export function PlanGlyph({ doc }: { doc: PlanDocument }) {
  const g = planGlyph(doc)
  if (!('mono' in g)) return <span className="nav-glyph"><Icon id={g.icon} /></span>
  if (g.mono.includes('/')) {
    // combined module ("2/3") as a proper typographic fraction — a precomposed glyph
    // (⅔ …) where one exists, else a compact diagonal fallback. Single-glyph footprint.
    return FRAC_GLYPH[g.mono] ? (
      <span className="nav-glyph mono nav-frac" aria-hidden><span className="nav-mono-chip">{FRAC_GLYPH[g.mono]}</span></span>
    ) : (
      <span className="nav-glyph mono nav-frac nav-frac-diag" aria-hidden><span className="nav-mono-chip">
        <span className="nav-frac-n">{g.mono.split('/')[0]}</span>
        <span className="nav-frac-s">/</span>
        <span className="nav-frac-d">{g.mono.split('/')[1]}</span>
      </span></span>
    )
  }
  // The glyph column is 46px wide and the chip has to fit INSIDE it, border and all. A single
  // digit does at 15px; a three-letter sub-slot acronym ("RWA") does not — it pushed its own
  // border past the rail edge. The letter count picks the size (see .nav-mono-chip), because
  // CSS can't count characters.
  return (
    <span className="nav-glyph mono" data-mono-len={g.mono.length}>
      <span className="nav-mono-chip">{g.mono}</span>
    </span>
  )
}
