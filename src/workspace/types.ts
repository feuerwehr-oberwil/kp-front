// Types the split-out pieces of IncidentWorkspace share (E1, 09.10.2026).

/** The surface on screen — one per rail tile (NavRail). Remembered per Einsatz (lib/prefs · initialMode). */
export type WorkspaceMode = 'map' | 'plans' | 'checklists' | 'atemschutz' | 'anwesenheit' | 'mittel' | 'rapport'
