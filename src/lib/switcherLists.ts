// Which other Einsätze the Einsatz-Menü (IncidentSwitcher) lists under the active card. Pure —
// no React/DOM, node-testable; the menu only formats what comes back.
import { isIncidentRunning, type IncidentMeta } from './incidents'

/** Newest first. `started_at` is an ISO-8601 string, so a lexical compare is chronological. */
const byNewest = (a: IncidentMeta, b: IncidentMeta) => (a.started_at < b.started_at ? 1 : -1)

/**
 * The RUNNING Einsätze other than the active one, newest first.
 *
 * Only running ones: the menu is for switching to something that is still going. Anything that
 * is over lives behind «Alle Einsätze», where it can be searched and grouped — a short list of
 * recent ones in the menu was neither (dropped 2026-08-26).
 *
 * ⚠️ Ids are de-duplicated, FIRST copy wins — the polled list can carry the same Einsatz twice
 * (a page appended while it was being re-fetched, a merge of two sources), and the menu renders
 * the rows with `key={i.id}`: a repeated id there is a duplicate React key, and one of the two
 * rows silently never appears. The first copy is the fresher one, in poll order.
 */
export function runningOthers(incidents: IncidentMeta[], activeId: string | null): IncidentMeta[] {
  const seen = new Set<string>()
  return incidents
    .filter((i) => {
      if (seen.has(i.id)) return false
      seen.add(i.id) // …marked even when it is dropped below, so a later copy of it stays dropped too
      return i.id !== activeId && isIncidentRunning(i)
    })
    .sort(byNewest)
}
