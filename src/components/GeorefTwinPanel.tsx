/** The details/editor for a «Zwilling».
 *
 * A twin is still only a projection: every callback supplied here writes through to the ONE
 * source object on the other surface. That lets the operator work where the object is visible
 * without creating a second object or changing ownership. The subtitle keeps the provenance
 * explicit («Gespiegelt …»); «Zum Original» remains a navigation aid, not an editing gate.
 */
import { ContextPanel, type ContextPanelProps, type SymbolView } from './ContextPanel'

export interface GeorefTwinPanelProps extends Omit<ContextPanelProps, 'entity'> {
  entity: SymbolView
  /** Visible provenance, e.g. «Gespiegelt von der Karte». */
  subtitle: string
}

export function GeorefTwinPanel({ entity, subtitle, ...props }: GeorefTwinPanelProps) {
  return <ContextPanel key={entity.id} entity={{ ...entity, subtitle }} {...props} />
}
