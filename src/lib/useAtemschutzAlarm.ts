import { useEffect, useMemo, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { alarmBarFor, anyTruppInField, type AtemschutzAlarmState, contactSeverity, deriveTruppLive, peakAtemschutzAlarm, pressureAlarm } from './atemschutz'
import { Alarm, chime, notify } from './alarm'
import { atemschutzDoctrine, isDemoMode } from './deploymentConfig'
import type { Trupp } from '../types'

const SILENT: AtemschutzAlarmState = { peak: 0, urgent: null, severities: {} }

/** Content equality for the per-Trupp tier map (only non-zero tiers are in it, so it is tiny). */
function sameSeverities(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

const cfg = appConfig.atemschutz
// while a Trupp stays überfällig, re-post the OS notification on this cadence so a
// backgrounded / look-away operator keeps getting pinged (the in-page tone alone is
// inaudible once the OS has suspended Web Audio).
const ALARM_RENOTIFY_MS = 30_000

/**
 * Atemschutz contact-clock monitoring, lifted OUT of the AtemschutzView so it runs for the
 * WHOLE session — not just while that surface is on screen. (Previously the alarm/notification
 * only fired once you opened the Atemschutzüberwachung page, because the driving effect lived in
 * the unmounted view.) Mirrors the always-on Wiedervorlagen reminders: mounted once in App.
 *
 * Drives the escalating tone (Alarm), records the überfällig crossing once, and posts an OS
 * notification (the reliable attention channel when the in-page tone is suspended) on the
 * crossing and on a cadence while still overdue. `active` is false during replay (read-only past).
 */
export function useAtemschutzAlarm({
  trupps, muted, active, logAlarm,
  intervalMin = cfg.contactIntervalMin, graceSec = cfg.contactGraceSec,
}: {
  trupps: Trupp[]
  muted: boolean
  active: boolean
  logAlarm: (id: string, status: Trupp['status']) => void
  /** per-incident Funkkontakt-Intervall (min) + Nachfrist (sec); default = appConfig doctrine */
  intervalMin?: number
  graceSec?: number
}): AtemschutzAlarmState {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const az = appConfig.copy.atemschutz
  // the station's Alarmdruck — read here so the tone, the chip and the card all use one number
  const alarmBar = atemschutzDoctrine().alarmBar
  // …and the lower line a Trupp in Rückzug is held to (lib/atemschutz · alarmBarFor)
  const alarmBarRueckzug = atemschutzDoctrine().alarmBarRueckzug
  const [now, setNow] = useState(() => Date.now())
  const alarm = useRef<Alarm | null>(null)
  /** last tier seen per Trupp. Its KEYS matter as much as its values: a Trupp that is not in it
   *  yet has never been evaluated by this session, so whatever tier it is on is a state we found,
   *  not a crossing we watched (see `justCrossed`). */
  const prevSeverity = useRef<Map<string, number>>(new Map())
  const lastNotify = useRef<Map<string, number>>(new Map())
  /** the contact stamp a Trupp's «Überfällig» line was written FOR. One line per TURNUS: the
   *  next one is owed only once a new Funkkontakt has reset the clock, so a tier that dips and
   *  recovers within the same turnus (a merge from another device, a re-evaluation after the
   *  tab woke up) cannot write the same alarm twice. `prevSeverity` alone could not promise
   *  that — it is session memory about a crossing, this is a fact about the record. */
  const alarmedFor = useRef<Map<string, string>>(new Map())

  // per-second tick — only while monitoring is active AND at least one Trupp is actually in the
  // field. With no Trupp inside there is no contact clock to advance, so we skip the tick entirely
  // rather than re-rendering the whole workspace once a second for nothing (the common idle case:
  // no SCBA deployed yet, or all Trupps already raus). A Trupp entering/leaving flips `monitoring`
  // and re-arms/clears the interval; the visibility handler below still forces a fresh eval on focus.
  const monitoring = active && anyTruppInField(trupps)
  useEffect(() => {
    if (!monitoring) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [monitoring])

  // Background timers are throttled/frozen (screen off, app backgrounded), so a Trupp can cross
  // into überfällig while the tick is asleep. Force an immediate re-evaluation the moment the
  // page becomes visible/focused again so the alarm + notification fire at once.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') setNow(Date.now()) }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onVis)
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis) }
  }, [])

  // On the public demo the incident is frozen in a worked state, so its field Trupps drift
  // overdue as real time passes since the last reset — which would otherwise blare the tone and
  // re-post OS notifications at visitors forever. Keep the visual überfällig state, but silence
  // the audible alarm + notifications. Real stations (demoMode off) are unaffected.
  const demo = isDemoMode()
  useEffect(() => {
    if (!active) { alarm.current?.stop(); return }
    let peak = 0
    for (const t of trupps) {
      const l = deriveTruppLive(t, now, intervalMin, graceSec)
      if ((l.status ?? t.status) === 'raus') { prevSeverity.current.set(t.id, 0); lastNotify.current.delete(t.id); continue }
      // ⚠️ Two emergencies, one tier. A Trupp at or below the Alarmdruck has to turn round NOW,
      // exactly like one out of contact — and until 10.08. that fact lived on its card and
      // nowhere else, so it reached nobody who was not already looking at the Atemschutz board.
      // It is tier 2 outright: the Alarmdruck IS the deadline, it has no amber lead-up.
      const lowPressure = pressureAlarm(l.currentBar ?? null, alarmBarFor(t, { alarmBar, alarmBarRueckzug }))
      const sev = lowPressure ? 2 : contactSeverity(l.sinceContactSec, intervalMin, graceSec)
      // ⚠️ A CROSSING THIS APP ACTUALLY SAW — hence «have we met this Trupp before», not «is the
      // tier below 2». `prevSeverity` starts empty on every mount, so a Trupp that was ALREADY
      // überfällig read as 0 → 2 on the first evaluation and wrote another «Überfällig» line: on
      // every reload, every resume from a killed PWA, every HMR update. The Verlauf filled with
      // the same alarm while nothing had happened, which is how an Überwacher learns to stop
      // reading it. The line for that crossing is already in the append-only record, written by
      // the session that watched it happen.
      // ⚠️ Per TRUPP, not one global «first pass» flag: the roster arrives asynchronously with the
      // workspace, so the first pass often runs over an EMPTY list — and every Trupp would then
      // land afterwards as a fresh 0 → 2 crossing, which is the same bug wearing a hat.
      const seen = prevSeverity.current.has(t.id)
      const was = prevSeverity.current.get(t.id) ?? 0
      // …and a contact still resets the tier to 0, so going overdue again DOES log again — that
      // is the case actually worth a second line.
      const justCrossed = seen && sev >= 2 && was < 2
      // the Verlauf already carries the pressure crossing from recordPressure (logPressureAlarm),
      // so only the contact crossing is recorded here — otherwise one reading writes two lines
      const turnus = t.lastContactTime ?? t.entryTime ?? ''
      if (justCrossed && !lowPressure && alarmedFor.current.get(t.id) !== turnus) {
        alarmedFor.current.set(t.id, turnus)
        logAlarm(t.id, 'ueberfaellig') // crossed into overdue → record once PER TURNUS
      }
      // opt-in early nudge: a soft one-shot pip the moment a Trupp crosses into the amber
      // «Kontakt fällig» lead (sev 0→1). Off by default; muted/demo suppress it like the alarm.
      if (cfg.contactDueChime && !muted && !demo && sev >= 1 && was < 1) chime()
      if (sev >= 2) {
        // OS notification carries the OS's own sound + vibration, so it still alerts when the
        // in-page Web Audio tone has been suspended (screen off / app backgrounded). Fire on the
        // crossing, then re-fire on a cadence while still overdue (tag+renotify coalesce the tray
        // entry). NOTE: a fully KILLED app still can't fire this — that needs server Web Push.
        const lastN = lastNotify.current.get(t.id) ?? 0
        if (!demo && (justCrossed || now - lastN >= ALARM_RENOTIFY_MS)) {
          lastNotify.current.set(t.id, now)
          void notify(az.alarmNotifyTitle, { body: az.alarmNotifyBody.replace('{name}', t.name), tag: `atemschutz-${t.id}`, target: 'atemschutz' })
        }
      } else {
        lastNotify.current.delete(t.id)
      }
      prevSeverity.current.set(t.id, sev)
      if (sev > peak) peak = sev
    }
    if (!alarm.current) alarm.current = new Alarm()
    alarm.current.setMuted(muted || demo)
    // Only ÜBERFÄLLIG (tier 2) makes a sound — the amber "Kontakt fällig" lead stays silent (and
    // board-only), so the tone/wake-lock don't nag before a Trupp is actually overdue.
    alarm.current.set(peak >= 2 ? 2 : 0)
  }, [trupps, now, muted, active, logAlarm, intervalMin, graceSec, az, demo, alarmBar, alarmBarRueckzug])

  useEffect(() => () => alarm.current?.stop(), [])

  // The same per-second `now` drives a pure fold of the fleet into {peak, urgent} — the single
  // source for the cross-surface surfaces (NavRail dot + TopBar chip), so they never disagree with
  // the tone. Silent during replay (read-only past).
  return useMemo(
    () => (active ? peakAtemschutzAlarm(trupps, now, intervalMin, graceSec, alarmBar, alarmBarRueckzug) : SILENT),
    [active, trupps, now, intervalMin, graceSec, alarmBar, alarmBarRueckzug],
  )
}

