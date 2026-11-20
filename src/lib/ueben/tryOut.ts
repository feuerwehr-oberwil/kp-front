// «Üben» without a drill: «Ausprobieren» under a Hilfe section's title opens the Übungsplatz
// (lib/practice – this device's private practice Einsatz) on that section's surface, with no task
// and no checks (owner pick, 20.11.2026: a few core drills, every other function tried freely).

import type { WorkspaceMode } from '../../workspace/types'

/** Where «Ausprobieren» lands on the practice Einsatz: a rail surface, or the Verlauf. */
export type TryTarget = WorkspaceMode | 'verlauf'

/** The Hilfe sections (`copy.help.sections[].id`) whose surface works on the Übungsplatz, and
 *  where each one lands. A section that is not listed has no button: its surface needs the server
 *  (Plan and Gebäude, QR capture, links) or is no Einsatz surface at all. */
export const HELP_TRY: Readonly<Partial<Record<string, TryTarget>>> = {
  lage: 'map', zeichnen: 'map', wassertransport: 'map',
  atemschutz: 'atemschutz', anwesenheit: 'anwesenheit', mittel: 'mittel',
  checkliste: 'checklists', verlauf: 'verlauf', rapport: 'rapport',
}
