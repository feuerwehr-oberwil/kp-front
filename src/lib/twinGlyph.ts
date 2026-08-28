/** How a «Zwilling» picks its glyph and its name.
 *
 *  Plain functions rather than part of the mark component, because both renderers
 *  (GeorefTwinsMap / GeorefTwinsBoard) need them and neither owns them — see
 *  components/GeorefTwinMark for what a twin is, and lib/georefTwins for where it comes from.
 */
import { appConfig } from '../config/appConfig'
import { placardSvgForSymbol } from './placard'
import { compositePartGlyph, compositeSpec, luefterVariant } from './symbolRender'
import type { BoardAnno, Entity } from '../types'

/** The glyph a plan annotation or a map entity draws — the same resolution both surfaces use.
 *  A composite draws its BASE body here; its fan/ladder rides on top via `overlayFor`. */
export function glyphFor(o: BoardAnno | Entity, byName: Record<string, string>): string {
  const comp = compositeSpec(o.symbol)
  if (comp) return byName[comp.base] ?? ''
  const placard = placardSvgForSymbol(o.symbol, o.fields)
  if (placard) return placard
  if ('symbolSvg' in o && o.symbolSvg) return o.symbolSvg
  if (!o.symbol) return ''
  return byName[luefterVariant(o.symbol, o.extract) ?? o.symbol] ?? byName[o.symbol] ?? ''
}

/** A composite's own part (the Lüfter fan, the Drehleiter ladder) over the twin's base body —
 *  the same overlay both source surfaces stack (MapMarkers / Whiteboard), aimed by `rotation2`
 *  plus the caller's frame change (the fit rotation, and on the Karte the live bearing), so the
 *  part points at the same piece of ground on both pictures. Undefined for plain symbols. */
export function overlayFor(
  o: BoardAnno | Entity, byName: Record<string, string>, rotationOffset = 0,
): { svg: string; rotation: number; scale?: number } | undefined {
  const comp = compositeSpec(o.symbol)
  if (!comp) return undefined
  const svg = byName[compositePartGlyph(comp, o.extract)] ?? byName[comp.part] ?? ''
  return svg ? { svg, rotation: (o.rotation2 ?? 0) + rotationOffset, scale: comp.scale } : undefined
}

/** The name on a twin's label — never empty, so the plaque always says what it mirrors. */
export const twinName = (o: { label?: string; symbol?: string; text?: string }) =>
  o.label?.trim() || o.symbol?.trim() || o.text?.trim() || appConfig.copy.whiteboard.georef.twinUnnamed
