// «Üben»: the drills, in ONE list (owner pick, 20.11.2026: a few core drills instead of 17 in
// three modules – «a simple way to learn the app without being overwhelming»). The ORDER is the
// order on the sheet and the one «Als Nächstes» walks. Only a drill that runs is listed: a new
// drill joins `DRILLS` together with its copy (`copy.ueben.drills.<id>`), and the sheet, the
// progress and the e2e walker (e2e/ueben.spec.ts) pick it up from here.
//
// Every other function is practised without a drill: «Ausprobieren» in a Hilfe section opens the
// Übungsplatz on that surface (lib/ueben/tryOut).

import { appConfig } from '../../config/appConfig'
import { fahrzeugLeitung } from './fahrzeugLeitung'
import type { Drill } from './model'

export const DRILLS = [fahrzeugLeitung] as const satisfies readonly Drill[]

export type DrillId = (typeof DRILLS)[number]['id']

export const ALL_DRILLS: readonly DrillId[] = DRILLS.map((d) => d.id)

export const drillById = (id: DrillId): Drill | undefined => DRILLS.find((d) => d.id === id)

export const isDrillId = (v: unknown): v is DrillId => ALL_DRILLS.some((id) => id === v)

/** Where a drill stands in the list: «Üben · 1 / 6». */
export function drillPlace(id: DrillId): { i: number; n: number } {
  return { i: ALL_DRILLS.indexOf(id) + 1, n: ALL_DRILLS.length }
}

/** The first drill not done on this device, after `after` when given (wrapping round). */
export function nextDrill(done: ReadonlySet<DrillId>, after?: DrillId): DrillId | null {
  const start = after ? ALL_DRILLS.indexOf(after) + 1 : 0
  const order = [...ALL_DRILLS.slice(start), ...ALL_DRILLS.slice(0, start)]
  return order.find((id) => !done.has(id) && id !== after) ?? null
}

/** A drill's copy: title, intro, task and the goals' words. */
export function drillCopy(id: DrillId): { title: string; intro: string; task: string; goals: Record<string, string> } {
  return appConfig.copy.ueben.drills[id]
}
