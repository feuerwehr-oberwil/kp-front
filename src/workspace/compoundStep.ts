/**
 * ONE compound act on the Einsatz's undo timeline — a hose drawn and the Trupp link its end
 * makes, an end snapped onto a crew marker, a Drehung with its re-glued marks: one timeline
 * group, and in it ONE store step, the first one laid. Created once by IncidentWorkspace and
 * asked by the writers that take part:
 *
 * - `open` — the act begins (Whiteboard · historyGroup, useMapDrawing · historyGroup); returns
 *   its end. Inside an open act it joins it.
 * - `laid` — the store just laid a step (useObjectStore · onCheckpoint); answers whether that step
 *   writes no Verlauf row of its own.
 * - `takeIntoStore` — a plan step is being laid (usePlanStacks · takeIntoStore): inside an act
 *   the act's store step takes it, laid now through `lay` if none stands yet.
 * - `holds` — an act is open and its store step stands (useObjectStore · holdsStep): a foreign
 *   sheet edit inside it lays no second one.
 * - `linkCheckpoint` — the picture half of a Trupp link (truppActions/core · checkpointStore):
 *   none inside an act whose store step stands, else a SILENT one — the link's Trupp half writes
 *   the counter-row.
 *
 * ⚠️ Why the store and not the plan stack: the store step restores the whole store, sheets
 * included, from the LIVE state. A plan step beside it restored a sheet view read one render
 * behind on ↷, and that view's foreign edit cleared the store's redo in the middle of the group;
 * and a link's own store step wrote a second «Änderung auf der Karte» row beside the Trupp's
 * (hunt 24.11.2026, review of #742).
 */
export function compoundSteps(group: () => () => void) {
  let current: { stored: boolean } | null = null
  let silentNext = false
  return {
    open: (): (() => void) => {
      if (current) return () => {}
      const act = { stored: false }
      current = act
      const end = group()
      return () => {
        if (current === act) current = null
        end()
      }
    },
    laid: (): { silent: boolean } => {
      const silent = silentNext
      silentNext = false
      if (current) current.stored = true
      return { silent }
    },
    holds: (): boolean => !!current?.stored,
    takeIntoStore: (lay: () => void): boolean => {
      if (!current) return false
      if (!current.stored) lay()
      return true
    },
    linkCheckpoint: (lay: () => void) => {
      if (current?.stored) return
      silentNext = true
      try { lay() } finally { silentNext = false }
    },
  }
}
