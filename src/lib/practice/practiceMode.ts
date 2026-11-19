// «Üben»: the private practice Einsatz that lives only on this device (owner pick, 19.11.2026:
// «only its own device» – nothing reaches the server, every role works in it, offline too).
//
// One practice incident per device: a stable UUID in localStorage (`kp.practice.id`), minted on
// first use. While it exists, lib/practice/installFetch routes every request that names it to
// lib/practice/localServer instead of the network — the incident is never created on the server,
// is in no Einsätze list and has nothing to delete there.
//
// «Neu beginnen» (`resetPractice`) RETIRES the id instead of emptying it: a fresh id is minted,
// the old one joins `kp.practice.retired` (still intercepted, answered 410, never stored — a
// teardown beacon of the page being left cannot recreate it) and every IndexedDB/localStorage key
// that names it is deleted on the next boot (`purgeRetired`), when no store of it is alive any more.
//
// The mode flag (`kp.practice.on`) says whether App boots INTO the practice Einsatz: a drill
// started from the «Üben» sheet sets it, «Übung verlassen» (`leavePractice`) clears it. `?ueben=1`
// / `?ueben=0` sets it from the address (readPracticeParam, called once from main.tsx) – the e2e
// and proof scripts' entry.

import { idbDel, idbKeys } from '../idb'
import { deploymentDefaultCenter } from '../deploymentConfig'
import type { IncidentFull } from '../api/incidents'
import { appConfig } from '../../config/appConfig'
import { loadPrefs, savePrefs } from '../prefs'

const ID_KEY = 'kp.practice.id'
const ON_KEY = 'kp.practice.on'
const RETIRED_KEY = 'kp.practice.retired'
/** how many retired ids stay intercepted — a late beacon comes within seconds of the reload */
const RETIRED_KEEP = 5

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* private mode: practice is simply not remembered */ }
}

/** This device's practice incident id, minted on first ask. */
export function practiceId(): string {
  const known = lsGet(ID_KEY)
  if (known) return known
  // a server-shaped incident id (the routes are typed uuid), not a `newId` record id
  const id = crypto.randomUUID()
  lsSet(ID_KEY, id)
  return id
}

/** The id, without minting one — for the request filter, which must not create state. */
export function knownPracticeId(): string | null {
  return lsGet(ID_KEY)
}

export function retiredPracticeIds(): string[] {
  try {
    const v: unknown = JSON.parse(lsGet(RETIRED_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

export function isPracticeIncident(id: string | null | undefined): boolean {
  return !!id && id === knownPracticeId()
}

export function practiceModeOn(): boolean {
  return lsGet(ON_KEY) === '1'
}

export function setPracticeMode(on: boolean): void {
  lsSet(ON_KEY, on ? '1' : null)
}

/** `?ueben=1` / `?ueben=0` — the scripted entry. Strips the parameter so a reload is plain. */
export function readPracticeParam(): void {
  const url = new URL(window.location.href)
  const v = url.searchParams.get('ueben')
  if (v === null) return
  setPracticeMode(v === '1')
  url.searchParams.delete('ueben')
  window.history.replaceState(window.history.state, '', url.toString())
}

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

/** «Neu beginnen»: retire the current id and mint a fresh one. The caller reloads the page; the
 *  next boot purges the retired id's keys (purgeRetired). */
export function resetPractice(): string {
  const old = lsGet(ID_KEY)
  if (old) lsSet(RETIRED_KEY, JSON.stringify([old, ...retiredPracticeIds().filter((x) => x !== old)].slice(0, RETIRED_KEEP)))
  lsSet(ID_KEY, null)
  return practiceId()
}

/** Delete every stored key that names a retired practice id: the local server's own slots and
 *  the client's per-incident caches (workspace, Verlauf and audit outboxes, building card, …). */
export async function purgeRetired(): Promise<void> {
  const retired = retiredPracticeIds()
  if (!retired.length) return
  const keys = await idbKeys('')
  if (keys.ok) {
    await Promise.all((keys.value ?? []).filter((k) => retired.some((id) => k.includes(id))).map((k) => idbDel(k)))
  }
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && retired.some((id) => k.includes(id))) doomed.push(k)
    }
    for (const k of doomed) localStorage.removeItem(k)
  } catch { /* nothing to purge without localStorage */ }
}

/** «Übung verlassen»: practice mode off, the practice Einsatz forgotten as the one to reopen, and
 *  a fresh boot onto home – the sync engines of the practice Einsatz end with the page. The
 *  practice Einsatz itself stays on the device for the next drill. */
export function leavePractice(): void {
  setPracticeMode(false)
  savePrefs({ ...loadPrefs(), incidentId: undefined })
  window.location.assign('/')
}