/**
 * Null-rendering host for the alarm engine. The hook's 1 Hz tick is component state, so whoever
 * calls the hook re-renders every second a Trupp is in the field — mounted directly in App that
 * was the WHOLE tree (map included), a measured battery drain on phones. Hosted here, the tick
 * re-renders only this empty component, and `onState` (a setState in App) fires only when the
 * alarm actually TRANSITIONS (tier / Trupp / name) — the fold's object churns every tick because
 * sinceContactSec advances, but the chip ticks its own clock off `contactAt`, so ticks without a
 * transition never reach App.
 */
export function AtemschutzAlarmHost({ onState, ...opts }: Parameters<typeof useAtemschutzAlarm>[0] & {
  onState: (s: AtemschutzAlarmState) => void
}): null {
  const state = useAtemschutzAlarm(opts)
  const last = useRef<AtemschutzAlarmState>(SILENT)
  useEffect(() => {
    const prev = last.current
    if (state.peak !== prev.peak || state.urgent?.id !== prev.urgent?.id
      || state.urgent?.severity !== prev.urgent?.severity || state.urgent?.name !== prev.urgent?.name
      // per-Trupp tiers drive the hose-line tone on the map/plan. Compared BY CONTENT: the fold
      // builds a fresh object every tick, so a reference check would push a state update (and a
      // full re-render, map included) once a second — exactly what this host exists to prevent.
      || !sameSeverities(state.severities, prev.severities)) {
      last.current = state
      onState(state)
    }
  }, [state, onState])
  return null
}
