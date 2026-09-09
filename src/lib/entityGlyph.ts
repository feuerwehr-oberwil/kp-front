/** How a map object picks the glyph and the name a surface draws it with.
 *
 *  Plain functions rather than part of a component, because more than one surface needs the same
 *  two answers and none of them owns the rule. (Written for the «Zwillinge», which is why they
 *  used to live in `twinGlyph.ts` — the projections are gone, the questions remain.)
 */
import { appConfig } from '../config/appConfig'
import { placardSvgForSymbol } from './placard'
import { compositeSpec, isHubretter, luefterVariant } from './symbolRender'
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

export const twinName = (o: { label?: string; symbol?: string; text?: string }) =>
  o.label?.trim() || o.symbol?.trim() || o.text?.trim() || appConfig.copy.whiteboard.georef.twinUnnamed
