import { useEffect, useState } from 'react'
import type { LngLat } from '../types'
import { fetchElevationProfile, type ProfileResult } from './profile'

/**
 * swisstopo height profile for a path — debounced, abortable, and shared by both places that show
 * one: the Messen tool (which re-fetches while the operator is still setting points) and the line
 * editor's Höhenprofil section (which fetches once, when the section is opened).
 *
 * `enabled` false — tool inactive, section collapsed, fewer than two points — clears the result
 * without a request. A null result is not an error: outside Switzerland, or offline, there simply
 * is no profile, and the caller shows «Kein Höhenprofil verfügbar» next to the distance.
 */
export function useLineProfile(coords: LngLat[], enabled: boolean, debounceMs = 450): { profile: ProfileResult | null; loading: boolean } {
  const [profile, setProfile] = useState<ProfileResult | null>(null)
  const [loading, setLoading] = useState(false)
  // The effect keys off a value signature rather than the array identity — a caller that derives
  // its coords per render (the selected drawing) would otherwise re-fetch on every render — and
  // reads the path back out of that signature, so the request can never lag the key it ran for.
  const key = enabled && coords.length >= 2 ? coords.map((c) => `${c[0]},${c[1]}`).join(' ') : ''

  useEffect(() => {
    if (!key) { setProfile(null); setLoading(false); return }
    setLoading(true)
    const ctrl = new AbortController()
    const path = key.split(' ').map((p) => p.split(',').map(Number) as LngLat)
    const t = setTimeout(() => {
      fetchElevationProfile(path, ctrl.signal).then((res) => {
        if (ctrl.signal.aborted) return
        setProfile(res); setLoading(false)
      })
    }, debounceMs)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [key, debounceMs])

  return { profile, loading }
}
