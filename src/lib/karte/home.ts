// «Karte & Objekte» as HOME (owner, 16.10.2026 · variant B, docs/karte-objekte.md · «Home»):
// where an account session lands when no Einsatz is open, and the boot decision in front of it.
//
// ⚠️ The resume rules are NOT this file's. Which Einsatz a start reopens stays exactly
// `pickBootIncident` + `shouldReopenClosed` (lib/incidentAlerts: a fresh alarm-created Einsatz
// under 3 h, the remembered one, the first open one, the landed-after-an-Abschluss stay, the
// recently closed return, the crash-loop skip). This file only names their outcome — and the one
// thing that changed is what «nothing to open» shows: the viewer instead of the launcher card, for
// an account. A link session keeps the card (its Einsatz could not be fetched; it has no station
// to look at), and a visitor who is not signed in never gets here (the login screen).

import type { IncidentMeta } from '../incidents'
import type { CrashRecord } from '../crashLoop'
import { pickBootIncident } from '../incidentAlerts'
import { isOvPath } from '../../objectVisits/route'
import { isKartePath } from './route'

export type BootPlan =
  /** launched INTO a surface (/besuche…, /karte…): nothing opens behind it */
  | { kind: 'surface' }
  | { kind: 'open'; incident: IncidentMeta }
  /** the remembered Einsatz is not among the open ones — fetch it and ask `shouldReopenClosed` */
  | { kind: 'closed'; id: string }
  /** nothing to resume: home (Karte & Objekte for an account) */
  | { kind: 'home' }

export interface BootPrefs { incidentId?: string; incidentChosenAt?: number; landedAt?: number }

/** What a list boot does, in the order App's boot always did it. Pure: `crash` is injectable for
 *  tests and defaults to the device's own record (inside `pickBootIncident`). */
export function bootPlan(
  pathname: string,
  list: IncidentMeta[],
  prefs: BootPrefs,
  opts: { now: number; crash?: CrashRecord | null },
): BootPlan {
  if (isOvPath(pathname) || isKartePath(pathname)) return { kind: 'surface' }
  const pick = pickBootIncident(list, prefs.incidentId, {
    now: opts.now, chosenAt: prefs.incidentChosenAt, landedAt: prefs.landedAt,
    ...(opts.crash !== undefined ? { crash: opts.crash } : {}),
  })
  if (pick) return { kind: 'open', incident: pick }
  const savedId = prefs.incidentId
  if (savedId && !list.some((i) => i.id === savedId)) return { kind: 'closed', id: savedId }
  return { kind: 'home' }
}

export type AppScreen = 'visits' | 'karte' | 'splash' | 'opening' | 'einsatz' | 'launcher'

export interface ScreenState {
  linkSession: boolean
  /** objectVisits/route · showsObjectVisits */
  visitsShown: boolean
  /** the address is /karte… */
  karteRoute: boolean
  /** …and the viewer was entered on purpose there (a deep link at start, the Einsatz menu's row) */
  karteEntered: boolean
  /** an Einsatz id is active (it may still be mounting) */
  activeId: boolean
  /** the open Einsatz's meta is in (App shows the splash for the moment its sync engine is not) */
  workspaceReady: boolean
  /** the incident list has arrived */
  listLoaded: boolean
  bootDecided: boolean
  bootOpening: boolean
}

/** Which screen App renders. The order is the precedence. */
export function appScreen(s: ScreenState): AppScreen {
  if (s.visitsShown) return 'visits'
  // a deliberate /karte shows at once — it does not wait for the Einsatz list (the catalogue is
  // its own read) — and over an open Einsatz only when it was entered on purpose
  if (!s.linkSession && s.karteRoute && (s.karteEntered || !s.activeId)) return 'karte'
  // the boot has not decided yet: the splash, never a flash of home before the Einsatz opens
  if (!s.listLoaded || (!s.bootDecided && !s.activeId)) return 'splash'
  if (s.bootOpening && !s.activeId) return 'opening'
  if (s.activeId && s.workspaceReady) return 'einsatz'
  return s.linkSession ? 'launcher' : 'karte'
}
