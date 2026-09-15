import type { PlanFloor } from './api/reference'
import { referenceUrl } from './api/reference'
import { effectiveBindingGeoref, type IncidentPlanBinding } from './incidentPlanBindings'
import { fitSimilarity, type GeorefFit } from './georef'
import { withPdfPage } from './whiteboard'

/**
 * The active object's floor pack as the Gebäude stack needs it, read from the incident's frozen
 * binding (so a running Einsatz keeps its pages and fit whatever the station publishes later).
 *
 * Every storey tile shows the same FRAME: the reference drawing's rectangle on its page (the fit
 * page's floor 0, else the fit page's first floor). An unjoined whole floor on another page
 * shares that frame as it is – the export convention. A floor that is a REGION of a sheet is
 * shifted into the frame through its JOIN – «my point `at` is floor X's point `there»» (the same
 * staircase on both drawings) – chained floor by floor until the reference is reached, in either
 * direction and across PDF pages; a region nothing joins falls back to its rectangle's top-left corner against the
 * reference's. It is clipped to its own rectangle, so neighbouring drawings never bleed in.
 * All of this is in normalized page coordinates; the pack's ONE map fit speaks the same.
 */
export interface FloorPackTile {
  /** the page's URL (`#page=N`, lib/whiteboard · pdfPageOf) */
  url: string
  /** this floor's rectangle on its page, normalized [x0, y0, x1, y1] */
  clip: [number, number, number, number]
  /** page-coordinate shift that lays this drawing onto the reference drawing */
  shift: [number, number]
}
export interface FloorPackView {
  floors: PlanFloor[]
  tiles: Record<number, FloorPackTile>
  /** the reference drawing's rectangle – what a tile shows */
  frame: [number, number, number, number]
  fit: GeorefFit | null
  /** the fitted page's width / height (every page of the pack shares it by convention) */
  aspect: number | null
}

const WHOLE: [number, number, number, number] = [0, 0, 1, 1]

export function floorPackOf(bindings: IncidentPlanBinding[], objectId: string | null | undefined): FloorPackView | null {
  if (!objectId) return null
  const b = bindings.find((x) => x.objectId === objectId && x.floors?.length)
  if (!b?.floors) return null
  const url = referenceUrl(b.datasetId, b.planVersion)
  const pairs = effectiveBindingGeoref(b).pairs
  const onFitPage = b.floors.filter((f) => f.page === b.page)
  const ref = onFitPage.find((f) => f.index === 0) ?? onFitPage[0] ?? b.floors[0]
  const shifts = joinShifts(b.floors, ref)
  const tiles: Record<number, FloorPackTile> = {}
  for (const f of b.floors) tiles[f.index] = { url: withPdfPage(url, f.page), clip: f.clip ?? WHOLE, shift: shifts.get(f.index) ?? [0, 0] }
  return {
    floors: b.floors, tiles, frame: ref.clip ?? WHOLE,
    fit: pairs.length >= 2 && b.aspect ? fitSimilarity(pairs, b.aspect) : null,
    aspect: b.aspect ?? null,
  }
}

/** Resolve explicit joins first, in either direction and across pages. Disconnected components
 *  retain the legacy page frame (whole page) or corner fallback (crop); their joins still apply.
 *  One point supplies translation only: pages must share normalized scale and orientation. */
export function joinShifts(floors: PlanFloor[], ref: PlanFloor): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>()
  const rc = ref.clip ?? WHOLE
  const resolve = (seed: PlanFloor, shift: [number, number]) => {
    out.set(seed.index, shift)
    const pending = [seed]
    for (let i = 0; i < pending.length; i++) {
      const current = pending[i]
      const s = out.get(current.index)!
      for (const f of floors) {
        if (out.has(f.index)) continue
        const forward = f.join?.to === current.index ? f.join : undefined
        const backward = current.join?.to === f.index ? current.join : undefined
        if (!forward && !backward) continue
        const j = (forward ?? backward)!
        const sign = forward ? 1 : -1
        out.set(f.index, [s[0] + sign * (j.there[0] - j.at[0]), s[1] + sign * (j.there[1] - j.at[1])])
        pending.push(f)
      }
    }
  }
  resolve(ref, [0, 0])
  // A whole page is the existing shared-frame convention, so anchor it before orphan crops.
  for (const f of [...floors.filter(f => !f.clip), ...floors.filter(f => f.clip)]) {
    if (out.has(f.index)) continue
    const fc = f.clip ?? WHOLE
    resolve(f, f.clip ? [rc[0] - fc[0], rc[1] - fc[1]] : [0, 0])
  }
  return out
}

/** the frame's h/w as the tile box draws it: a region of a landscape page can be taller than wide */
export const frameAspect = (frame: [number, number, number, number], pageAspect: number): number =>
  (frame[3] - frame[1]) / ((frame[2] - frame[0]) * pageAspect)
