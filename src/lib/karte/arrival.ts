// «Karte & Objekte» — the wave the station objects arrive in (owner, 20.10.2026, after Wispr
// Flow's streak grid: «a very subtle loading animation for the stuff that arrives»). The
// catalogue answers in one go and the dots and name tags used to land in one frame; now each
// marker fades in a few milliseconds after its western neighbour, so the map reads as filling
// from left to right — ARRIVAL_SWEEP_MS across the screen, 260ms per marker (Karte.module.css ·
// .arrive). KarteApp computes the delays ONCE, from the view the catalogue arrived in, and only
// markers mounted in the moments after it wear them; a tag replacing its dot on a later zoom or a
// re-selection mounts instantly — motion on an interaction reads as lag (docs/ui-conventions).
//
// Computed WITHOUT the map: IndexedDB answers before MapLibre stands, so there is no map to
// project with. A north-up Web-Mercator x is the screen x up to the bearing; a restored session
// is the only way to launch rotated, and a slightly skewed wave is not worth a projection then.

import type { LngLat } from '../../types'
import type { StationObject } from '../api/stationReference'
import { worldPx } from '../mapView'
import { coordOf } from './search'

/** the wave's run from the left edge of the screen to the right */
export const ARRIVAL_SWEEP_MS = 420
/** one marker's fade (Karte.module.css · .arrive) */
export const ARRIVAL_FADE_MS = 260
/** how long after the wave began a mounting marker still joins it */
export const ARRIVAL_WINDOW_MS = 2500
/** The wave waits for the basemap: the catalogue (IndexedDB) answers before the first tiles are
 *  drawn, and a wave over a blank canvas is one nobody sees — the markers stand invisible until
 *  the map's first settled frame (MapView · onSettled, MapLibre's `idle`: every tile loaded or
 *  failed, so offline it comes at once), and at the latest after this long. */
export const ARRIVAL_MAP_WAIT_MS = 4000

/** ms of delay per object id: its place in the wave, 0 at the screen's left edge, the full sweep
 *  at the right; an object off-screen clamps to the nearer edge. Objects without coordinates
 *  have no marker and no entry. */
export function arrivalDelays(objects: readonly Pick<StationObject, 'id' | 'lat' | 'lng'>[], view: { center: LngLat; zoom: number }, widthPx: number): Map<string, number> {
  // worldPx is 256px per tile; MapLibre's screen is 512 — one zoom level up makes it screen pixels
  const z = view.zoom + 1
  const cx = worldPx(view.center, z)[0]
  const out = new Map<string, number>()
  for (const o of objects) {
    const c = coordOf(o)
    if (!c) continue
    const x = worldPx(c, z)[0] - cx + widthPx / 2
    const t = Math.min(1, Math.max(0, x / widthPx))
    out.set(o.id, Math.round(t * ARRIVAL_SWEEP_MS))
  }
  return out
}

/** The delay for a marker that mounts `elapsedMs` after the wave began, at `placeMs` in it: the
 *  rest of its wait, or 0 once the wave has reached it — and null when its fade has already
 *  passed, so a tag that replaces its dot a second into the window stands at once instead of
 *  blinking out and fading in again (CodeRabbit on #437). Decided ONCE per element: a changed
 *  animation-delay restarts a finished CSS animation. */
export function waveDelay(placeMs: number, elapsedMs: number): number | null {
  if (elapsedMs > placeMs + ARRIVAL_FADE_MS) return null
  return Math.max(0, Math.round(placeMs - elapsedMs))
}
