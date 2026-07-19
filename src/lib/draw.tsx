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
}

/** Solid / dashed toggle — a fragment of two buttons, dropped directly into
 *  whatever style bar hosts it (map draw bar, DrawEditor, whiteboard dock). */
export function LineStylePicker({ dashed, onChange }: LineStylePickerProps) {
  const c = appConfig.copy.drawingEditor
  return (
    <>
      <button className={`wb-ls ${!dashed ? 'on' : ''}`} title={c.lineSolid} aria-label={c.lineSolid} aria-pressed={!dashed} onClick={() => onChange(false)}><span className="ls-solid" /></button>
      <button className={`wb-ls ${dashed ? 'on' : ''}`} title={c.lineDashed} aria-label={c.lineDashed} aria-pressed={dashed} onClick={() => onChange(true)}><span className="ls-dashed" /></button>
    </>
  )
}
