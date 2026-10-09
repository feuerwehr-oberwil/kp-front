// Types the split-out pieces of IncidentWorkspace share (E1, 09.10.2026).

import type { TimelineEvent } from '../types'

/** The surface on screen — one per rail tile (NavRail). Remembered per Einsatz (lib/prefs · initialMode). */
export type WorkspaceMode = 'map' | 'plans' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel' | 'rapport'

/** What placing a Verlauf row's pictures on the Karte reads off the row (lib/photoGeo). */
export type PhotoRow = Pick<TimelineEvent, 'id' | 'photoGeo' | 'photoUrl' | 'photoUrls'>

/** A one-shot's own counter-rows for ↶ and ↷ (IncidentWorkspace · rememberOneShot) */
export interface OneShotRows { undo: () => void; redo: () => void }
