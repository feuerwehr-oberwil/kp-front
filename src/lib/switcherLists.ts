// What the Einsatz-Menü (IncidentSwitcher) shows below the active card, split into the two
// weights the dropdown renders: Einsätze that are RUNNING and «Frühere» ones. Pure — no
// React/DOM, node-testable; the menu only formats what comes back.
import { isIncidentRunning, type IncidentMeta } from './incidents'

/** Newest first. `started_at` is an ISO-8601 string, so a lexical compare is chronological. */
const byNewest = (a: IncidentMeta, b: IncidentMeta) => (a.started_at < b.started_at ? 1 : -1)

export interface SwitcherLists {
  /** other running Einsätze — strong rows, each with its elapsed time */
  running: IncidentMeta[]
  /** «Frühere» — closed/archived ones, newest first, capped at `pastCap` */
  past: IncidentMeta[]
  /** every Einsatz the menu knows of, the active one included — the «Alle Einsätze (n)» count */
  total: number
}

/**
 * Split the two lists the menu is handed: `open` is the list the app polls (non-archived),
 * `archived` the lazily fetched archive. They overlap in edge cases (an Einsatz archived
 * between the two fetches), so ids are deduplicated — `open` wins, it is the fresher of the two.
 *
 * The active Einsatz is dropped from both lists (its card sits above them) but still counts
 * towards `total`, which answers «Alle Einsätze (n)».
 */
export function switcherLists(
  open: IncidentMeta[],
  archived: IncidentMeta[],
  activeId: string | null,
  pastCap = 4,
): SwitcherLists {
  const byId = new Map<string, IncidentMeta>()
  for (const i of [...open, ...archived]) if (!byId.has(i.id)) byId.set(i.id, i)
  const others = [...byId.values()].filter((i) => i.id !== activeId)
  return {
    running: others.filter((i) => isIncidentRunning(i)).sort(byNewest),
    past: others.filter((i) => !isIncidentRunning(i)).sort(byNewest).slice(0, pastCap),
    total: byId.size,
  }
}
