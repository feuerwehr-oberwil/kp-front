/** The one «Zwilling» mark — the look both surfaces share.
 *
 *  Two renderers sit on top of it (GeorefTwinsMap, GeorefTwinsBoard), because the surfaces
 *  position differently (a MapLibre `<Marker>` at a lng/lat vs. an absolutely positioned child of
 *  `.wb-board` at a normalized point) but must LOOK identical: the same source glyph and caption.
 *  A twin that looked different on each side would be two features instead of one idea.
 *
 *  ⚠️ ONE mark per mirrored object, and the mark is the SYMBOL ITSELF. It used to stack a dashed
 *  ring, a ⇄ badge and an extra name plaque around that glyph. Half a dozen of them near each
 *  other read as a field of blue furniture instead of as the handful of source objects they are.
 *
 *  ⚠️ The mark lives in its own module so the PLAN surface never has to import MapLibre for it —
 *  the Whiteboard pulls in the board renderer alone, and react-map-gl comes nowhere near it.
 *
 *  The derivation (which points cross over, and the clip that keeps a vehicle two kilometres
 *  away off the sheet) is lib/georefTwins. This file only draws.
 *
 *  ⚠️ BOUNDARIES, and they are the whole design:
 *   • A twin is never a second editable object. A tap opens its read-only details; repositioning
 *     requires the explicit «Zum Original» jump, where the real object and its context are visible.
 *   • Nothing here writes directly: no workspace document, Verlauf row, clock or placement.
 *   • Nothing here prints. The Kroki payload and the plan pages are built from `entities` /
 *     `board` (lib/krokiPayload, backend kroki.py), and twins exist only in this render tree —
 *     there is no path by which one could reach a page.
 *   • Twins are not shown during replay: the georeference is station data that was never part
 *     of the recorded incident, and the vehicle feed is the present tense. The caller gates it
 *     (IncidentWorkspace passes empty lists while `replayActive`).
 */
import { TacticalSymbol } from '../lib/symbolRender'
import s from './GeorefTwins.module.css'

/**
 * The one mark, positioned by its caller.
 *
 * The same symbol renderer carries the source's caption decision across. Spread arrows, storey
 * badges and the Hubretter boom remain source-only details; the aerial boom in particular is
 * metre-scaled geometry that the projection has no honest length for.
 */
export function TwinMark({ svg, sizePx, rotation, count, caption, title, onOpen, interactive = true, selected = false, style, className }: {
  svg: string
  sizePx: number
  rotation: number
  count?: number
  /** Exactly the caption the source surface gives this symbol. Null means neither source nor
   *  projection invents a name plaque merely because it crossed the georeference. */
  caption?: string | null
  title: string
  /** tap: open this twin's source details, read-only (editing still belongs to the source) */
  onOpen: () => void
  /** the surface is in its resting state and the tap may open the details. False ⇒ inert (see
   *  .inert): a tool is armed, or the pairing mode is running, and the tap belongs to that. */
  interactive?: boolean
  /** The projection whose shared detail panel is open gets the same selection halo as its
   *  source object. Selection cannot look weaker merely because it is being viewed through the
   *  georeference, even though movement belongs exclusively to the original. */
  selected?: boolean
  style?: React.CSSProperties
  className?: string
}) {
  return (
    <button
      type="button"
      className={`${s.twin} ${interactive ? '' : s.inert} ${className ?? ''}`}
      style={{ width: sizePx, height: sizePx, '--hbox': `${sizePx}px`, ...style } as React.CSSProperties}
      title={title}
      aria-label={title}
      tabIndex={interactive ? 0 : -1}
      // The projection owns only the tap that opens its read-only details; all movement gestures
      // belong to the surrounding map/plan until the operator jumps to the original object.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onOpen() }}
    >
      {selected && <span className="sel-halo" aria-hidden />}
      <TacticalSymbol svg={svg} sizePx={sizePx} rotation={rotation} count={count} caption={caption} />
    </button>
  )
}
