import { useCallback, useEffect, useState } from 'react'
import { audioUnlocked, onAudioState, primeAudio } from './alarm'

const MUTE_KEY = 'kp.atemschutz.alarmMute'
// The context's `statechange` (alarm.ts · onAudioState) is the primary signal; this slow tick is
// the backstop for a resume() whose transition WebKit does not report. It stops the moment
// audio runs (the normal case after the first Einsatz tap) — and, on a device whose audio never
// unlocks (a pure viewer), after the first resume-driven re-check instead of running for good.
const AUDIO_POLL_MS = 2000

/**
 * What the Atemschutz bell actually controls — one button, three honest states.
 *
 *  • **an** – the tone AND the OS notification fire.
 *  • **stumm** – BOTH are silent (`useAtemschutzAlarm` reads `muted` for the notification too;
 *    until 22.08. it ignored it, so the button with "aus" on it never reached that channel).
 *  • **nicht freigegeben** – the browser has not released audio, so only the notification can
 *    fire. The bell says so instead of claiming to be armed; tapping it retries the unlock,
 *    because a tap is exactly the gesture the browser is waiting for.
 *
 * The mute is per DEVICE (a silent tablet is a property of the room, not of the Einsatz) but
 * scoped to ONE Einsatz: the key stores the incident id it was set for, so the next Einsatz
 * starts armed. It used to hold a bare `'1'` with no scope and no expiry — a tablet muted at a
 * drill in February was still silent at a real Einsatz in August. An old `'1'` matches no
 * incident id and therefore reads as unmuted, which is the migration.
 */
export function useAtemschutzMute(incidentId: string) {
  const [mutedFor, setMutedFor] = useState<string | null>(() => {
    try { return localStorage.getItem(MUTE_KEY) } catch { return null }
  })
  const muted = mutedFor === incidentId

  const toggle = useCallback(() => {
    const next = muted ? null : incidentId
    try {
      if (next) localStorage.setItem(MUTE_KEY, next)
      else localStorage.removeItem(MUTE_KEY)
    } catch { /* ignore — the mute is a preference, not a record */ }
    setMutedFor(next)
  }, [muted, incidentId])

  /** Idempotent acknowledgement path for an alarm action such as «Zum Trupp». Unlike `toggle`,
   *  a second tap can never re-arm a tone the operator just acknowledged. The visual alarm stays
   *  live until a contact/pressure event clears its cause (useAtemschutzAlarm). */
  const mute = useCallback(() => {
    try { localStorage.setItem(MUTE_KEY, incidentId) } catch { /* preference only */ }
    setMutedFor(incidentId)
  }, [incidentId])

  const [audioReady, setAudioReady] = useState(audioUnlocked)
  // true once the app has come back to the foreground at least once — the poll's off switch
  const [resumed, setResumed] = useState(false)
  // Re-read on every state transition the context reports, AND when the app resumes
  // (visibility/focus): a phone call or Siri leaves WebKit's context `'interrupted'` — a state
  // the old «poll until running, then stop for good» never saw again, so the bell kept saying
  // «an» over a silent tone. Read afresh, the bell flips back to «nicht freigegeben» and its tap
  // re-primes (the retry every pip makes in alarm.ts needs a gesture on WebKit).
  useEffect(() => {
    const check = () => setAudioReady(audioUnlocked())
    const off = onAudioState(check)
    const onResume = () => { if (!document.hidden) { check(); setResumed(true) } }
    document.addEventListener('visibilitychange', onResume)
    window.addEventListener('focus', onResume)
    return () => {
      off()
      document.removeEventListener('visibilitychange', onResume)
      window.removeEventListener('focus', onResume)
    }
  }, [])
  useEffect(() => {
    if (audioReady || resumed) return
    const t = setInterval(() => setAudioReady(audioUnlocked()), AUDIO_POLL_MS)
    return () => clearInterval(t)
  }, [audioReady, resumed])

  /** Retry the unlock from a user gesture (the bell's own tap). */
  const unlockAudio = useCallback(() => {
    primeAudio()
    setAudioReady(audioUnlocked())
  }, [])

  // Only worth saying while the alarm claims to be on: a muted bell promises no tone anyway,
  // and two warnings about the same silence would be one too many.
  return { muted, mute, toggle, audioBlocked: !audioReady && !muted, unlockAudio }
}
