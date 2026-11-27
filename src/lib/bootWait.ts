// How long the start waits for the server when this device already holds the Einsatz (performance
// sweep 26.11.2026, finding 27 – owner's rule, 27.11.2026). The boot asks for the Einsatz list as
// always. When the Einsatz it would open is the remembered one and its stored copy is readable
// here, the boot waits BOOT_STORED_WAIT_MS for that list and then opens the stored copy at once
// (WorkspaceSync · storedFirst) – as it does when the list came in time from the device's copy. Nothing is cut off: the list and the workspace request keep
// their 20 s bound and their retries; only the boot stops waiting for them. Their answers land the
// way they do during use – the list through the always-on watch (useIncidentWatch, which then
// shows a newer alarm Einsatz with its banner), the server's workspace through the live follow
// and the push's 409 merge (WorkspaceSyncOptions · storedFirst). A refusal is never answered with the stored copy: one within
// the wait is the boot's as before, one after it is handled as during use.
//
// A first start, a new device, an Einsatz never opened here, a launch into /karte or /besuche, a
// link session and the demo wait as before.

import { listIncidentsShared, readOfflineIncidentList, type IncidentMeta } from './api/incidents'
import { storedCopy } from './api/workspaceSync'
import { bootPlan, type BootPrefs } from './karte/home'
import { appConfig } from '../config/appConfig'
import { fillTemplate, fmtWhen } from './format'
import { isDemoMode } from './deploymentConfig'

/** The owner's pick (27.11.2026, round «perf-start-wait-rule»): 5 s – longer than a healthy link
 *  ever needs, a phone waking its radio included (1–3 s), and the dead-link start goes from 40 s to 5 s. */
export const BOOT_STORED_WAIT_MS = 5_000

export type BootList =
  /** the list in time, or no stored copy to fall back to: the boot as before */
  | { kind: 'list'; list: IncidentMeta[]; offline: boolean }
  /** the list did not come in time: open `incident` from its stored copy, show the device's `list` */
  | { kind: 'stored'; incident: IncidentMeta; list: IncidentMeta[]; lastSyncedAt: number | null }

/** The remembered Einsatz as the device's own list names it, when its stored copy is readable here. */
async function storedBootCopy(path: string, prefs: BootPrefs, now: number) {
  // the demo's Einsatz is re-seeded and rebased on open (App · demoSeedRebase): it waits as before
  if (!prefs.incidentId || isDemoMode()) return null
  const list = await readOfflineIncidentList()
  const plan = bootPlan(path, list, prefs, { now })
  if (plan.kind !== 'open' || plan.incident.id !== prefs.incidentId) return null
  const copy = await storedCopy(plan.incident.id)
  return copy && { kind: 'stored' as const, incident: plan.incident, list, lastSyncedAt: copy.lastSyncedAt }
}

/** The boot's list (listIncidentsShared), or the stored copy to open when the list takes longer
 *  than `waitMs` and there is one – or when the list came in time but from the device's copy: the
 *  server was not reached then either. A refusal of the list within the wait rejects, as before. */
export async function bootList(path: string, prefs: BootPrefs, { now = Date.now(), waitMs = BOOT_STORED_WAIT_MS } = {}): Promise<BootList> {
  const listed = listIncidentsShared().then((r): BootList => ({ kind: 'list', ...r }))
  listed.catch(() => {}) // a refusal after the boot stopped waiting is the watch's (during use)
  const stored = storedBootCopy(path, prefs, now).catch(() => null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs) })
  try {
    const first = await Promise.race([listed, waited.then(() => stored)])
    if (first?.kind === 'list' && first.offline) return (await stored) ?? first
    return first ?? (await listed)
  } finally {
    clearTimeout(timer)
  }
}

/** The line the launcher and the switcher show over the device's own list: with the time of the
 *  stored copy on screen when it is known («von 14:05», «von 26.11. 23:50» on another day). */
export function offlineLine(lastSyncedAt: number | null): string {
  const C = appConfig.copy.incidentSwitcher
  return lastSyncedAt == null
    ? C.bootOffline
    : fillTemplate(C.bootOfflineAt, { time: fmtWhen(new Date(lastSyncedAt).toISOString(), { todayShort: true }) })
}
