/** How a «Zwilling» picks its glyph and its name.
 *
 *  Plain functions rather than part of the mark component, because both renderers
 *  (GeorefTwinsMap / GeorefTwinsBoard) need them and neither owns them — see
 *  components/GeorefTwinMark for what a twin is, and lib/georefTwins for where it comes from.
 */
import { appConfig } from '../config/appConfig'
import { placardSvgForSymbol } from './placard'
import { compositePartGlyph, compositeSpec, isHubretter, luefterVariant } from './symbolRender'
import type { BoardAnno, Entity } from '../types'

/** The glyph a plan annotation or a map entity draws — the same resolution both surfaces use.
 *  A composite draws its BASE body here; its fan/ladder rides on top via `overlayFor`.
 *  A Hubretter likewise draws the plain Fahrzeug body; its boom rides on top via `boomFor`. */
export function glyphFor(o: BoardAnno | Entity, byName: Record<string, string>): string {
  const comp = compositeSpec(o.symbol)
  if (comp) return byName[comp.base] ?? ''
  // ⚠️ NOT `byName['VKF Hubretter']` — the pack carries that artwork too, and resolving it here
  // drew the twin as a DIFFERENT vehicle than the original (both source surfaces compose the
  // plain body plus a live boom, and so does the print path — lib/krokiPayload).
  if (isHubretter(o.symbol)) return byName[appConfig.symbols.vehicleName] ?? ''
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
): { svg: string; rotation: number; scale?: number; offsetX?: number } | undefined {
  const comp = compositeSpec(o.symbol)
  if (!comp) return undefined
  const svg = byName[compositePartGlyph(comp, o.extract)] ?? byName[comp.part] ?? ''
  return svg ? { svg, rotation: (o.rotation2 ?? 0) + rotationOffset, scale: comp.scale, offsetX: comp.offsetX } : undefined
}

/** The Hubretter boom a twin draws over its body — the same articulated arm both source
 *  surfaces render (MapMarkers / Whiteboard · HubretterBoom), aimed by `rotation2` plus the
 *  caller's frame change. `lengthPx` is the reach the CALLER resolved in its own surface's
 *  units, because a reach is metres on the Karte and a sheet fraction on the Plan. */
export function boomFor(
  o: BoardAnno | Entity, lengthPx: number, rotationOffset = 0,
): { lengthPx: number; deg: number } | undefined {
  return isHubretter(o.symbol) ? { lengthPx, deg: (o.rotation2 ?? 0) + rotationOffset } : undefined
}

/** The name on a twin's label — never empty, so the plaque always says what it mirrors. */
export const twinName = (o: { label?: string; symbol?: string; text?: string }) =>
  o.label?.trim() || o.symbol?.trim() || o.text?.trim() || appConfig.copy.whiteboard.georef.twinUnnamed
