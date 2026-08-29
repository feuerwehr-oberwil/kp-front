import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { floorLabel } from './whiteboard'
import type { Drawing } from '../types'

/**
 * What changed on a drawing, in words — the Verlauf line for editing a line/Fläche on the Kroki.
 *
 * The same gap entityEditChanges (lib/entityEdit) closed for symbols: a Leitung got one row when
 * it was drawn and one when it went, and everything that gives it MEANING in between — the
 * Schaum letter, the Leitungs-Nummer, the Stockwerk, the Abschluss — changed the picture the
 * Einsatz is led from without a line in the record. Each row names the VALUE, never just the
 * field, because a printed rapport cannot be clicked.
 *
 * ⚠️ Styling and geometry are deliberately absent — colour, width, dash, coordinates, the label
 * offsets — for the same reason entityEdit skips geometry: they change continuously while
 * somebody arranges the picture, and a row per nudge buries the edits that carry meaning. The
 * LABEL is also absent here: it already writes its own row (useMapDrawing · noteDrawingLabel),
 * and a second one would read as a phantom edit.
 */

/** The one Abschluss a line end shows, derived the way the DrawEditor's radio reads the three
 *  flags (Teilstück replaces the arrow; the Stopp bar rides on the arrow). */
type LineEnding = 'none' | 'arrow' | 'arrowStop' | 'teilstueck'
const endingOf = (d: Drawing): LineEnding =>
  d.teilstueck ? 'teilstueck' : d.arrow ? (d.arrowStop ? 'arrowStop' : 'arrow') : 'none'

export function drawingEditChanges(prev: Drawing, next: Drawing): string[] {
  const L = appConfig.copy.log
  const E = appConfig.copy.drawingEditor
  const out: string[] = []

  // ── Inhalt: the FKS device letter (S/W/H/P). Unset is not «cleared» — it is Wasser, a value
  // of its own, and the row says so the way the editor does.
  if ((prev.content ?? '') !== (next.content ?? '')) {
    const value = next.content ? (appConfig.copy.lineDecor[next.content] ?? next.content) : E.contentPlain
    out.push(fillTemplate(L.fieldSet, { field: E.content, value }))
  }

  // ── Leitung Nr.: the identity the Atemschutzüberwachung knows its hose by ──
  if (prev.lineNo !== next.lineNo) {
    out.push(next.lineNo == null
      ? fillTemplate(L.fieldCleared, { field: E.lineNo })
      : fillTemplate(L.fieldSet, { field: E.lineNo, value: String(next.lineNo) }))
  }

  // ── Stockwerk badge — same wording as a symbol's storey (lib/entityEdit) ──
  if (prev.floorTag !== next.floorTag) {
    out.push(next.floorTag == null ? L.floorCleared : fillTemplate(L.floorSet, { value: floorLabel(next.floorTag) }))
  }

  // ── Abschluss: arrow / arrow-with-stop / Teilstück, as ONE statement. The Entwicklungsgrenze
  // bar is the row the record is read for — «bis hier, und dort gestoppt» — and it used to
  // appear and vanish silently.
  if (endingOf(prev) !== endingOf(next)) {
    const labels: Record<LineEnding, string> = {
      none: E.endingNone, arrow: E.endingArrow, arrowStop: E.endingArrowStop, teilstueck: E.endingTeilstueck,
    }
    out.push(fillTemplate(L.fieldSet, { field: E.ending, value: labels[endingOf(next)] }))
  }

  return out
}

/** The name a Verlauf row calls this drawing — its own label, else its kind («Fläche»,
 *  «Absperrkreis», «Zeichnung»). Mirror of entityLogName. */
export function drawingLogName(d: Drawing): string {
  const kinds = appConfig.copy.log.drawKinds
  return (d.label ?? '').trim() || kinds[d.kind] || kinds.line
}
