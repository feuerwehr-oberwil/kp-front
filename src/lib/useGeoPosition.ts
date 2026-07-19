import { useEffect, useState } from 'react'
import type { LngLat } from '../types'

/**
 * Best-effort device GPS as [lng, lat]; null until a fix arrives, or if geolocation is
 * denied/unavailable. Only watches while `enabled` (so the permission prompt + battery
 * drain happen on demand, e.g. when an object picker that ranks by proximity is open).
 */
export function useGeoPosition(enabled = true): LngLat | null {
  const [pos, setPos] = useState<LngLat | null>(null)
  useEffect(() => {
    if (!enabled || !('geolocation' in navigator)) return
    const id = navigator.geolocation.watchPosition(
      (p) => setPos([p.coords.longitude, p.coords.latitude]),
      () => setPos(null),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [enabled])
  return pos
}
