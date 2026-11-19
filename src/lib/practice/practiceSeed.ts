// «Üben»: the practice Einsatz's seed and the way out of it – the parts of lib/practice that need
// the copy, the station config and the device prefs, kept out of practiceMode so that the entry
// chunk (main.tsx · the seam) stays lean. Used by App (open) and the drill card (leave).

import { appConfig } from '../../config/appConfig'
import type { IncidentFull } from '../api/incidents'
import { deploymentDefaultCenter } from '../deploymentConfig'
import { loadPrefs, savePrefs } from '../prefs'
import { siteScene } from '../ueben/site'
import { ensurePracticeIncident } from './localServer'
import { practiceId, setPracticeMode } from './practiceMode'

/** The seed meta of a fresh practice Einsatz: an Übung, «Übungsplatz», at the station centre
 *  (the site of lib/ueben/site is laid out around it). */
export function practiceSeedMeta(id: string, now = new Date()): IncidentFull {
  const center = deploymentDefaultCenter()
  const iso = now.toISOString()
  return {
    id,
    divera_id: null,
    title: appConfig.copy.ueben.idleTitle,
    type: null,
    priority: null,
    address: null,
    lat: center ? center[1] : null,
    lng: center ? center[0] : null,
    status: 'offen',
    source: 'practice',
    source_ref: null,
    auto_opened: false,
    started_at: iso,
    closed_at: null,
    last_closed_at: null,
    is_archived: false,
    is_exercise: true,
    exercise_since_creation: true,
    report_done_at: null,
    editor_opened_at: null,
    capture_writes: 0,
    capture_last_at: null,
    workspace_rev: 0,
    created_by: null,
    created_at: iso,
    updated_at: iso,
    atemschutz_due: [],
    alarm_update: null,
    text: null,
    details_json: null,
    map_workspace_json: null,
  }
}

/** «Übung verlassen»: practice mode off, the practice Einsatz forgotten as the one to reopen, and
 *  a fresh boot onto home – the sync engines of the practice Einsatz end with the page. The
 *  practice Einsatz itself stays on the device for the next drill. */
export function leavePractice(): void {
  setPracticeMode(false)
  savePrefs({ ...loadPrefs(), incidentId: undefined })
  window.location.assign('/')
}

/** This device's practice Einsatz, created with the practice site on first use (lib/ueben/site). */
export function openPracticeIncident(): Promise<IncidentFull> {
  const seed = practiceSeedMeta(practiceId())
  return ensurePracticeIncident(seed, seed.lng != null && seed.lat != null ? siteScene([seed.lng, seed.lat]) : undefined)
}
