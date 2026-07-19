import { useEffect, useMemo, useState } from 'react'
import type { LngLat } from '../types'
import { pathLengthM, fmtDistance, polygonAreaM2, fmtArea } from './geo'
import { fetchElevationProfile, type ProfileResult } from './profile'

// Measurement tool, extracted from App's god component. All state here is EPHEMERAL —
// it is never written to the workspace blob, so this hook is fully self-contained and
// safe to own outside the persistence/hydrate core.

export type MeasureMode = 'line' | 'area'
export interface MeasureLabel { coord: LngLat; text: string; strong: boolean }

/** Cumulative-distance labels at each vertex (line) or area at the centroid (area).
 *  Pure + exported so the geometry/formatting is unit-testable without React. */
export function measureLabels(mode: MeasureMode, path: LngLat[]): MeasureLabel[] {
  if (path.length < 2) return []
  if (mode === 'line') {
    let cum = 0
    return path.slice(1).map((c, i) => {
      cum += pathLengthM([path[i], c])
      return { coord: c, text: fmtDistance(cum), strong: i === path.length - 2 }
    })
  }
  if (path.length < 3) return []
  const cx = path.reduce((s, c) => s + c[0], 0) / path.length
  const cy = path.reduce((s, c) => s + c[1], 0) / path.length
  return [{ coord: [cx, cy] as LngLat, text: fmtArea(polygonAreaM2(path)), strong: true }]
}

export interface Measure {
  mode: MeasureMode
  setMode: (m: MeasureMode) => void
  /** the active path (line OR area, depending on mode) — each mode keeps its own points */
  path: LngLat[]
  setPath: (fn: (pts: LngLat[]) => LngLat[]) => void
  /** clear BOTH line + area paths (the dock × / cancel) */
  reset: () => void
  labels: MeasureLabel[]
  profile: ProfileResult | null
  loading: boolean
}

/**
 * Measurement tool state: a line (distance + height profile) or area (area + perimeter).
 * `active` (the measure tool being selected) gates the labels + the swisstopo profile
 * fetch, mirroring the previous `tool === 'measure'` guards. Switching mode never reuses
 * the other mode's points; results are ephemeral and never saved.
 */
export function useMeasure(active: boolean): Measure {
  const [mode, setMode] = useState<MeasureMode>('line')
  const [line, setLine] = useState<LngLat[]>([])
  const [area, setArea] = useState<LngLat[]>([])
  const [profile, setProfile] = useState<ProfileResult | null>(null)
  const [loading, setLoading] = useState(false)

  const path = mode === 'line' ? line : area
  const setPath = (fn: (pts: LngLat[]) => LngLat[]) => (mode === 'line' ? setLine(fn) : setArea(fn))
  const reset = () => { setLine([]); setArea([]) }

  const labels = useMemo(() => (active ? measureLabels(mode, path) : []), [active, mode, path])

  // fetch the swisstopo height profile for a measured line (debounced, abortable);
  // a null result (outside CH / API down) just leaves the panel showing distance
  useEffect(() => {
    if (!active || mode !== 'line' || line.length < 2) { setProfile(null); setLoading(false); return }
    setLoading(true)
    const ctrl = new AbortController()
    const p = line
    const t = setTimeout(() => {
      fetchElevationProfile(p, ctrl.signal).then((res) => {
        if (ctrl.signal.aborted) return
        setProfile(res); setLoading(false)
      })
    }, 450)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [active, mode, line])

  return { mode, setMode, path, setPath, reset, labels, profile, loading }
}
