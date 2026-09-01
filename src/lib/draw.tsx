import { appConfig } from '../config/appConfig'

// Single source of truth for line drawing style, shared by BOTH surfaces:
// the Lage map (MapLibre line layers) and the Plan whiteboard (SVG polylines).
// A line carries a `dashed?: boolean` flag in its data object (Drawing on the
// map, BoardAnno on the board); these constants turn that flag into the right
// dash geometry for each renderer (the units differ — MapLibre dashes are in
// line-width multiples, SVG non-scaling-stroke dashes are in px), and the
// LineStylePicker below is the one toggle UI used in every place a line style
// is chosen, so the two surfaces can never drift apart.

/** MapLibre `line-dasharray` (units = line-width multiples) */
export const LINE_DASH_ML: [number, number] = [2, 1.6]
/** SVG `stroke-dasharray` for non-scaling strokes (units = px) */
export const LINE_DASH_SVG = '6 5'

interface LineStylePickerProps {
  dashed: boolean
  onChange: (dashed: boolean) => void
  /** the line's repeated marker, when the host supports chain styles (lines, not areas) */
  marker?: string
  /** pass to offer the FKS chain styles. Absent = the plain solid/dashed pair, which is what an
   *  AREA gets: a Haltelinie is a line, and a toothed polygon outline means nothing. */
  onMarker?: (marker: string) => void
}

/**
 * How a line is stroked — solid, dashed, or one of the FKS chains.
 *
 * A fragment of buttons dropped into whatever style bar hosts it (map draw bar, DrawEditor,
 * whiteboard dock), so the choice is identical wherever it is made.
 *
 * ⚠️ The chains live HERE, next to solid and dashed, rather than as line PRESETS (decision
 * 01.09.). A Haltelinie is not a different kind of object with its own bundle of arrow/marker/
 * dash settings — it is a line drawn a different way, which is the question this control already
 * answers. Presets stay for what they are good at: «Rettungsachse» means arrow AND letter AND
 * dash together.
 *
 * Chain and dash are one choice because they are one stroke: picking a chain clears the dash so
 * the teeth sit on a solid line the way the sheet draws them, and picking solid or dashed clears
 * the chain. A letter marker (the «R») is cleared too — a line repeats one thing, not two.
 */
export function LineStylePicker({ dashed, onChange, marker, onMarker }: LineStylePickerProps) {
  const c = appConfig.copy.drawingEditor
  const CHAINS = ['▲', '▼', '◯'] as const
  const chain = (CHAINS as readonly string[]).includes(marker ?? '') ? marker! : ''
  const plain = (d: boolean) => { onChange(d); if (chain) onMarker?.('') }
  const pick = (m: string) => { onMarker?.(m); if (dashed) onChange(false) }
  return (
    <>
      <button className={`wb-ls ${!dashed && !chain ? 'on' : ''}`} title={c.lineSolid} aria-label={c.lineSolid} aria-pressed={!dashed && !chain} onClick={() => plain(false)}><span className="ls-solid" /></button>
      <button className={`wb-ls ${dashed && !chain ? 'on' : ''}`} title={c.lineDashed} aria-label={c.lineDashed} aria-pressed={dashed && !chain} onClick={() => plain(true)}><span className="ls-dashed" /></button>
      {onMarker && (
        <>
          {/* Both Haltelinien-Seiten are their own button rather than a flip on one: which side the
              teeth face is an operational fact (they face the fire) and cannot be read off the
              geometry, so it must be visible rather than a state you tap into. */}
          <button className={`wb-ls ${chain === '▲' ? 'on' : ''}`} title={c.lineHalteliniUp} aria-label={c.lineHalteliniUp} aria-pressed={chain === '▲'} onClick={() => pick('▲')}><span className="ls-teeth" /></button>
          <button className={`wb-ls ${chain === '▼' ? 'on' : ''}`} title={c.lineHalteliniDown} aria-label={c.lineHalteliniDown} aria-pressed={chain === '▼'} onClick={() => pick('▼')}><span className="ls-teeth down" /></button>
          <button className={`wb-ls ${chain === '◯' ? 'on' : ''}`} title={c.lineAbwurfzone} aria-label={c.lineAbwurfzone} aria-pressed={chain === '◯'} onClick={() => pick('◯')}><span className="ls-rings" /></button>
        </>
      )}
    </>
  )
}
