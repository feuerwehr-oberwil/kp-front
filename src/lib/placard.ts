import { appConfig } from '../config/appConfig'
import { lookupUN } from './unHazard'

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

// Big bold number; 4+ digit numbers are condensed to the plate width via textLength so
// they fill the plate without overflowing (no font-metric guessing).
const numText = (x: number, y: number, s: string) => {
  const tl = s.length >= 4 ? ` textLength="90" lengthAdjust="spacingAndGlyphs"` : ''
  return `<text x="${x}" y="${y}" dy="0.35em" font-size="46"${tl} fill="#111" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700">${s}</text>`
}

/**
 * Orange ADR Warntafel (Gefahrentafel) with the Gefahrnummer (Kemler, top half) over
 * the UN-Nr (bottom half) — the real orange plate, so it's recognised at a glance (the
 * 3am tenet: recognition over recall). Falls back to a single-number plate when no
 * Kemler is known. The number is baked INTO the glyph exactly the way the TLF / live
 * vehicle bakes its name (see lib/useVehiclePositions · vehicleSymbolSvg).
 */
export function placardSvg(un: string, kemler?: string | null): string {
  const u = esc((un || '').trim())
  const k = esc((kemler || '').trim())
  const orange = '#F08000'
  // viewBox is tight to the plate (no internal margin) so it fills the square symbol box
  // as large as possible — a 4:3.6 plate, chunkier than a real ADR plate for map legibility.
  const head =
    `<svg viewBox="0 0 100 84" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">`
  if (k) {
    return (
      head +
      `<rect x="2" y="3" width="96" height="78" rx="7" fill="${orange}" stroke="#111" stroke-width="5"/>` +
      `<line x1="2" y1="42" x2="98" y2="42" stroke="#111" stroke-width="5"/>` +
      numText(50, 23, k) +
      numText(50, 62, u) +
      `</svg>`
    )
  }
  return (
    head +
    `<rect x="2" y="3" width="96" height="78" rx="7" fill="${orange}" stroke="#111" stroke-width="5"/>` +
    numText(50, 43, u) +
    `</svg>`
  )
}

/**
 * If this symbol is the Gefahrentafel and carries a UN-Nr, render it as the orange plate
 * with the number(s) baked in — the Kemler/Gefahrnummer is auto-derived from the ADR
 * table, so typing only the UN number is enough. Returns null for any other symbol (or a
 * Gefahrentafel without a UN-Nr → the empty library plate shows instead).
 */
export function placardSvgForSymbol(symbol?: string, fields?: Record<string, string>): string | null {
  if (symbol !== appConfig.symbols.placardName) return null
  const un = fields?.[appConfig.copy.contextPanel.unField]?.trim()
  if (!un) return null
  return placardSvg(un, lookupUN(un)?.hazardNumber ?? null)
}
