// Geocoder for the intake address autocomplete (swisstopo search + reverse). Distinct from
// ../geo, which holds the WGS84/LV95 coordinate math.
import { apiGet } from '../api'
import type { Out } from './wire'

export type GeoHit = Out<'GeoHit'>
/** Region-biased swisstopo address search → ranked suggestions. Empty list on no match. */
export const geocodeSearch = (q: string, limit = 6) =>
  apiGet<GeoHit[]>(`/api/geocode/search?q=${encodeURIComponent(q)}&limit=${limit}`)

/** Reverse geocode a map-clicked WGS84 point → nearest registered address (or null). */
export const geocodeReverse = (lat: number, lng: number) =>
  apiGet<GeoHit | null>(`/api/geocode/reverse?lat=${lat}&lng=${lng}`)
