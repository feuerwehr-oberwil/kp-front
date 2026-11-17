import type { SymbolProps } from '../types'
import type { TacticalObject } from './tacticalObjects'
import { compareReadings, isMeasuredSymbol, symbolReading } from './symbols'
import { GEBAEUDE_PLAN_ID } from './whiteboard'
import { doneOf } from './objectDone'

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
 * Order: the live points in the one Messpunkt order (lib/symbols · compareReadings), the «erledigt»
 * ones below them (`worstFirst`) – the chip wears row one; a full tie keeps store order. `now`
 * decides which readings are stale.
 */
export function measuredPoints(
  objects: readonly TacticalObject[],
  names: { plan: (planId: string) => string; storey: (floor: number) => string; karte: string },
  now = Date.now(),
): MeasuredPoint[] {
  const out: MeasuredPoint[] = []
  for (const o of objects) {
    const sheet = o.sheet
    const props: (SymbolProps & { kind?: string }) | undefined = sheet ? sheet.anno : o.entity
    if (!props || props.kind !== 'symbol' || !isMeasuredSymbol(props)) continue
    if (sheet) {
      const floor = sheet.anno.floor ?? 0
      const where = sheet.planId === GEBAEUDE_PLAN_ID ? names.storey(floor) : names.plan(sheet.planId)
      out.push({ id: o.id, props, where, at: { surface: 'plan', planId: sheet.planId, x: sheet.anno.x ?? 0.5, y: sheet.anno.y ?? 0.5, floor } })
    } else {
      // the Messpunkt sets its storey as Von Geschoss (floorRange); a plain `floor` reads the same
      const floor = o.entity?.floor ?? o.entity?.floorFrom
      const where = floor == null ? names.karte : `${names.karte} · ${names.storey(floor)}`
      out.push({ id: o.id, props, where, at: { surface: 'map' } })
    }
  }
  return worstFirst(out, now)
}

/** `points` in the one Messpunkt order at `now` (compareReadings). Also the chip's own re-sort on
 *  its minute clock: a reading that turns stale moves down without any edit to the Einsatz.
 *  ⚠️ An «erledigt» point is out of the alarm ranking (ENT.3, 17.11.2026): every live point stands
 *  above every done one, so the chip – which wears row one – never shouts for a cleared room; the
 *  done points keep the same order among themselves below. */
export function worstFirst(points: readonly MeasuredPoint[], now = Date.now()): MeasuredPoint[] {
  // Array.prototype.sort is stable: a full tie keeps the order given (the store's)
  return points.map((p) => ({ p, r: symbolReading(p.props, now) }))
    .sort((a, b) => doneLast(a.p.props, b.p.props) || compareReadings(a.r, b.r)).map(({ p }) => p)
}

/** The first key of every Messpunkt list (the chip's and the Gebäude's): live before «erledigt». */
export const doneLast = (a: SymbolProps, b: SymbolProps): number => Number(!!doneOf(a)) - Number(!!doneOf(b))
