import { useCallback, useEffect, useState } from 'react'
import { audioUnlocked, primeAudio } from './alarm'

const MUTE_KEY = 'kp.atemschutz.alarmMute'
// The audio state only ever changes via a resume() that resolves asynchronously, and there is no
// event we subscribe to here — so while the tone is still blocked the flag is re-read on a slow
// tick. It stops the moment audio runs, which is the normal case after the first Einsatz tap.
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

  const [audioReady, setAudioReady] = useState(audioUnlocked)
  useEffect(() => {
    if (audioReady) return
    const t = setInterval(() => setAudioReady(audioUnlocked()), AUDIO_POLL_MS)
    return () => clearInterval(t)
  }, [audioReady])

  /** Retry the unlock from a user gesture (the bell's own tap). */
  const unlockAudio = useCallback(() => {
    primeAudio()
    setAudioReady(audioUnlocked())
  }, [])

  // Only worth saying while the alarm claims to be on: a muted bell promises no tone anyway,
  // and two warnings about the same silence would be one too many.
  return { muted, toggle, audioBlocked: !audioReady && !muted, unlockAudio }
}
