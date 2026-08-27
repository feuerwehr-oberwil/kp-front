/** How a «Zwilling» picks its glyph and its name.
 *
 *  Plain functions rather than part of the mark component, because both renderers
 *  (GeorefTwinsMap / GeorefTwinsBoard) need them and neither owns them — see
 *  components/GeorefTwinMark for what a twin is, and lib/georefTwins for where it comes from.
 */
import { appConfig } from '../config/appConfig'
import { placardSvgForSymbol } from './placard'
import { compositeSpec, luefterVariant } from './symbolRender'
import type { BoardAnno, Entity } from '../types'

/** The glyph a plan annotation or a map entity draws — the same resolution both surfaces use,
 *  minus the composite overlay (see TwinMark). A composite falls back to its BASE body, which is
 *  the readable half; the fan/ladder it is missing is on the sheet that owns it. */
export function glyphFor(o: BoardAnno | Entity, byName: Record<string, string>): string {
  const comp = compositeSpec(o.symbol)
  if (comp) return byName[comp.base] ?? ''
  const placard = placardSvgForSymbol(o.symbol, o.fields)
  if (placard) return placard
  if ('symbolSvg' in o && o.symbolSvg) return o.symbolSvg
  if (!o.symbol) return ''
  return byName[luefterVariant(o.symbol, o.extract) ?? o.symbol] ?? byName[o.symbol] ?? ''
}

/** The name on a twin's label — never empty, so the plaque always says what it mirrors. */
export const twinName = (o: { label?: string; symbol?: string; text?: string }) =>
  o.label?.trim() || o.symbol?.trim() || o.text?.trim() || appConfig.copy.whiteboard.georef.twinUnnamed
