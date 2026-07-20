import { useState } from 'react'

/** App-wide Atemschutz alarm audibility — a per-device choice (silent / radio-heavy scenes),
 *  persisted in localStorage, NOT synced as incident data. Lives above the Atemschutz surface
 *  so the alarm runs app-wide (see useAtemschutzAlarm / AtemschutzAlarmHost), not only while
 *  that surface is mounted. Returns the flag + a toggle that also writes through. */
export function useAtemschutzMute() {
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem('kp.atemschutz.alarmMute') === '1' } catch { return false }
  })
  const toggle = () => setMuted((m) => {
    const n = !m
    try { localStorage.setItem('kp.atemschutz.alarmMute', n ? '1' : '0') } catch { /* ignore */ }
    return n
  })
  return { muted, toggle }
}
