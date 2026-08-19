/**
 * Which surface a demo visitor opened — the one client-side half of the visit statistics.
 *
 * ⚠️ DEMO ONLY, and the guard is the whole point. `isDemoMode()` is false on every real
 * station, so a Wehr's own app never sends this and the code below is dead weight in their
 * bundle rather than a counter running behind their back. The backend has its own,
 * independent gate (`VISIT_STATS`, off by default — see backend/app/visits.py), so a beacon
 * that somehow escaped this one would still count nothing anywhere.
 *
 * WHY THIS EXISTS AT ALL. Lage, Plan, Atemschutz, Anwesenheit, Mittel and Rapport live in
 * the workspace blob: they all save through the same one endpoint, so from the server they
 * are indistinguishable. «Which parts of the demo do people actually use» is not a question
 * request logs can answer, and this is the smallest thing that answers it — a surface name
 * from a closed list, nothing about what is on that surface and nothing about who is looking.
 *
 * Fire-and-forget via `sendBeacon`: no cookies, no response read, nothing awaited, and a
 * `text/plain` body so it stays a CORS simple request. If it fails, it fails silently — a
 * statistic must never be visible to the operator.
 */
import { isDemoMode } from './deploymentConfig'

/** The rail surfaces, as `IncidentWorkspace`'s `mode` names them. Mirrors FEATURE_KEYS in
 *  backend/app/visits.py — a key the backend does not know is dropped there, silently. */
const SURFACE_KEYS = {
  map: 'lage',
  plans: 'plan',
  checklists: 'checklisten',
  atemschutz: 'atemschutz',
  anwesenheit: 'anwesenheit',
  mittel: 'mittel',
  rapport: 'rapport',
} as const

export type BeaconSurface = keyof typeof SURFACE_KEYS

/**
 * Count one surface visit. Silent no-op off the demo, in a link session, or without
 * `sendBeacon` (old Safari) — none of those is worth a fallback path.
 */
export function countSurface(mode: BeaconSurface, opts?: { linkScoped?: boolean }): void {
  if (!isDemoMode() || opts?.linkScoped || typeof navigator?.sendBeacon !== 'function') return
  try {
    navigator.sendBeacon(
      '/api/hit',
      new Blob([JSON.stringify({ kind: 'feature', key: SURFACE_KEYS[mode] })], { type: 'text/plain' }),
    )
  } catch {
    // A counter is never allowed to surface as a problem.
  }
}
