// «Karte & Objekte» — the overlays the viewer hands MapView (lib/karte/overlays builds them). Each
// list is ONE object for as long as what it draws stays: MapLayers re-sends an overlay whose
// identity changed, and the station's outlines and the underground set are thousands of rings.

import { useMemo } from 'react'
import type { NamedPoint } from '../../lib/karte/places'
import { pointerOverlays, stationOverlays, UNDERGROUND_LAYER, type ErgState } from '../../lib/karte/overlays'
import type { TileXY } from '../../lib/karte/availability'
import type { ObjectCategory } from '../../lib/karte/categories'
import type { Hover, ObjectOutlines, Sel } from '../../lib/karte/selection'
import type { StationObject } from '../../lib/api/stationReference'
import { themeToken, uiBlue } from '../../lib/themeToken'
import { undergroundOverlay, type UndergroundState } from '../../lib/underground'
import type { LngLat, PreparedMapOverlay } from '../../types'
import type { Tool } from './useKarteTools'

/** Everything over the map, bottom first (lib/karte/overlays · stationOverlays), then what the
 *  pointer has `outlined` and the line to the hydrant shown from «In der Nähe» (`hydPoint`, from
 *  `nearAt`) as overlays of their own, so a hover never rebuilds the station's. */
export function useKarteOverlays(p: {
  outlines: ObjectOutlines
  cats: ReadonlyMap<string, ObjectCategory>
  catOff: (id: string) => boolean
  sel: Sel | null
  selObj: StationObject | null
  ringsNear: (at: LngLat) => readonly LngLat[][]
  tool: Tool
  erg: ErgState
  uncached: readonly TileXY[]
  under: UndergroundState | null
  underOn: boolean
  outlined: Hover | null
  hydPoint: NamedPoint | null
  nearAt: LngLat | null
}): PreparedMapOverlay[] {
  const { outlines, cats, catOff, sel, selObj, ringsNear, tool, erg, uncached, under, underOn, outlined, hydPoint, nearAt } = p
  // «has plans» (01-tokens · --obj-plans): ink, near-white at night, near-black by day — red is danger's
  const plansInk = themeToken('--obj-plans', '#1b2330')
  const hatchInk = themeToken('--ink-faint', '#6c7686')
  // the underground buildings: dashed like an object's own garage, but in the neutral ink (never an
  // object's own ink or a category colour) and only an outline. ONE overlay object for as long as the
  // set and the theme stay, so MapLayers never re-sends ~15 000 rings on a re-render.
  const underInk = themeToken('--ink-dim', '#4d586a')
  const underRings = under?.rings
  const underOverlay = useMemo<PreparedMapOverlay | null>(() => (underRings?.length
    ? undergroundOverlay(underRings, underInk, UNDERGROUND_LAYER, 'karte-underground')
    : null), [underRings, underInk])
  const overlays = useMemo<PreparedMapOverlay[]>(() => stationOverlays({
    outlines, cats, hidden: catOff, ink: plansInk, blue: uiBlue(), hatchInk,
    sel, selId: selObj?.id ?? null, ringsNear,
    underground: underOn ? underOverlay : null,
    uncached,
    erg: tool === 'erg' ? erg : null,
  }), [outlines, selObj, sel, tool, erg, plansInk, ringsNear, uncached, hatchInk, cats, catOff, underOn, underOverlay])
  const blue = uiBlue()
  const [px, py] = nearAt ?? [null, null]
  const hoverOverlays = useMemo<PreparedMapOverlay[]>(() => pointerOverlays({
    outlined, outlines, cats, ink: plansInk, blue,
    hydrantLine: hydPoint && px != null && py != null ? [[px, py], hydPoint.coord] : null,
  }), [outlined, outlines, cats, plansInk, blue, hydPoint, px, py])
  return useMemo(() => (hoverOverlays.length ? [...overlays, ...hoverOverlays] : overlays), [overlays, hoverOverlays])
}
