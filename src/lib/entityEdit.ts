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
/** Prose as ONE Verlauf line: a note is typed with line breaks, and the Verlauf, the Rapport and
 *  the hash chain all read a row as a single string. Never truncated — the point of quoting the
 *  note is that the record holds what it said. */
const oneLine = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

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
    const v = oneLine(next.label)
    // ⚠️ A Notiz keeps its TEXT in `label` — «Beschriftung «Gasflaschen im Keller»» is the record
    // calling the note's contents a caption. Same field, different thing, so a different word.
    const set = next.kind === 'note' ? L.noteWritten : L.labelSet
    const cleared = next.kind === 'note' ? L.notesCleared : L.labelCleared
    out.push(v ? fillTemplate(set, { value: v }) : cleared)
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

  // Free notes on a symbol — QUOTED (reversed 11.08.). They used to be «said, never quoted», on
  // the reasoning that the Verlauf is not a second copy of the picture. But a note is not part of
  // the picture: it is a sentence somebody wrote because the symbol could not say it, and «Notiz
  // erfasst» is a row announcing that a sentence exists somewhere else. On the printed Rapport —
  // where the picture is a static Kroki nobody can click — that row carried no information at all.
  if ((prev.notes ?? '').trim() !== (next.notes ?? '').trim()) {
    const v = oneLine(next.notes)
    out.push(v ? fillTemplate(L.noteWritten, { value: v }) : L.notesCleared)
  }

  return out
}

/** The name a Verlauf row calls this symbol — its own label, else the symbol's name. */
export function entityLogName(e: Entity): string {
  return (e.label ?? '').trim() || e.symbol || appConfig.copy.entities.fallbackObjectName
}
