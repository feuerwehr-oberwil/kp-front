import type { SymbolProps } from '../types'
import type { TacticalObject } from './tacticalObjects'
import { isMeasuredSymbol, readingRank, symbolReading } from './symbols'
import { GEBAEUDE_PLAN_ID } from './whiteboard'

/** Where a Messpunkt is anchored, said the way the surface that holds it navigates to it */
export type MeasuredAt =
  | { surface: 'map' }
  | { surface: 'plan'; planId: string; x: number; y: number; floor: number }

/** One row of the «Messungen» list (ReadingsChip): the point, its place tag and its anchor */
export interface MeasuredPoint {
  id: string
  props: SymbolProps
  /** «2. OG» on the Gebäude, the plan's code on a Modul, «Karte» (with the storey, if set) on the map */
  where: string
  at: MeasuredAt
}

/**
 * Every Messpunkt of the Einsatz, worst first – the «Messungen» list (owner pick L2, 27.10.2026).
 *
 * Read off the tactical STORE, not the surface views: one object is one row however many surfaces
 * draw it, and its anchor says where a tap goes – the sheet it was placed on, else the Karte. A
 * point outside the building is a Karte row like any other (the Gebäude list never saw it).
 * Order: highest alarm stage first, then a measured point over one not measured yet; ties keep
 * store order.
 */
export function measuredPoints(
  objects: readonly TacticalObject[],
  names: { plan: (planId: string) => string; storey: (floor: number) => string; karte: string },
): MeasuredPoint[] {
  const out: (MeasuredPoint & { score: number })[] = []
  for (const o of objects) {
    const sheet = o.sheet
    const props: (SymbolProps & { kind?: string }) | undefined = sheet ? sheet.anno : o.entity
    if (!props || props.kind !== 'symbol' || !isMeasuredSymbol(props)) continue
    const r = symbolReading(props)
    const score = readingRank(r) * 2 + (r?.text ? 1 : 0)
    if (sheet) {
      const floor = sheet.anno.floor ?? 0
      const where = sheet.planId === GEBAEUDE_PLAN_ID ? names.storey(floor) : names.plan(sheet.planId)
      out.push({ id: o.id, props, where, score, at: { surface: 'plan', planId: sheet.planId, x: sheet.anno.x ?? 0.5, y: sheet.anno.y ?? 0.5, floor } })
    } else {
      // the Messpunkt sets its storey as Von Geschoss (floorRange); a plain `floor` reads the same
      const floor = o.entity?.floor ?? o.entity?.floorFrom
      const where = floor == null ? names.karte : `${names.karte} · ${names.storey(floor)}`
      out.push({ id: o.id, props, where, score, at: { surface: 'map' } })
    }
  }
  // Array.prototype.sort is stable: equal scores keep store order
  return out.sort((a, b) => b.score - a.score).map(({ score: _score, ...p }) => p)
}
