// The workspace's two lazy surfaces (split out of IncidentWorkspace, E1 09.10.2026).

import { lazy } from 'react'

/* Two single-mode surfaces are their OWN chunks (perf sweep 23.09.2026): the Plan (Whiteboard,
 * ~140 KB minified) and the Rapport (ReportPreflight + the Kroki framing panel, ~65 KB) sat in
 * the field app's chunk, parsed on every boot — on the Karte, the Atemschutz-Tafel and a link
 * phone alike. (GeorefMode cannot follow them: GeorefMapLayer, which the Karte mounts, needs it.) They are fetched on IDLE right after the workspace mounts (see the prefetch
 * effect), so by the time anyone switches mode the chunk is already here and the switch is as
 * instant as it was; offline they come out of the precache like every other chunk.
 * ⚠️ Nothing alarm-critical is lazy: the Atemschutz-Tafel, the alarm banner and the sync status
 * stay in the eager chunk — a surface that may be needed at 3am must never show a gap first. */
export const loadWhiteboard = () => import('../components/Whiteboard')
export const Whiteboard = lazy(() => loadWhiteboard().then((m) => ({ default: m.Whiteboard })))
export const loadReportPreflight = () => import('../components/ReportPreflight')
export const ReportPreflight = lazy(() => loadReportPreflight().then((m) => ({ default: m.ReportPreflight })))
/** «Open the Rapport ON this Mindestangabe» (ReportPreflight · requestReportStep), through the
 *  lazy module: the ask queues there until the sheet mounts, exactly as it did when static. */
export const requestReportStep = (step: Parameters<typeof import('../components/ReportPreflight').requestReportStep>[0]) => {
  void loadReportPreflight().then((m) => m.requestReportStep(step))
}
