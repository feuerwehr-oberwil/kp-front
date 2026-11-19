// «Üben»: the 17 drills in their three modules (owner pick, round 2026-11-19-ueben-zeigen: «if
// each section is only 2-3 steps we can also group a few things»). The ORDER is the order on the
// sheet and the one «Als Nächstes» walks. A drill listed here without an entry in `RUNNABLE` is
// shown as «bald» – it has its title, not yet its goals.

import { appConfig } from '../../config/appConfig'
import { fahrzeugLeitung } from './fahrzeugLeitung'
import type { Drill, DrillId, ModuleId } from './model'

export const MODULES: readonly { id: ModuleId; drills: readonly DrillId[] }[] = [
  { id: 'karteWasser', drills: ['fahrzeugLeitung', 'absperrkreis', 'messen', 'leitungRechnen', 'pumpenVerschieben'] },
  { id: 'atemschutzGebaeude', drills: ['truppAnmelden', 'funkkontakt', 'rueckzug', 'notfall', 'truppGeschoss', 'gefahrUg'] },
  { id: 'protokollAbschluss', drills: ['eintrag', 'pendenz', 'checkliste', 'anwesenheit', 'material', 'fehlalarm'] },
]

const RUNNABLE: Partial<Record<DrillId, Drill>> = { fahrzeugLeitung }

export const drillById = (id: DrillId): Drill | undefined => RUNNABLE[id]

export const ALL_DRILLS: readonly DrillId[] = MODULES.flatMap((m) => m.drills)

export const isDrillId = (v: unknown): v is DrillId => typeof v === 'string' && (ALL_DRILLS as readonly string[]).includes(v)

/** Where a drill stands in its module: «Karte & Wasser · 1 / 5». */
export function drillPlace(id: DrillId): { module: ModuleId; i: number; n: number } {
  const m = MODULES.find((x) => x.drills.includes(id))!
  return { module: m.id, i: m.drills.indexOf(id) + 1, n: m.drills.length }
}

/** The first runnable drill not done on this device, after `after` when given (wrapping round). */
export function nextDrill(done: ReadonlySet<DrillId>, after?: DrillId): DrillId | null {
  const start = after ? ALL_DRILLS.indexOf(after) + 1 : 0
  const order = [...ALL_DRILLS.slice(start), ...ALL_DRILLS.slice(0, start)]
  return order.find((id) => RUNNABLE[id] && !done.has(id) && id !== after) ?? null
}

/** A drill's copy: the title always, the task and goal words where the drill can run. */
export function drillCopy(id: DrillId): { title: string; task?: string; goals?: Record<string, string> } {
  return appConfig.copy.ueben.drills[id]
}
