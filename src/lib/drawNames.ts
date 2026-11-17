// The NAMES of the drawing editors' picture-only picks (button sweep audit A2/A3/A9/B15,
// 17.11.2026): a stroke, a fill, a palette colour. The row label, the hold bubble and the screen
// reader say «Gestrichelt», «Füllung 35 %», «Rot» – not a picture, a bare «35 %» or «#e8392b».
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'

/** A palette colour's NAME – the swatch's hold bubble and its screen-reader name say «Rot», not
 *  «#e8392b» (button sweep audit B15, 17.11.2026). A colour outside the palette keeps its code. */
export function colorName(c: string): string {
  return new Map(Object.entries(appConfig.copy.drawingEditor.colorNames)).get(c) ?? c
}

/** A fill swatch's name: «Ohne Füllung», «Füllung 35 %» (audit A9) – it held a bare «35 %». */
export function fillName(opacity: number): string {
  const c = appConfig.copy.drawingEditor
  return opacity === 0 ? c.fillNone : fillTemplate(c.fillPct, { n: Math.round(opacity * 100) })
}

const CHAINS = ['▲', '▼', '◯'] as const
type LineStroke = 'solid' | 'dashed' | (typeof CHAINS)[number]

/** Which of the five strokes a line wears – a chain marker wins over the dash (one stroke). */
export function lineStroke(dashed: boolean, marker: string | undefined): LineStroke {
  return CHAINS.find((c) => c === marker) ?? (dashed ? 'dashed' : 'solid')
}

/** The picked stroke's NAME, for the row label that names the pick («Linienart · Gestrichelt»,
 *  button sweep audit A3, 17.11.2026) – the five pictures said it only to a hold nobody teaches. */
export function lineStrokeName(dashed: boolean, marker: string | undefined): string {
  const c = appConfig.copy.drawingEditor
  const names: Record<LineStroke, string> = {
    solid: c.lineSolid, dashed: c.lineDashed, '▲': c.lineHalteliniUpShort, '▼': c.lineHalteliniDownShort, '◯': c.lineAbwurfzone,
  }
  return names[lineStroke(dashed, marker)]
}
