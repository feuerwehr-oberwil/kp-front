import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { linePresetLabel } from './lineStyle'
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
  //
  // ⚠️ A REPLACEMENT says so («Typ auf Gegenfeuer geändert»), the same rule every symbol field
  // already follows (lib/entityEdit). Written as a bare «Typ: X» each time, somebody dialling
  // through the presets left three consecutive rows — «Typ: Nasse Haltelinie», «Typ: Gegenfeuer»,
  // «Typ: Wasser» (03.09., 07:52) — that read on paper as three properties holding at once
  // rather than as one line whose type was corrected twice.
  if ((prev.content ?? '') !== (next.content ?? '')) {
    const label = (c: string | undefined) => (c ? (appConfig.copy.lineDecor[c] ?? c) : E.contentPlain)
    out.push(fillTemplate(prev.content ? L.fieldChanged : L.fieldSet, { field: E.content, value: label(next.content) }))
  }

  // ── Leitung Nr.: the identity the Atemschutzüberwachung knows its hose by ──
  if (prev.lineNo !== next.lineNo) {
    out.push(next.lineNo == null
      ? fillTemplate(L.fieldCleared, { field: E.lineNo })
      : fillTemplate(prev.lineNo == null ? L.fieldSet : L.fieldChanged, { field: E.lineNo, value: String(next.lineNo) }))
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
    // …and the same «geändert» rule: a line that HAD an Abschluss and got another one is a
    // correction, not a second Abschluss standing beside the first.
    out.push(fillTemplate(endingOf(prev) === 'none' ? L.fieldSet : L.fieldChanged, { field: E.ending, value: labels[endingOf(next)] }))
  }

  return out
}

/** The name a Verlauf row calls this drawing — its own label, else what it IS: a line reports the
 *  preset it was drawn with («Rettungsachse», «Pfeil») where that is recoverable, otherwise every
 *  kind falls back to its plain word («Fläche», «Absperrkreis», «Zeichnung»). Mirror of
 *  entityLogName, and the ONE place create, edit and delete rows take a drawing's name from, so
 *  «Rettungsachse gezeichnet» can never close on «Zeichnung gelöscht». */
export function drawingLogName(d: Drawing): string {
  const kinds = appConfig.copy.log.drawKinds
  const own = (d.label ?? '').trim()
  if (own) return own
  if (d.kind === 'line') {
    const preset = linePresetLabel(d)
    if (preset) return preset
  }
  return kinds[d.kind] || kinds.line
}
