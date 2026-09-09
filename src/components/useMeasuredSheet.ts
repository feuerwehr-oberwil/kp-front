import { useCallback, useState } from 'react'
import type { PlanDocument } from '../types'

/**
 * The sheet's aspect ratio as the surface currently understands it — and, separately, whether that
 * number is a MEASUREMENT of the paper in front of the operator or merely the A4 seed.
 *
 * Both halves are needed and neither can be derived from the other. `aspect` always holds
 * something, because a board cannot lay out a document without one, so the value alone cannot say
 * whether anyone has looked at the bitmap. Only the viewport that rendered it knows, and
 * `stationPlanScale · noteMeasuredAspect` — which writes into the station document, shared with
 * every other device — may only ever be told a real measurement.
 *
 * ⚠️ THE SHEET IS THE `georefKey`, NEVER THE PLAN ID, and this is the whole reason the two pieces
 * of state live in one hook. `activeId` is the Modul SLOT: every Einsatzobjekt has a «Modul 2», so
 * switching from building A to building B keeps the slot id while the paper underneath changes
 * completely. Keyed on the slot, the certificate stayed valid across that switch and the previous
 * building's shape was written into the station document as THIS building's measured aspect —
 * persisted, shared, and blocking B's real measurement for the rest of the session, after which
 * B's sheet re-baked onto wrong ground under a row claiming the reference had been corrected.
 * Keyed on the sheet, the switch invalidates the certificate and the value together, so the new
 * document falls back to its own A4 guess until its own viewport reports.
 *
 * `orientation` is only the seed: the A4 the plan claims to be, until something measures it.
 */
export interface MeasuredSheet {
  /** h/w of the document box, as the board lays it out */
  aspect: number
  /** what a viewport calls when it has rendered THIS sheet's bitmap */
  takeAspect: (a: number) => void
  /** is `aspect` a measurement of this sheet, rather than the seed? */
  measured: boolean
}

/** The A4 a plan claims to be, until something has measured it. h/w, so portrait is the tall one. */
const seed = (orientation: PlanDocument['orientation'] | undefined): number =>
  (orientation === 'portrait' ? 1.414 : 1 / 1.414)

export function useMeasuredSheet(
  /** the SHEET this surface is showing — `PlanDocument.georefKey`, falling back to the plan id */
  georefKey: string,
  orientation: PlanDocument['orientation'] | undefined,
): MeasuredSheet {
  /**
   * ⚠️ ONE piece of state carrying the measurement AND the sheet it came from, so the fallback is
   * STRUCTURAL rather than a reset that has to run in time. An effect that clears a stale
   * measurement on a key change is correct only if it runs before anything reads the value —
   * and child effects run first, so the viewport of the sheet being left could still be heard.
   * Derived, there is no window at all: a measurement stamped with another sheet's key simply
   * is not this sheet's aspect, from the very first render of the switch.
   *
   * Reseeding matters beyond the certificate: `aspect` feeds the fit this surface solves, its
   * Massstab and every measured distance on it, so carrying the previous building's number over
   * would misplace the reference crosses as well as certify a shape nobody measured.
   */
  const [taken, setTaken] = useState<{ sheet: string; aspect: number } | null>(null)
  const takeAspect = useCallback((a: number) => setTaken({ sheet: georefKey, aspect: a }), [georefKey])
  const measured = taken?.sheet === georefKey
  return { aspect: measured ? taken!.aspect : seed(orientation), takeAspect, measured }
}
