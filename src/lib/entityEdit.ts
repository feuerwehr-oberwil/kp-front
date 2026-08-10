import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { floorLabel } from './whiteboard'
import type { Entity } from '../types'

/**
 * What changed on a tactical symbol, in words — the Verlauf line for editing the Kroki.
 *
 * The Kroki is the picture the Einsatz is led from, and until now the record said only that a
 * symbol had been PLACED, MOVED or REMOVED. Everything that happens to it in between — the
 * Stockwerk it turns out to be on, the name of the Einsatzleiter typed into its field, the
 * Anzahl going from one Person to three, an Ausbreitung appearing — was written straight into
 * the document with no row at all. So the Verlauf recorded the moment a symbol appeared and
 * then nothing, while the picture it describes went on changing for two hours.
 *
 * Pure, and it names the VALUE, never just the field: «Stockwerk geändert» sends a reader to the
 * replay to find out what it became, which is the one thing a printed record cannot do.
 *
 * ⚠️ Geometry is deliberately absent. Dragging, rotating and resizing happen continuously while
 * somebody arranges the picture; a row per nudge would bury the four or five edits that carry
 * meaning. `objectMoved` still logs a move as its own event, and the replay holds every frame.
 */
export function entityEditChanges(prev: Entity, next: Entity): string[] {
  const L = appConfig.copy.log
  const out: string[] = []

  // ── the roster/attribute fields typed onto a symbol («Name», «Fahrer», «Stoff», «Status») ──
  // These are the ones somebody asks about afterwards: who was named as Einsatzleiter, and when.
  const before = prev.fields ?? {}
  const after = next.fields ?? {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = (before[key] ?? '').trim()
    const b = (after[key] ?? '').trim()
    if (a === b) continue
    if (!b) out.push(fillTemplate(L.fieldCleared, { field: key }))
    else out.push(fillTemplate(a ? L.fieldChanged : L.fieldSet, { field: key, value: b }))
  }

  if ((prev.label ?? '').trim() !== (next.label ?? '').trim()) {
    const v = (next.label ?? '').trim()
    out.push(v ? fillTemplate(L.labelSet, { value: v }) : L.labelCleared)
  }

  // ── Stockwerk: a single storey, or the range a Treppe/Lift covers ──
  if (prev.floor !== next.floor) {
    out.push(next.floor == null ? L.floorCleared : fillTemplate(L.floorSet, { value: floorLabel(next.floor) }))
  }
  if (prev.floorFrom !== next.floorFrom || prev.floorTo !== next.floorTo) {
    const from = next.floorFrom, to = next.floorTo
    out.push(from == null && to == null
      ? L.floorRangeCleared
      : fillTemplate(L.floorRangeSet, {
          from: from == null ? '–' : floorLabel(from),
          to: to == null ? '–' : floorLabel(to),
        }))
  }

  if ((prev.count ?? 1) !== (next.count ?? 1)) {
    out.push(fillTemplate(L.countSet, { n: String(next.count ?? 1) }))
  }

  // Ausbreitung is a statement about how the damage is developing — the shape of it belongs in
  // the picture, but that it was recorded at all belongs in the record.
  if (JSON.stringify(prev.spread ?? null) !== JSON.stringify(next.spread ?? null)) {
    out.push(next.spread ? L.spreadSet : L.spreadCleared)
  }

  // free notes on a symbol / a Notiz box: said, never quoted — same rule the Rapport's prose
  // fields follow, because the Verlauf is not a second copy of the picture
  if ((prev.notes ?? '').trim() !== (next.notes ?? '').trim()) {
    out.push((next.notes ?? '').trim() ? L.notesWritten : L.notesCleared)
  }

  return out
}

/** The name a Verlauf row calls this symbol — its own label, else the symbol's name. */
export function entityLogName(e: Entity): string {
  return (e.label ?? '').trim() || e.symbol || appConfig.copy.entities.fallbackObjectName
}
