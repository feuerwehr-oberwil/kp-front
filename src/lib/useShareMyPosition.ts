import { useCallback, useEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { isDemoMode } from './deploymentConfig'
import { haversineM } from './geo'
import { linkSessionHeaders } from './linkMode'
import { loadPrefs, savePrefs, type SharePositionPref } from './prefs'
import type { LngLat } from '../types'

const cfg = appConfig.personGps

/**
 * Standort teilen — this device reporting its holder's position to the command post.
 *
 * The shape of the feature, and why:
 *
 * - **Two separate things, deliberately.** The device preference is a standing PERMISSION
 *   («dieses Gerät darf meinen Standort verwenden», plus which name). Sharing itself is an
 *   ACT: switched on per Einsatz from the compass menu, and never carried over. A phone that
 *   starts broadcasting because of something its owner agreed to months ago is the exact
 *   failure mode this split exists to prevent — so `start()` is always somebody tapping.
 * - **Off again at the next Einsatz.** Enforced by construction: what counts as sharing is
 *   `sharingFor === incidentId`, so a different Einsatz simply is not the one that was
 *   switched on. No effect resets anything, nothing can be forgotten.
 * - **«Wer bist du?» again at the next Einsatz.** The device remembers the NAME, never the
 *   confirmation: `pref.confirmedIncidentId` is the Einsatz its holder said «das bin ich» for,
 *   and one tap is only enough while that is the Einsatz on screen. This is not paranoia — a
 *   shared Tablet reported one Einsatz's positions under the previous Einsatz's name, and a
 *   wrong name on the Lagekarte is worse than no name. The picker may put the remembered
 *   person first; the tap on it is the confirmation.
 * - **Foreground only, and honest about it.** A browser gets no fixes while the phone is
 *   locked or the tab is in the background. There is no fixing that from here (no background
 *   geolocation on the web, and a Wake Lock burning the screen in someone's pocket is a worse
 *   trade). So sharing simply pauses, the last position ages, and the command post reads the
 *   age. `paused` exists so the phone can say so too, rather than implying it is still live.
 * - **Stopping deletes.** The DELETE removes the row, so the dot disappears instead of
 *   quietly ageing at the spot where someone decided to stop being visible.
 */

export type ShareState =
  /** never asked, or declined — nothing is happening */
  | 'off'
  /** watching, but no fix has arrived yet (or the phone is in the background) */
  | 'starting'
  /** reporting */
  | 'on'
  /** watching, but the browser has stopped delivering fixes (backgrounded / locked) */
  | 'paused'
  /** the OS refused the permission — needs the browser's own settings to undo */
  | 'denied'
  /** somebody else's phone is already sharing under this name */
  | 'taken'
  /** fixes are arriving, but the server keeps refusing them (offline, backend down, an older
   *  backend that has no such route). NOT the same as 'starting', and that distinction is the
   *  whole reason this state exists: a silently-swallowed POST failure looks exactly like
   *  «still looking for a fix», so a phone that is reporting nothing at all sits there
   *  claiming to be busy. */
  | 'failing'

export interface ShareApi {
  state: ShareState
  /** the device has permission AND a name picked. This is the standing DEVICE preference
   *  (Einstellungen) — it says nothing about this Einsatz. */
  ready: boolean
  /** the holder confirmed who this device is FOR THIS Einsatz — i.e. one tap is enough to
   *  start sharing. False means the picker has to ask again, even when `ready` is true. */
  confirmed: boolean
  /** who this device reports as, from the device preference */
  pref: SharePositionPref | null
  /** time of the last accepted fix (ms epoch), null before the first */
  lastAt: number | null
  /** the last fix was dropped for being too vague to draw (see `maxAccuracyM`). Reported
   *  separately from `state` because it is a REASON for still searching, not a state of its
   *  own — indoors a phone can sit here for a while and the holder deserves to know why. */
  imprecise: boolean
  /** start sharing THIS Einsatz. With a person it grants the permission, records who this
   *  device is and confirms that name FOR THIS Einsatz. With no argument it is the one-tap
   *  case from the compass menu — and it only does anything once `confirmed` is true, so an
   *  unconfirmed tap can never start sharing under a remembered name. */
  start: (person?: { id: string; displayName: string }) => void
  /** stop sharing this Einsatz and delete the reported position. The permission survives —
   *  stopping is not revoking, and making people re-consent to switch off would be perverse. */
  stop: () => void
  /** withdraw the device's permission entirely (Einstellungen). Stops first. */
  revoke: () => void
}

/** A browser with no Geolocation API at all. A fixed capability, not a state the watch moves
 *  through, so it is read at render rather than written into state from inside an effect. */
const hasGeolocation = (): boolean => typeof navigator !== 'undefined' && 'geolocation' in navigator

/** A device id, minted once and kept. Random, opaque, and NOT derived from anything about
 *  the device — its only job is to tell two phones apart. */
function ensureDeviceId(pref: SharePositionPref | undefined): string {
  if (pref?.deviceId && pref.deviceId.length >= 8) return pref.deviceId
  const rand = Math.random().toString(36).slice(2, 10)
  return `dev-${Date.now().toString(36)}${rand}`
}

/**
 * `enabled` is the caller's gate — an open incident the caller may report into. The demo is
 * refused here as well as server-side, so neither half depends on the other.
 */
export function useShareMyPosition(incidentId: string | null, enabled: boolean): ShareApi {
  const [pref, setPref] = useState<SharePositionPref | null>(() => loadPrefs().sharePosition ?? null)
  // WHICH Einsatz sharing was switched on for — not a boolean. Sharing is per Einsatz, and
  // holding the incident id makes that true by construction: open a different one and
  // `sharing` is false without anything having to reset it. Session-only, never persisted.
  const [sharingFor, setSharingFor] = useState<string | null>(null)
  // Only the phases the watch itself goes through. "Off" is not one of them — it is DERIVED
  // from `active` below, so switching the feature off never has to be written into state from
  // inside an effect (the cascading-render pattern).
  const [watch, setWatch] = useState<Exclude<ShareState, 'off'>>('starting')
  const [lastAt, setLastAt] = useState<number | null>(null)
  const [imprecise, setImprecise] = useState(false)
  // Refs, not state: these change on every fix and nothing renders off them, so putting them
  // in state would re-render the whole workspace on a 20 s heartbeat.
  const lastSentAt = useRef<number>(0)
  const lastSentCoord = useRef<LngLat | null>(null)
  const watchId = useRef<number | null>(null)
  const idleTimer = useRef<number | null>(null)

  const ready = !!pref?.allowed && !!pref.personId
  // Who this device is, for THIS Einsatz. The name survives the Einsatz, the confirmation does
  // not — see the «Wer bist du?» note above.
  const confirmed = ready && !!incidentId && pref?.confirmedIncidentId === incidentId
  const sharing = !!incidentId && sharingFor === incidentId
  // On the public demo sharing is SIMULATED: the control behaves exactly as it does for a real
  // Wehr, but no fix is ever taken and nothing is posted — the dot is walked in the browser
  // (lib/demoCrewWalk), and the backend goes on refusing every position route. A demo visitor
  // gets to see what the feature does without their own location being involved at all.
  const demo = isDemoMode()
  const active = enabled && sharing && confirmed && !demo

  const persist = useCallback((next: SharePositionPref | null) => {
    const prefs = loadPrefs()
    if (next) prefs.sharePosition = next
    else delete prefs.sharePosition
    savePrefs(prefs)
    setPref(next)
  }, [])

  const start = useCallback((person?: { id: string; displayName: string }) => {
    const current = loadPrefs().sharePosition
    // The one-tap path is only a tap once somebody has confirmed the name for THIS Einsatz.
    // Refused here rather than left to the caller: a remembered name is exactly what must not
    // start sharing by itself on a Tablet that gets handed around.
    if (!person && (!incidentId || current?.confirmedIncidentId !== incidentId)) return
    // Back to square one, always. Without this a device that had reached 'on' (or died on
    // 'taken') would show that same verdict the instant it restarts, before a single fix has
    // arrived — a green «Standort geteilt» for a phone that is reporting nothing yet.
    setWatch('starting')
    setLastAt(null)
    setImprecise(false)
    lastSentAt.current = 0
    lastSentCoord.current = null
    persist({
      allowed: true,
      personId: person?.id ?? current?.personId,
      displayName: person?.displayName ?? current?.displayName,
      deviceId: ensureDeviceId(current),
      // Picking a name IS the confirmation, and it is scoped to the Einsatz on screen.
      confirmedIncidentId: incidentId ?? undefined,
    })
    setSharingFor(incidentId)
  }, [incidentId, persist])

  /** Delete the row this device put on the map. Best-effort and fire-and-forget: the sweep and
   *  the Einsatz-Abschluss are the guarantees, this is the one that makes the dot go NOW. */
  const clearRow = useCallback(() => {
    const current = loadPrefs().sharePosition
    // nothing was ever reported on the demo, so there is nothing to delete
    if (isDemoMode()) return
    if (!incidentId || !current?.personId || !current.deviceId) return
    const url = `/api/incidents/${incidentId}/positions/${current.personId}?device=${encodeURIComponent(current.deviceId)}`
    // Bare `fetch` because this one is fire-and-forget — no ApiError, no refresh-and-retry, no
    // toast. It still has to say which session it is asking with (api · rawFetch).
    void fetch(url, { method: 'DELETE', headers: linkSessionHeaders() }).catch(() => {})
  }, [incidentId])

  const stop = useCallback(() => {
    clearRow()
    setSharingFor(null)
    setLastAt(null)
    lastSentAt.current = 0
    lastSentCoord.current = null
  }, [clearRow])

  const revoke = useCallback(() => {
    clearRow()
    setSharingFor(null)
    setLastAt(null)
    lastSentAt.current = 0
    lastSentCoord.current = null
    // Keep the deviceId: it identifies the phone, not the consent, and re-minting it on every
    // revoke would let one phone hold two claims on the same name. The confirmation goes:
    // withdrawing the permission and then granting it again must ask who this device is.
    persist({
      ...loadPrefs().sharePosition,
      allowed: false,
      deviceId: ensureDeviceId(loadPrefs().sharePosition),
      confirmedIncidentId: undefined,
    })
  }, [clearRow, persist])

  useEffect(() => {
    if (!active || !hasGeolocation()) return
    let alive = true

    const send = async (coord: LngLat, accuracyM: number | null, at: number) => {
      const body = {
        person_id: pref!.personId,
        display_name: pref!.displayName ?? '',
        device_id: pref!.deviceId,
        lat: coord[1],
        lng: coord[0],
        accuracy_m: accuracyM,
        ts: new Date(at).toISOString(),
      }
      // Bare `fetch` because a 409 is an ANSWER here, not an error to be thrown (see below) —
      // so the session-mode header rides by hand, as it must on every /api call (api · rawFetch).
      const res = await fetch(`/api/incidents/${incidentId}/positions`, {
        method: 'POST',
        headers: { ...linkSessionHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!alive) return
      if (res.status === 409) {
        // Another phone holds this name. Stop rather than fight over it — but keep the
        // consent, so the holder can pick a different name (or take it back later) without
        // going through the whole opt-in again.
        setWatch('taken')
        if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current)
        watchId.current = null
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      lastSentAt.current = at
      lastSentCoord.current = coord
      setLastAt(at)
      setWatch('on')
    }

    const onFix: PositionCallback = (p) => {
      if (!alive) return
      const accuracy = p.coords.accuracy ?? null
      // A fix this vague drawn as a dot is a lie — indoors and underground that is exactly
      // what a phone reports. Better to keep showing the last good one and let it age. Say so
      // rather than swallowing it: a phone dropping every fix is otherwise indistinguishable
      // from one that has not got a fix yet.
      if (accuracy != null && accuracy > cfg.maxAccuracyM) { setImprecise(true); return }
      setImprecise(false)
      const coord: LngLat = [p.coords.longitude, p.coords.latitude]
      const now = Date.now()
      const moved = lastSentCoord.current ? haversineM(lastSentCoord.current, coord) : Infinity
      // Report on the heartbeat, or at once when the phone has actually moved — someone
      // driving to the Weiher must not crawl across the map in 20 s steps.
      if (now - lastSentAt.current < cfg.sendMs && moved < cfg.minMoveM) return
      void send(coord, accuracy, now).catch(() => {
        // Once reporting HAS worked, a dropped request is noise — the command post reads the
        // age going up, and the next fix retries by itself. But a phone that has never got a
        // report through is not "searching", it is failing, and saying so is the difference
        // between «warte kurz» and «da stimmt was nicht».
        if (lastSentAt.current === 0) setWatch('failing')
      })
    }

    const onError: PositionErrorCallback = (err) => {
      if (!alive) return
      setWatch(err.code === err.PERMISSION_DENIED ? 'denied' : 'paused')
    }

    watchId.current = navigator.geolocation.watchPosition(onFix, onError, {
      enableHighAccuracy: true,
      maximumAge: 10_000,
      timeout: 30_000,
    })

    // Nothing arriving for well over a heartbeat means the browser has stopped feeding us —
    // the pocketed phone. Say "pausiert" rather than leaving a green light on a page that is
    // reporting nothing.
    idleTimer.current = window.setInterval(() => {
      if (!alive) return
      setWatch((s) => {
        if (s !== 'on') return s
        return Date.now() - lastSentAt.current > cfg.sendMs * 3 ? 'paused' : s
      })
    }, cfg.sendMs)

    return () => {
      alive = false
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current)
      watchId.current = null
      if (idleTimer.current != null) window.clearInterval(idleTimer.current)
      idleTimer.current = null
    }
  }, [active, incidentId, pref])

  // The simulated share reports «on» from the moment it is switched on: there is no fix to wait
  // for, and a permanent «suche Standort …» on a demo would read as a broken feature.
  const state: ShareState = demo
    ? (enabled && sharing && confirmed ? 'on' : 'off')
    : !active ? 'off' : !hasGeolocation() ? 'denied' : watch
  return { state, ready, confirmed, pref, lastAt, imprecise, start, stop, revoke }
}
