// What a Karte undo step is CALLED — «Rückgängig: KP Front verschoben», never «Änderung auf der
// Karte» (staging 3am walk-through R3-3, 25.09.2026: a move, a dock and «Lösen» all read the
// generic word, and so did their «… rückgängig gemacht» Verlauf rows).
//
// The Karte's store lays its step at the commit, before the writer has said what it did. So the
// name is settled right after, in this order (IncidentWorkspace · onCheckpoint):
//   1. the writer named it itself (`stepLabel`: a placement, a drawn line, a take-over);
//   2. the Verlauf row the same act wrote — the operator's own words for it, already in the
//      record («Tafel angedockt an «TLF»», «KP Front verschoben»);
//   3. what changed in the store (`karteStepLabel` below), for the acts that write no row.
// Only when none of them has an answer does the domain word stay.

import { appConfig } from '../config/appConfig'
import { fillTemplate, formatSymbolName } from './format'
import { drawingLogName } from './drawingEdit'
import type { TacticalObject } from './tacticalObjects'

/** The operator's name for one object — its label, its symbol, what its line is called. */
export function objectName(o: TacticalObject): string {
  const e = o.entity
  if (e) return e.label?.trim() || (e.symbol ? formatSymbolName(e.symbol) : '') || appConfig.copy.entities.fallbackObjectName
  if (o.drawing) return drawingLogName(o.drawing)
  const a = o.sheet?.anno
  return a?.label?.trim() || (a?.symbol ? formatSymbolName(a.symbol) : '') || appConfig.copy.entities.fallbackObjectName
}

const movedOnly = (a: TacticalObject, b: TacticalObject): boolean => {
  if (a.entity && b.entity) {
    const { coord: _a, ...ra } = a.entity
    const { coord: _b, ...rb } = b.entity
    return JSON.stringify(ra) === JSON.stringify(rb) && JSON.stringify(a.entity.coord) !== JSON.stringify(b.entity.coord)
  }
  if (a.drawing && b.drawing) {
    const { coords: _a, ...ra } = a.drawing
    const { coords: _b, ...rb } = b.drawing
    return JSON.stringify(ra) === JSON.stringify(rb) && JSON.stringify(a.drawing.coords) !== JSON.stringify(b.drawing.coords)
  }
  return false
}

/**
 * Name a step by what it did to the store: one object set, drawn, moved, changed or removed —
 * «KP Front verschoben», «Zufahrt gezeichnet» — or «3 Objekte geändert». Null when nothing a
 * person would recognise changed (the caller keeps the domain word).
 */
export function karteStepLabel(before: readonly TacticalObject[], after: readonly TacticalObject[]): string | null {
  const U = appConfig.copy.undoDomains
  const L = appConfig.copy.log
  const was = new Map(before.map((o) => [o.id, o]))
  const now = new Map(after.map((o) => [o.id, o]))
  const added = after.filter((o) => !was.has(o.id) && !o.entity?.live)
  const removed = before.filter((o) => !now.has(o.id) && !o.entity?.live)
  const changed = after.filter((o) => { const b = was.get(o.id); return b && b !== o && JSON.stringify(b) !== JSON.stringify(o) })
  const n = added.length + removed.length + changed.length
  if (n === 0) return null
  if (n > 1) return fillTemplate(U.objectsChanged, { n })
  if (added.length) {
    const o = added[0]
    return fillTemplate(o.drawing ? L.shapeDrawn : U.symbolPlaced, { name: objectName(o) })
  }
  // «entfernt», never «gelöscht»: that word means extinguished on a fire-service Karte (#226)
  if (removed.length) return fillTemplate(U.objectRemoved, { name: objectName(removed[0]) })
  const o = changed[0]
  const b = was.get(o.id)!
  return fillTemplate(movedOnly(b, o) ? L.objectMoved : U.objectChanged, { name: objectName(o) })
}
