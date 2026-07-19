import { useEffect, useMemo, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { anyTruppInField, type AtemschutzAlarmState, contactSeverity, deriveTruppLive, peakAtemschutzAlarm } from './atemschutz'
import { Alarm, notify } from './alarm'
import type { Trupp } from '../types'

const SILENT: AtemschutzAlarmState = { peak: 0, urgent: null }

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
  const [now, setNow] = useState(() => Date.now())
  const alarm = useRef<Alarm | null>(null)
  const prevSeverity = useRef<Map<string, number>>(new Map())
  const lastNotify = useRef<Map<string, number>>(new Map())

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

  useEffect(() => {
    if (!active) { alarm.current?.stop(); return }
    let peak = 0
    for (const t of trupps) {
      const l = deriveTruppLive(t, now, intervalMin, graceSec)
      if ((l.status ?? t.status) === 'raus') { prevSeverity.current.set(t.id, 0); lastNotify.current.delete(t.id); continue }
      const sev = contactSeverity(l.sinceContactSec, intervalMin, graceSec)
      const was = prevSeverity.current.get(t.id) ?? 0
      const justCrossed = sev >= 2 && was < 2
      if (justCrossed) logAlarm(t.id, 'ueberfaellig') // crossed into overdue → record once
      if (sev >= 2) {
        // OS notification carries the OS's own sound + vibration, so it still alerts when the
        // in-page Web Audio tone has been suspended (screen off / app backgrounded). Fire on the
        // crossing, then re-fire on a cadence while still overdue (tag+renotify coalesce the tray
        // entry). NOTE: a fully KILLED app still can't fire this — that needs server Web Push.
        const lastN = lastNotify.current.get(t.id) ?? 0
        if (justCrossed || now - lastN >= ALARM_RENOTIFY_MS) {
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
    alarm.current.setMuted(muted)
    // Only ÜBERFÄLLIG (tier 2) makes a sound — the amber "Kontakt fällig" lead stays silent (and
    // board-only), so the tone/wake-lock don't nag before a Trupp is actually overdue.
    alarm.current.set(peak >= 2 ? 2 : 0)
  }, [trupps, now, muted, active, logAlarm, intervalMin, graceSec, az])

  useEffect(() => () => alarm.current?.stop(), [])

  // The same per-second `now` drives a pure fold of the fleet into {peak, urgent} — the single
  // source for the cross-surface surfaces (NavRail dot + TopBar chip), so they never disagree with
  // the tone. Silent during replay (read-only past).
  return useMemo(
    () => (active ? peakAtemschutzAlarm(trupps, now, intervalMin, graceSec) : SILENT),
    [active, trupps, now, intervalMin, graceSec],
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
      || state.urgent?.severity !== prev.urgent?.severity || state.urgent?.name !== prev.urgent?.name) {
      last.current = state
      onState(state)
    }
  }, [state, onState])
  return null
}
