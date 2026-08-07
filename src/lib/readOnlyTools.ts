// Which tools stay reachable when a surface is read-only (viewer role, Führungsansicht,
// a lost tab lock). The rule is narrow on purpose: a tool qualifies only if it writes NOTHING —
// not the document, not the synced workspace, not the audit stream, not the Verlauf. Messen is
// the whole point of this (see lib/useMeasure: its paths are ephemeral state and never saved);
// Auswahl comes with it so the read-only rail still shows the state you drop back into.
//
// The Einsatzleiter is the reason this exists: hands-off is about not changing the picture, not
// about being unable to ask how far the Leitung reaches.

/** Lage-map tool ids that change nothing. */
export const MAP_READONLY_TOOLS = ['select', 'measure'] as const
/** Plan/whiteboard equivalents ('pan' is the plan's Auswahl). */
export const PLAN_READONLY_TOOLS = ['pan', 'measure'] as const

/** Is this Lage-map tool id one a locked surface still offers? (Hotkeys + the arm-state reset
 *  ask this; the plan reaches its tools through the same map ids, see Whiteboard's pickTool.) */
export function isMapReadOnlyTool(id: string): boolean {
  return (MAP_READONLY_TOOLS as readonly string[]).includes(id)
}

interface RailEntry { id: string; sep?: boolean; slot?: boolean }

/**
 * Filter a tool-rail list down to `allowed`, keeping the rail's group rhythm honest: the
 * `slot` marker (the Symbol primary — always a create tool) is dropped, and a separator
 * survives only when it still divides two kept tools, so no rail ever opens or closes on a
 * stray divider.
 */
export function slimTools<T extends RailEntry>(tools: readonly T[], allowed: readonly string[]): T[] {
  const kept: T[] = []
  let pendingSep: T | null = null
  for (const t of tools) {
    if (t.slot) continue
    if (t.sep) { if (kept.length) pendingSep = t; continue }
    if (!allowed.includes(t.id)) continue
    if (pendingSep) { kept.push(pendingSep); pendingSep = null }
    kept.push(t)
  }
  return kept
}
