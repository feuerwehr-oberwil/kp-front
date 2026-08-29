/** «Karte verknüpfen» — the pairing mode that produces a plan's georeference.
 *
 *  The MATH lives in lib/georef.ts and the STORAGE in lib/stationPlanScale.ts. This file is the
 *  third piece: the little machine that decides what the operator is being asked for right now,
 *  and the module-level store that machine lives in.
 *
 *  ## Why a module store and not component state
 *
 *  The mode spans two surfaces. On a tablet they are side by side and both components are
 *  mounted — but on a PHONE the app hops between them, and `Whiteboard` only exists while
 *  `mode === 'plans'`. The map half of a pair is therefore completed at a moment when the
 *  component that armed the mode has been unmounted for a second or two. State held in the
 *  Whiteboard would be thrown away exactly halfway through the one gesture the mode exists for.
 *  So the state lives outside React, both surfaces subscribe to it, and the persistence lives
 *  here too — the save must not be the responsibility of a component that may not be alive.
 *
 *  ## The machine: numbered SLOTS, not queues
 *
 *  `planId` set ⇒ the mode is armed on that plan; null ⇒ off. The points live in `slots`: one
 *  slot per landmark, holding an optional plan half and an optional map half. Slot index + 1 is
 *  the number BOTH surfaces print, so a mispairing is something the eye catches — the numbers on
 *  the sheet and on the map either agree or they visibly don't.
 *
 *  ⚠️ Until 29.08. the two halves were two implicit FIFO queues and a tap on the far surface
 *  always completed the OLDEST open half — order was the pairing. That silently welded together
 *  halves the operator never meant as one landmark, and the only fix was delete-and-redo. Now
 *  the pairing is `settleSlots`: while the geometry says nothing (fewer than three measured
 *  pairs) halves still merge conservatively in capture order — the natural walk-the-plan flow is
 *  untouched — but once a credible fit stands, a new half only merges with the open half it
 *  actually LANDS ON under that fit. Halves that match nothing stay open, amber, on either or
 *  both surfaces, until their true partner arrives («set somewhat random points on both places;
 *  when they match we're good»). On top of that, `rematchPairs` (lib/georef) re-deals a
 *  completed set whose assignment is clearly wrong and clearly fixable — except slots the
 *  operator paired BY HAND (`fixed`), which survive every automatic re-deal.
 *
 *  A half without a counterpart is not a pair and never persists: only `pairs` (the complete
 *  slots, derived) is saved. «Fertig» keeps every complete pair and drops the open halves.
 *
 *  ## Selection, not a modal pick
 *
 *  Tapping a cross SELECTS it (`sel`): a halo plus a small popover — Verschieben / Punkt löschen
 *  / Behalten. Nothing goes inert while something is selected; tapping beside the popover simply
 *  puts it away. Only «Verschieben» (`move`) arms a re-place, and even that owns nothing but its
 *  own surface: the next tap THERE re-places the half, taps on the other surface still place
 *  points, and Esc/«Behalten» put the cross back down untouched.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { BASELINE_WARN_M, fitSimilarity, rematchPairs, residualClaim, samePlanPt, type GeoPt, type GeorefFit, type GeorefPair, type PlanPt } from './georef'
import { georefForPlan, saveGeoref, subscribeStationPlanScales } from './stationPlanScale'
import { useIsPhone } from './useIsPhone'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'

/** Which surface a half (or the operator's attention) belongs to. */
export type GeorefSide = 'plan' | 'map'

/** One numbered landmark: complete once both halves stand. */
export interface GeorefSlot {
  /** the sheet half — absent while the point only exists on the map */
  plan?: PlanPt
  /** the map half — absent while the point only exists on the sheet */
  map?: GeoPt
  kind?: 'gesetzt' | 'korrigiert'
  /** paired BY HAND (two halves tapped in sequence) — the automatic re-matcher and the
   *  fit-guided merge must never re-deal an assignment the operator made explicitly */
  fixed?: true
}

/** One half, addressed: the selected cross, or the one being re-placed. */
export interface GeorefHalfRef {
  idx: number
  side: GeorefSide
}

export interface GeorefModeState {
  /** the plan being georeferenced — null means the mode is off */
  planId: string | null
  /** station-storage key for this concrete object's sheet. `planId` is only the reusable
   *  Modul slot; keeping both prevents Modul 2 of object A from overwriting Modul 2 of object B. */
  storageKey: string | null
  /** every numbered point, complete or half — slot index + 1 is the badge on both surfaces */
  slots: GeorefSlot[]
  /** DERIVED from `slots` on every change: the complete pairs in slot order. This is what the
   *  fit solves from and the ONLY thing that persists. Identity-stable — the array only changes
   *  when a complete pair actually changed, which is what the store's save trigger compares. */
  pairs: GeorefPair[]
  /** a cross was tapped: halo + popover (Verschieben / Punkt löschen / Behalten). Selection
   *  makes NOTHING inert — a tap beside the popover puts it away, everything else still works. */
  sel: GeorefHalfRef | null
  /** «Verschieben» armed: the next tap on that half's own surface re-places it. The other
   *  surface stays fully live; Esc / «Behalten» puts the cross back down unchanged. */
  move: GeorefHalfRef | null
  /** the surface that must be in front of the operator (the phone hops to it) */
  want: GeorefSide
  /** the sheet's aspect (width / height) the fit is solved at, handed over when the mode is
   *  armed. ⚠️ The MAP side needs it: it solves the same fit to draw «Deckung prüfen», and it
   *  has no way of its own to know the shape of a sheet it is not showing (georefTwins ·
   *  planAspect for why a wrong aspect tilts everything). */
  aspect: number
  /** «Deckung prüfen» is up: the sheet's own outline lies on the map. ⚠️ ONE-SHOT — any
   *  placement, correction or reset clears it. It is a look, not a layer. */
  check: boolean
  /** Where «Fertig» in coverage returns. A check launched from Passung briefly keeps the mode
   *  alive until the phone has mounted its Modul again; Whiteboard then restores Passung and
   *  ends the temporary mode. */
  checkReturn: 'quality' | 'alignment' | null
  /** The alignment itself was launched from Passung. Its final/cancel action uses the same
   *  cross-surface return handshake as coverage instead of dropping a phone on Karte. */
  returnToQuality: boolean
  /** Opacity of the Modul bitmap during «Deckung prüfen» (0 map only … 1 Modul only). The
   *  outline remains visible at zero, so the control can never make the check look broken. */
  checkOpacity: number
  /** Snapshot of the plan bitmap used by «Deckung prüfen». Kept in the cross-surface store so
   *  the map can paint it even on a phone, where the Whiteboard is unmounted. */
  previewUrl: string | null
}

export const GEOREF_OFF: GeorefModeState = { planId: null, storageKey: null, slots: [], pairs: [], sel: null, move: null, want: 'plan', aspect: 1, check: false, checkReturn: null, returnToQuality: false, checkOpacity: 0.58, previewUrl: null }

export type GeorefAction =
  | { type: 'start'; planId: string; storageKey?: string; pairs: GeorefPair[]; aspect: number; check?: boolean; returnToQuality?: boolean; previewUrl?: string | null }
  /** «Fertig» / Esc / «Abbrechen» — every half still waiting for its counterpart is dropped */
  | { type: 'end' }
  /** Hard teardown after a parent return has been restored, or when its document disappeared. */
  | { type: 'dismiss' }
  /** The phone's explicit surface hops — placement itself never navigates. */
  | { type: 'goMap' }
  | { type: 'goPlan' }
  | { type: 'planTap'; pt: PlanPt }
  | { type: 'mapTap'; lngLat: GeoPt }
  /** a cross was tapped (not dragged): halo + popover. Selecting the open half OPPOSITE an
   *  already-selected open half pairs the two by hand (`fixed`). */
  | { type: 'select'; idx: number; side: GeorefSide }
  /** «Verschieben» in the popover: arm the re-place for the selected half */
  | { type: 'beginMove' }
  /** «Behalten» / Esc: cancel the move if one is armed, else put the popover away.
   *  ⚠️ The only way out of `move` that neither moves the point nor deletes it. */
  | { type: 'unpick' }
  /** «Punkt löschen»: drop that WHOLE slot — its pair, or its dangling half — and refit */
  | { type: 'remove'; idx: number }
  /** «Punkte zurücksetzen» in the armed bar: drop every point but STAY armed */
  | { type: 'clear' }
  /** «Deckung prüfen» on / off — the sheet's outline on the map, for as long as nobody edits */
  | { type: 'check'; on: boolean; previewUrl?: string | null }
  /** Leave coverage without confusing it with «Fertig» for the alignment itself. */
  | { type: 'finishCheck' }
  | { type: 'checkOpacity'; opacity: number }
  /** live drag of any placed half — paired or open — refits on every frame */
  | { type: 'dragPlan'; idx: number; pt: PlanPt }
  | { type: 'dragMap'; idx: number; lngLat: GeoPt }

/** The actions that move NOTHING the outline is drawn from: the check's own controls, arming
 *  (the Passung's check button arms the mode WITH the look already on), a surface hop, and the
 *  selection dance around a cross that stays where it is.
 *  ⚠️ Typed against `GeorefAction['type']` rather than a bare `string[]`: an untyped list stops
 *  matching the moment an action is renamed, and it does so SILENTLY — «Deckung prüfen» would
 *  simply start closing itself on every hop between the sheet and the Karte, with nothing to
 *  point at. Its sibling `EDITS_PAIRS` is typed for the same reason. */
const KEEPS_CHECK: ReadonlySet<GeorefAction['type']> = new Set(['check', 'checkOpacity', 'finishCheck', 'start', 'goMap', 'goPlan', 'unpick', 'beginMove'])

/**
 * The whole mode as one pure function — armed / halves / pairing / correction / cancel.
 *
 * Returns the SAME object when an action changes nothing, so a caller can compare by reference
 * (the store does, to decide whether to notify and whether to persist).
 */
export function georefReduce(s: GeorefModeState, a: GeorefAction): GeorefModeState {
  const next = fold(s, a)
  // ⚠️ «Deckung prüfen» is a LOOK, not a layer: the moment anything moves — a point placed, a
  // cross corrected, a pair dropped — the outline is out of date, so it goes. One rule here
  // instead of one `check: false` in every branch that could forget it.
  return next !== s && !KEEPS_CHECK.has(a.type) && next.check
    ? { ...next, check: false, checkReturn: null }
    : next
}

// --- pairing: when do two halves become one point? -------------------------------------------

/** A fit no better than this has no say in which halves belong together — the same bar
 *  `rematchPairs` uses to call a fit «not a fit» (georef · REMATCH_BAD_M). */
const AUTOPAIR_TRUST_M = 10
/** Under a credible fit, a plan half and a map half are the SAME landmark only when they land
 *  within this of each other, in metres. Farther apart they stay open — on both surfaces. */
export const AUTOPAIR_TOL_M = 20

/** The complete slots, as the pair list every fit solves from. */
function pairsOf(slots: GeorefSlot[]): GeorefPair[] {
  const out: GeorefPair[] = []
  for (const sl of slots) if (sl.plan && sl.map) out.push({ plan: sl.plan, lngLat: sl.map, kind: sl.kind })
  return out
}

/** Metres between a plan half and a map half under a fit — the same plan-side arithmetic
 *  `rematchPairs` uses, so «close» means one thing throughout. */
function halfDistanceM(fit: GeorefFit, plan: PlanPt, map: GeoPt, aspect: number): number {
  const q = fit.toPlan(map)
  return Math.hypot((plan.x - q.x) * aspect, plan.y - q.y) * fit.scaleMPerU
}

/**
 * Fold loose halves into points. Runs after every placement and every hand-pairing:
 *
 *  1. MERGE — while both surfaces hold open halves: with fewer than three measured pairs (or a
 *     fit too bad to trust) the oldest halves merge in capture order, exactly the old queue
 *     feel; under a credible fit only halves that coincide (≤ AUTOPAIR_TOL_M) merge, closest
 *     first, and the rest stay open on both surfaces until their real partner arrives.
 *  2. ONE LANDMARK, ONE POINT — a completed pair standing on the same plan spot as an older one
 *     replaces it in place (georef · replacePair's rule, so a re-tap corrects instead of
 *     contradicting). The old number survives; the fit never sees two pairs on one corner.
 *  3. RE-DEAL — `rematchPairs` over the slots NOT paired by hand: a completed set whose
 *     assignment is clearly wrong and clearly fixable renumbers itself instead of asking for
 *     twelve points again. `fixed` slots keep the operator's explicit decision.
 */
export function settleSlots(slots: GeorefSlot[], aspect: number): GeorefSlot[] {
  let out = slots
  // 1 — merge open halves
  for (;;) {
    const planOpen = out.map((sl, i) => ({ sl, i })).filter((x) => x.sl.plan && !x.sl.map)
    const mapOpen = out.map((sl, i) => ({ sl, i })).filter((x) => x.sl.map && !x.sl.plan)
    if (!planOpen.length || !mapOpen.length) break
    const fit = fitSimilarity(pairsOf(out), aspect)
    let pi = planOpen[0].i
    let mi = mapOpen[0].i
    if (fit && fit.n >= 3 && fit.meanResidualM <= AUTOPAIR_TRUST_M) {
      let best: { pi: number; mi: number; d: number } | null = null
      for (const p of planOpen) {
        for (const m of mapOpen) {
          const d = halfDistanceM(fit, p.sl.plan!, m.sl.map!, aspect)
          if (d <= AUTOPAIR_TOL_M && (!best || d < best.d)) best = { pi: p.i, mi: m.i, d }
        }
      }
      if (!best) break // nothing coincides — the halves stay open, visibly, on both surfaces
      pi = best.pi; mi = best.mi
    }
    const lo = Math.min(pi, mi), hi = Math.max(pi, mi)
    const merged: GeorefSlot = { plan: out[pi].plan, map: out[mi].map, kind: 'gesetzt' }
    out = out.map((sl, i) => (i === lo ? merged : sl)).filter((_, i) => i !== hi)
  }
  // 2 — a new pair on an already-referenced plan spot replaces the old pair, in place
  for (let j = out.length - 1; j > 0; j--) {
    const sj = out[j]
    if (!sj.plan || !sj.map) continue
    const i = out.findIndex((si, k) => k < j && !!si.plan && !!si.map && samePlanPt(si.plan!, sj.plan!))
    if (i >= 0) out = out.map((sl, k) => (k === i ? sj : sl)).filter((_, k) => k !== j)
  }
  // 3 — automatic re-deal of a clearly mis-assigned set, sparing hand-made pairs
  const free = out.map((sl, i) => ({ sl, i })).filter((x) => x.sl.plan && x.sl.map && !x.sl.fixed)
  if (free.length >= 3) {
    const re = rematchPairs(free.map((x) => ({ plan: x.sl.plan!, lngLat: x.sl.map!, kind: x.sl.kind })), aspect)
    if (re) {
      out = out.map((sl, i) => {
        const k = free.findIndex((x) => x.i === i)
        return k >= 0 && re.pairs[k].lngLat !== sl.map ? { ...sl, map: re.pairs[k].lngLat } : sl
      })
    }
  }
  return out
}

/** Rebuild the state around a new slot list, keeping `pairs` identity-stable so the store's
 *  «did a completed pair change?» comparison (and everything memoized on `pairs`) stays honest. */
function withSlots(s: GeorefModeState, slots: GeorefSlot[], extra: Partial<GeorefModeState>): GeorefModeState {
  const next = pairsOf(slots)
  const same = next.length === s.pairs.length
    && next.every((p, i) => p.plan === s.pairs[i].plan && p.lngLat === s.pairs[i].lngLat && p.kind === s.pairs[i].kind)
  return { ...s, ...extra, slots, pairs: same ? s.pairs : next }
}

/** Is this slot's given half placed but still without its counterpart? */
function danglingHalf(sl: GeorefSlot | undefined, side: GeorefSide): boolean {
  return !!sl && (side === 'plan' ? !!sl.plan && !sl.map : !!sl.map && !sl.plan)
}

function fold(s: GeorefModeState, a: GeorefAction): GeorefModeState {
  switch (a.type) {
    case 'start':
      return {
        planId: a.planId,
        storageKey: a.storageKey ?? a.planId,
        slots: a.pairs.map((p) => ({ plan: p.plan, map: p.lngLat, kind: p.kind })),
        pairs: a.pairs,
        sel: null,
        move: null,
        want: 'plan',
        aspect: a.aspect,
        check: !!a.check,
        checkReturn: a.check ? 'quality' : null,
        returnToQuality: !!a.returnToQuality,
        checkOpacity: s.checkOpacity,
        previewUrl: a.previewUrl ?? null,
      }
    case 'check':
      return s.planId && (s.check !== a.on || (!!a.previewUrl && a.previewUrl !== s.previewUrl))
        ? { ...s, check: a.on, checkReturn: a.on ? 'alignment' : null, previewUrl: a.previewUrl ?? s.previewUrl }
        : s
    case 'finishCheck':
      return s.planId && s.check ? { ...s, check: false, checkReturn: s.checkReturn === 'quality' ? 'quality' : null } : s
    case 'checkOpacity': {
      if (!s.planId) return s
      const checkOpacity = Math.max(0, Math.min(1, a.opacity))
      return checkOpacity === s.checkOpacity ? s : { ...s, checkOpacity }
    }
    case 'end':
      return s.planId
        ? s.returnToQuality
          // half a pair never persists: only the complete slots survive the return to Passung
          ? withSlots(s, s.slots.filter((sl) => sl.plan && sl.map), { sel: null, move: null, want: 'plan', check: false, checkReturn: 'quality' })
          : GEOREF_OFF
        : s
    case 'dismiss':
      return s.planId ? GEOREF_OFF : s
    // The hops follow the operator, always — an armed `move` no longer pins the phone to one
    // surface (that stranding is what the old modal pick state did); the selection also
    // survives, so two open halves can be paired by hand across a hop.
    case 'goMap':
      return s.planId && s.want !== 'map' ? { ...s, want: 'map' } : s
    case 'goPlan':
      return s.planId && s.want !== 'plan' ? { ...s, want: 'plan' } : s
    case 'planTap': {
      if (!s.planId) return s
      // «Verschieben» armed for a plan half: this tap is its new place
      if (s.move?.side === 'plan') {
        const idx = s.move.idx
        const cur = s.slots[idx]
        if (!cur?.plan) return { ...s, move: null }
        if (s.slots.some((sl, i) => i !== idx && sl.plan && samePlanPt(sl.plan, a.pt))) return s
        const slots = s.slots.map((sl, i) => (i === idx ? { ...sl, plan: a.pt, kind: sl.map ? ('korrigiert' as const) : sl.kind } : sl))
        return withSlots(s, slots, { move: null, sel: null, want: 'plan' })
      }
      // popover open on this surface: a tap beside it puts it away, and places nothing
      if (s.sel?.side === 'plan') return { ...s, sel: null }
      return withSlots(s, settleSlots([...s.slots, { plan: a.pt, kind: 'gesetzt' }], s.aspect), { sel: null, want: 'plan' })
    }
    case 'mapTap': {
      if (!s.planId) return s
      if (s.move?.side === 'map') {
        const idx = s.move.idx
        const cur = s.slots[idx]
        if (!cur?.map) return { ...s, move: null }
        const slots = s.slots.map((sl, i) => (i === idx ? { ...sl, map: a.lngLat, kind: sl.plan ? ('korrigiert' as const) : sl.kind } : sl))
        return withSlots(s, slots, { move: null, sel: null, want: 'map' })
      }
      if (s.sel?.side === 'map') return { ...s, sel: null }
      return withSlots(s, settleSlots([...s.slots, { map: a.lngLat, kind: 'gesetzt' }], s.aspect), { sel: null, want: 'map' })
    }
    case 'select': {
      const sl = s.slots[a.idx]
      if (!s.planId || !sl) return s
      if (!(a.side === 'plan' ? sl.plan : sl.map)) return s
      // tapping the matching OPEN half on the other surface pairs the two by hand — `fixed`,
      // so no automatic re-deal ever overrides what the operator just decided explicitly
      if (s.sel && s.sel.side !== a.side && danglingHalf(s.slots[s.sel.idx], s.sel.side) && danglingHalf(sl, a.side)) {
        const planIdx = a.side === 'plan' ? a.idx : s.sel.idx
        const mapIdx = a.side === 'plan' ? s.sel.idx : a.idx
        const lo = Math.min(planIdx, mapIdx), hi = Math.max(planIdx, mapIdx)
        const merged: GeorefSlot = { plan: s.slots[planIdx].plan, map: s.slots[mapIdx].map, kind: 'gesetzt', fixed: true }
        const slots = s.slots.map((x, i) => (i === lo ? merged : x)).filter((_, i) => i !== hi)
        return withSlots(s, settleSlots(slots, s.aspect), { sel: null, move: null })
      }
      // the same cross again toggles the popover away
      if (s.sel && s.sel.idx === a.idx && s.sel.side === a.side) return { ...s, sel: null }
      return { ...s, sel: { idx: a.idx, side: a.side }, move: null, want: a.side }
    }
    case 'beginMove':
      return s.planId && s.sel ? { ...s, move: s.sel, sel: null, want: s.sel.side } : s
    case 'unpick':
      // Esc peels ONE layer at a time: an armed move first (the cross goes back down,
      // untouched), then the popover. `want` stays — nobody gets yanked to the other surface.
      if (!s.planId) return s
      if (s.move) return { ...s, move: null }
      if (s.sel) return { ...s, sel: null }
      return s
    case 'remove': {
      // A point the operator can see is wrong has to be REMOVABLE, not only re-placeable: the
      // landmark itself can turn out to be the mistake («that is not the same corner»), and
      // re-placing it somewhere else only moves the error. Dropping it refits from the rest —
      // below two pairs there is no fit at all, which is the honest state and exactly what the
      // chip then says (fitSimilarity returns null, the twins disappear).
      if (!s.planId || !s.slots[a.idx]) return s
      return withSlots(s, s.slots.filter((_, i) => i !== a.idx), { sel: null, move: null })
    }
    case 'clear': {
      // ⚠️ STAYS armed. «Punkte zurücksetzen» is «start over», not «leave» — the next thing
      // that happens is always a fresh first point. «Abbrechen» beside it is the one that keeps
      // what already stands.
      if (!s.planId || (!s.slots.length && !s.sel && !s.move)) return s
      // the same empty arrays back when there was nothing to clear — the store persists on a
      // CHANGED `pairs` identity, and a write that deletes an entry that never existed is noise
      return {
        ...s,
        slots: s.slots.length ? [] : s.slots,
        pairs: s.pairs.length ? [] : s.pairs,
        sel: null,
        move: null,
        want: 'plan',
      }
    }
    case 'dragPlan': {
      const cur = s.slots[a.idx]
      if (!cur?.plan) return s
      // ⚠️ Never ONTO another cross. Two plan points closer than PAIR_EPS_N are the same landmark
      // (georef · samePlanPt), and references without plan-side spread have no fit at all — so
      // the whole sheet would come unstuck the moment a dragged finger passed over a neighbour.
      // Refusing the move leaves the cross where the operator last saw it, which is the only
      // outcome here they can act on.
      if (s.slots.some((sl, i) => i !== a.idx && sl.plan && samePlanPt(sl.plan, a.pt))) return s
      const slots = s.slots.map((sl, i) => (i === a.idx ? { ...sl, plan: a.pt, kind: sl.map ? ('korrigiert' as const) : sl.kind } : sl))
      return withSlots(s, slots, {})
    }
    case 'dragMap': {
      const cur = s.slots[a.idx]
      if (!cur?.map) return s
      const slots = s.slots.map((sl, i) => (i === a.idx ? { ...sl, map: a.lngLat, kind: sl.plan ? ('korrigiert' as const) : sl.kind } : sl))
      return withSlots(s, slots, {})
    }
  }
}

// --- tap vs. drag ---------------------------------------------------------------------------

/**
 * How far a pointer may travel before the gesture stops being a tap, in screen px.
 *
 * ⚠️ 10, and the SAME 10 on both surfaces and for the crosses. The prototype used 4, which was
 * chosen with a mouse: with a glove on, every intended tap came out as a two-millimetre drag.
 * MapLibre's own `clickTolerance` is 3 and — worse for this mode — it compares only the START
 * and END points, so a pan of several hundred px that happens to finish where it began still
 * counts as a click. That is why the map does not rely on it here (see MapView · georef tap).
 */
// 16, not 10: a deliberate finger tap on glass wobbles 10–15px, and at 10 a tablet tap was
// regularly read as a pan and placed nothing. 16 is the app's own touch tap tolerance
// (useHoldToDrag · TAP_TOL_PX, «generous for fat fingers»); a real pan travels far past it.
export const GEOREF_TAP_SLOP_PX = 16

/** A pointer gesture in progress, as far as «was that a tap?» is concerned. */
export interface TapGesture {
  x: number
  y: number
  /** ⚠️ STICKY. Once the pointer has travelled past the slop the gesture is a drag for good —
   *  bringing the finger back to where it started does not turn a pan back into a tap. */
  moved: boolean
  /** a second finger landed: a pinch or a two-finger pan, never a placement */
  multi: boolean
}

export function beginTap(x: number, y: number, multi = false): TapGesture {
  return { x, y, moved: false, multi }
}

/** Fold one pointer sample into the gesture. Mutates — this runs per move event, on a value that
 *  lives in a ref precisely so it never re-renders anything. */
export function trackTap(g: TapGesture | null, x: number, y: number, multi = false): void {
  if (!g) return
  if (multi) g.multi = true
  if (!g.moved && Math.hypot(x - g.x, y - g.y) > GEOREF_TAP_SLOP_PX) g.moved = true
}

/** Did that gesture place a point? A drag, a pinch, or nothing at all does not. */
export function isPlacingTap(g: TapGesture | null): boolean {
  return !!g && !g.moved && !g.multi
}

/**
 * Tap-vs-pan on the MAP, tracked by hand.
 *
 * ⚠️ MapLibre's own `click` is NOT good enough here, and neither is raising its
 * `clickTolerance`: that tolerance compares only where the pointer went DOWN with where it came
 * UP. Pan the map three hundred pixels and bring it back to where it started — the two points
 * coincide, MapLibre calls that a click, and the operator gets a reference point they never
 * asked for in the middle of a pan. (Raising it would also change the drag threshold for every
 * other gesture on the app's one map, which this mode has no business doing.)
 *
 * So the placement rides on pointer-up with a sticky `moved` flag fed by every move sample, the
 * same discrimination — and the same slop — as the plan half. Panning, pinching and inertia are
 * left completely alone: nothing here consumes or cancels a gesture, it only decides afterwards
 * whether that gesture was a tap.
 */
export function useGeorefMapTap() {
  const g = useRef<TapGesture | null>(null)
  return {
    /** pointer down on the map */
    start: (p: { x: number; y: number }, multi = false) => { g.current = beginTap(p.x, p.y, multi) },
    /** one move sample (mouse or touch) */
    track: (p: { x: number; y: number }, multi = false) => trackTap(g.current, p.x, p.y, multi),
    /** MapLibre says a real pan began — that settles it however small the travel looked */
    panned: () => { if (g.current) g.current.moved = true },
    /** pointer up: was that a placement? Consumes the gesture either way. */
    end: () => { const was = isPlacingTap(g.current); g.current = null; return was },
  }
}

/** Did this map gesture BEGIN on one of the mode's own crosses (or any other marker)? Then it
 *  belongs to that cross — its tap is a select, its drag a correction — and must never feed the
 *  placement machine. ⚠️ The cross's React handlers cannot shield it: MapLibre listens natively
 *  on the canvas container, which sits BELOW the React root, so a `stopPropagation` in the
 *  button fires long after the map has already seen the event. The map side filters instead. */
export function georefTapOnMarker(target: EventTarget | null | undefined): boolean {
  // duck-typed rather than `instanceof Element`: touch targets can come from another document
  // (and the pure tests run without a DOM), while `closest` is the one capability actually used
  const el = target as Element | null | undefined
  return typeof el?.closest === 'function' && !!el.closest('.maplibregl-marker')
}

/** Is a PLAN half being re-placed? Only then do the plan's crosses go inert — the tap that is
 *  meant to land that half must not be swallowed by whichever cross happens to sit under it.
 *  ⚠️ A mere selection (popover up) makes nothing inert: marking, fine-tuning and picking other
 *  crosses all keep working in the same breath. */
export function georefPlacing(s: GeorefModeState): boolean {
  return !!s.planId && s.move?.side === 'plan'
}

/** …and the map-side mirror: only an armed re-place of a MAP half makes the map's crosses inert
 *  while its landing tap belongs to the map beneath them. */
export function georefMatching(s: GeorefModeState): boolean {
  return !!s.planId && s.move?.side === 'map'
}

/**
 * 1-based number of the point the current step is about — the popover head and the prompts.
 *
 * While a half is selected or being re-placed that is ITS number; otherwise it is the number the
 * next tap on the fronted surface will most likely carry: the oldest open counterpart it would
 * complete, or one past the end when nothing is waiting.
 */
export function georefPointNo(s: GeorefModeState): number {
  if (s.move) return s.move.idx + 1
  if (s.sel) return s.sel.idx + 1
  const opposite = s.slots.findIndex((sl) => danglingHalf(sl, s.want === 'plan' ? 'map' : 'plan'))
  return opposite >= 0 ? opposite + 1 : s.slots.length + 1
}

/** How many numbered marks stand on ONE surface, paired or still waiting — «Karte n · Modul m». */
export function georefSideCount(s: GeorefModeState, side: GeorefSide): number {
  return s.slots.filter((sl) => (side === 'plan' ? sl.plan : sl.map)).length
}

/** How many halves still wait for their counterpart, on either surface. */
export function georefOpenCount(s: GeorefModeState): number {
  return s.slots.filter((sl) => !sl.plan || !sl.map).length
}

/** Where a complete slot sits in the derived `pairs` list — the fit's residuals are per-pair,
 *  and the popover wants to print THIS point's rest. Null for an open half. */
export function georefPairIndex(s: GeorefModeState, idx: number): number | null {
  const sl = s.slots[idx]
  if (!sl?.plan || !sl.map) return null
  return s.slots.slice(0, idx).filter((x) => x.plan && x.map).length
}

/**
 * The status line's second half: which halves are still open, as one sentence.
 *
 * The panel says WHERE the dangling half is («Punkt 3 fehlt noch auf dem Modul») because the
 * amber cross saying so sits on a surface the phone may not even be showing.
 */
export function georefOpenHint(s: GeorefModeState): string | null {
  const C = appConfig.copy.whiteboard.georef
  if (s.sel) return fillTemplate(C.statusSelected, { n: String(s.sel.idx + 1) })
  const planOnly = s.slots.map((sl, i) => ({ sl, i })).filter((x) => danglingHalf(x.sl, 'plan'))
  const mapOnly = s.slots.map((sl, i) => ({ sl, i })).filter((x) => danglingHalf(x.sl, 'map'))
  if (!planOnly.length && !mapOnly.length) return null
  if (planOnly.length && mapOnly.length) return C.statusOpenBoth
  // a plan-only half is missing its KARTE counterpart, and vice versa
  const open = planOnly.length ? planOnly : mapOnly
  const tpl = planOnly.length
    ? open.length === 1 ? C.statusOpenMap : C.statusOpenMapMany
    : open.length === 1 ? C.statusOpenPlan : C.statusOpenPlanMany
  return fillTemplate(tpl, { n: String(open[0].i + 1), k: String(open.length) })
}

// --- what the chip says ---------------------------------------------------------------------

/** Everything that is wrong with a fit, worst first. Empty = the read-out may go green.
 *  `twoPoints` is not a defect but the absence of a measurement, and it colours the chip amber
 *  for exactly that reason: an unmeasured fit must not look like a checked one. */
export type GeorefWarning = 'twoPoints' | 'collinear' | 'baseline'

export function georefWarnings(fit: GeorefFit | null): GeorefWarning[] {
  if (!fit) return []
  const w: GeorefWarning[] = []
  if (fit.n < 3) w.push('twoPoints')
  if (fit.collinear) w.push('collinear')
  if (fit.baselineM < BASELINE_WARN_M) w.push('baseline')
  return w
}

export interface GeorefChip {
  /** `unlinked` = no usable fit and not armed · `armed` = placing on THIS plan · `linked` = a
   *  fit stands. Armed wins: while the operator is placing, the chip's slot in the row belongs
   *  to the mode's instrument, not to a quality read-out (see GeorefMode · GeorefInstrument). */
  kind: 'unlinked' | 'armed' | 'linked'
  /** linked: the residual that may be CLAIMED — null at two pairs (see georef · residualClaim) */
  residualM: number | null
  /** linked: any warning stands ⇒ amber, none ⇒ the green tone */
  warn: boolean
}

/**
 * The chip's whole appearance in one value. Armed beats linked: while the operator is placing,
 * the chip is the progress read-out, not the quality read-out.
 */
export function georefChip(fit: GeorefFit | null, mode: GeorefModeState, planId: string): GeorefChip {
  const armed = mode.planId === planId
  const warnings = georefWarnings(fit)
  return {
    kind: armed ? 'armed' : fit ? 'linked' : 'unlinked',
    // ⚠️ through `residualClaim`, never the rule re-typed here: the «no ⌀ 0.0 m at two pairs»
    // honesty rule has to have exactly one home, or one surface starts claiming what another
    // refuses to (see georef · residualClaim).
    residualM: residualClaim(fit),
    warn: warnings.length > 0,
  }
}

/** The Ampel: how good the reference is RIGHT NOW, and what the next point changes about it. */
export interface GeorefLamp {
  /** red = no fit yet · amber = a fit that is unmeasured or warned about · green = measured */
  tone: 'red' | 'amber' | 'green'
  /** the state, in three or four words — «2 Punkte – exakt, aber ungeprüft» */
  head: string
  /** why that is, and what one more point buys — the instruction behind the (i). The sentence
   *  the operator is missing when they decide to stop at two. */
  body: string
}

/**
 * The reading that stands beside the instruction for the whole of the mode.
 *
 * ⚠️ This is the one thing «Karte verknüpfen» never said. The bar counted pairs («2 Paare»),
 * which is a fact nobody can have an opinion about: it does not say whether that is enough, and
 * the warning that it is NOT — two pairs solve exactly, so the residual is zero by construction
 * — lived in the Passung panel, one tap away, i.e. exactly where somebody who is about to stop
 * at two points will never look. So the warning moves to where the decision is made.
 *
 * Pure, and the ONLY place the tone is decided, so the phone bar and the desktop instrument
 * cannot end up disagreeing about whether a reference is good.
 */
export function georefLamp(fit: GeorefFit | null, mode: GeorefModeState): GeorefLamp {
  const C = appConfig.copy.whiteboard.georef
  const n = mode.pairs.length
  const open = georefOpenCount(mode)
  const withOpen = (head: string) => (open ? `${head} · ${fillTemplate(C.barOpen, { n: String(open) })}` : head)
  if (!fit || n < 2) {
    return n === 0
      ? { tone: 'red', head: withOpen(C.lampNoneHead), body: C.lampNoneBody }
      : { tone: 'red', head: withOpen(C.lampOneHead), body: C.lampOneBody }
  }
  // ⚠️ Through `residualClaim`, never `meanResidualM` directly — the «no ⌀ 0.0 m at two pairs»
  // rule has exactly one home (georef · residualClaim) and this is a caller, not a second copy.
  const claim = residualClaim(fit)
  if (claim == null) return { tone: 'amber', head: withOpen(C.lampTwoHead), body: C.warnTwoPoints }
  const head = withOpen(fillTemplate(C.lampGoodHead, { n: String(n), m: claim.toFixed(1) }))
  // a measured fit can still be a bad one, and then the number is the least useful thing on the
  // bar: say what is wrong with the POINTS instead, which is what the next one has to fix
  if (fit.collinear) return { tone: 'amber', head, body: C.warnCollinear }
  if (fit.baselineM < BASELINE_WARN_M) {
    return { tone: 'amber', head, body: fillTemplate(C.warnBaseline, { m: String(Math.round(fit.baselineM)) }) }
  }
  return { tone: 'green', head, body: C.lampGoodBody }
}

// --- the store ------------------------------------------------------------------------------

let state: GeorefModeState = GEOREF_OFF
const listeners = new Set<() => void>()
// Bumped whenever a plan's STORED georeference changes. `georefForPlan` is a synchronous read of
// a module singleton, so a surface that shows the saved reference has nothing to re-render on —
// this counter is that something. Deliberately not part of the machine's state: it is a fact
// about storage, not about the mode.
let rev = 0

// …including a change that came from ANOTHER DEVICE. The station document is re-read on focus /
// when a plan is opened (stationPlanScale · refreshStationPlanScales); without this line the new
// pairs would sit in the singleton with nothing on screen re-reading them.
subscribeStationPlanScales(() => { rev++; listeners.forEach((l) => l()) })

/** Called with the reason a save failed, so the UI can raise the app's standard error toast.
 *  Set once by the Whiteboard; the store itself knows nothing about toasts or copy. */
let onSaveError: (() => void) | null = null
export function setGeorefSaveErrorHandler(fn: (() => void) | null) { onSaveError = fn }

// The pairs are persisted from HERE, not from a component: on a phone the pair that has to be
// saved is completed while the Whiteboard is unmounted. Lightly debounced so a drag writes once
// on release rather than once per frame; flushed when the mode ends so nothing is left in the
// air. A failed PUT keeps the local pairs — the next save writes the whole list again, so a
// retry needs no queue of its own (saveGeoref replaces the document wholesale).
const SAVE_DEBOUNCE_MS = 400
let saveTimer: ReturnType<typeof setTimeout> | null = null
let savePending: { georefKey: string; pairs: GeorefPair[] } | null = null

function flushSave(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const job = savePending; savePending = null
  if (!job) return Promise.resolve()
  return saveGeoref(job.georefKey, { pairs: job.pairs }).catch(() => onSaveError?.())
}

function queueSave(georefKey: string, pairs: GeorefPair[]) {
  savePending = { georefKey, pairs }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void flushSave() }, SAVE_DEBOUNCE_MS)
}

/**
 * Clear the way for a write to `georefKey`, and hand back the promise it must queue behind.
 *
 * ⚠️ Two PUTs to `/api/plan-scales` may never be in the air at once. `apiPut` is a bare fetch
 * with no serialization, the endpoint has no If-Match, and every PUT replaces the WHOLE
 * document — so whichever lands second wins outright, whatever order they were sent in. A
 * pending write for the SAME key is simply dropped: the caller is about to replace exactly what
 * it holds. One for another key still has to happen, so it is flushed and awaited instead.
 */
function settleSave(georefKey: string): Promise<void> {
  if (savePending && savePending.georefKey !== georefKey) return flushSave()
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  savePending = null
  return Promise.resolve()
}

/** The actions that can genuinely EDIT the reference — `select` is here because pairing two
 *  halves by hand completes a pair. ⚠️ Everything else is deliberately excluded, and `end`
 *  above all: leaving the mode moves the pairs from the live list to the empty one, so a naive
 *  «pairs changed ⇒ save» would have written an EMPTY georeference every time somebody pressed
 *  «Fertig» — the one button whose whole job is to keep what was just built. */
const EDITS_PAIRS: ReadonlySet<GeorefAction['type']> = new Set(['planTap', 'mapTap', 'dragPlan', 'dragMap', 'remove', 'clear', 'select'])

export function georefDispatch(a: GeorefAction) {
  const prev = state
  const next = georefReduce(prev, a)
  if (next === prev) return
  state = next
  if (prev.storageKey && EDITS_PAIRS.has(a.type) && next.pairs !== prev.pairs) { rev++; queueSave(prev.storageKey, next.pairs) }
  if (a.type === 'end' || a.type === 'dismiss') void flushSave() // never leave a debounced write in the air
  listeners.forEach((l) => l())
}

export function georefSnapshot(): GeorefModeState { return state }

/** A phone places a new reference at one fixed screen target. The surface underneath owns the
 *  coordinate conversion (Plan pixels → normalized sheet point, MapLibre pixels → WGS84),
 *  while the app-level mode card owns the explicit «Punkt setzen» action. Keeping only the
 *  resolver here avoids streaming every pan frame through the persisted mode store. */
type PhoneTargetResolver = () => PlanPt | GeoPt | null
const phoneTargetResolvers: Partial<Record<GeorefSide, PhoneTargetResolver>> = {}

export function registerGeorefPhoneTarget(side: GeorefSide, resolve: PhoneTargetResolver): () => void {
  phoneTargetResolvers[side] = resolve
  return () => {
    if (phoneTargetResolvers[side] === resolve) delete phoneTargetResolvers[side]
  }
}

/** WHERE the fixed target currently is, in the surface's own coordinates — without placing
 *  anything. The loupe reads this so the magnified crop is the reticle's surroundings and not
 *  the map's centre: on a phone those are two different places, and the whole point of the inset
 *  is to show what is under the mark somebody is about to commit. Null while the target sits off
 *  the sheet or the surface has not mounted. */
export function peekGeorefPhoneTarget(side: GeorefSide): PlanPt | GeoPt | null {
  return phoneTargetResolvers[side]?.() ?? null
}

/** Commit the fixed target on the visible phone surface. False means the target is currently
 *  outside the sheet / the surface has not mounted yet, so no invisible point is invented. */
export function placeGeorefPhoneTarget(side: GeorefSide): boolean {
  const target = phoneTargetResolvers[side]?.()
  if (!target) return false
  // an open popover consumes the next surface tap as its dismissal — the explicit button must
  // still PLACE on the first press, so the selection is put away beforehand
  if (state.sel && !state.move) georefDispatch({ type: 'unpick' })
  if (side === 'plan') georefDispatch({ type: 'planTap', pt: target as PlanPt })
  else georefDispatch({ type: 'mapTap', lngLat: target as GeoPt })
  return true
}

export interface GeorefTargetRect { left: number; top: number; right: number; bottom: number }

/** Centre of the actually usable phone canvas: below the TopBar, above the variable-height mode
 *  card, with a quiet inset from every viewport edge. Both the painted reticle and each surface's
 *  coordinate resolver call this same function, so the plus button cannot land beside the mark. */
export function georefPhoneTargetPoint(
  surface: GeorefTargetRect,
  blockers: { top?: number; bottom?: number } = {},
  padding = 18,
): { x: number; y: number } | null {
  const left = surface.left + padding
  const right = surface.right - padding
  const top = Math.max(surface.top + padding, (blockers.top ?? surface.top) + padding)
  const bottom = Math.min(surface.bottom - padding, (blockers.bottom ?? surface.bottom) - padding)
  if (right <= left || bottom <= top) return null
  return { x: (left + right) / 2, y: (top + bottom) / 2 }
}

function revSnapshot(): number { return rev }

/** Subscribe a surface to STORED georeferences: it re-renders whenever any plan's saved pairs
 *  change. Returns nothing on purpose — the counter is a version stamp, not a value anybody
 *  should read. Pair it with the synchronous `georefForPlan`, which has nothing else to notify
 *  React with. */
export function useGeorefStorage(): void {
  useSyncExternalStore(subscribe, revSnapshot, revSnapshot)
}

/** «Referenz zurücksetzen»: drop the mode AND the stored pairs of that ONE sheet. Empty pairs
 *  delete the entry outright (see stationPlanScale · saveGeoref), so «has a georeference» stays
 *  one question with one answer. ⚠️ `georefKey`, not a `planId` — a `planId` is the reusable
 *  Modul slot every Einsatzobjekt shares, so resetting on one would clear another building's
 *  reference (types.ts · PlanDocument.georefKey).
 *
 *  ⚠️ The pending write is settled FIRST. `dismiss` flushes the debounced save, and that flush
 *  is a PUT of the pairs into the very document the empty one below replaces — two overlapping
 *  writes to an endpoint that serializes nothing. When the pair write landed second the server
 *  kept the pairs while the app showed none, and the reset came back at the next boot. */
export function resetGeorefPlan(georefKey: string) {
  const settled = settleSave(georefKey)
  georefDispatch({ type: 'dismiss' }) // its own flush now finds nothing left in the air
  rev++
  settled.then(() => saveGeoref(georefKey, { pairs: [] })).catch(() => onSaveError?.())
  listeners.forEach((l) => l())
}

/** Copy one concrete module sheet's reference onto another.
 *
 *  Both arguments are `georefKey`s, not `planId`s: the whole point is to move a reference
 *  between two sheets of the SAME Einsatzobjekt, and a `planId` names the Modul slot every
 *  object shares (types.ts · PlanDocument.georefKey).
 *
 *  The nested points are cloned deliberately: after the transfer both modules own an
 *  independent reference, so fine-tuning one can never move the other through shared object
 *  identities. The caller handles the explicit replace confirmation when `targetKey`
 *  already carries pairs; this function is the small storage transaction underneath it. */
export async function transferGeorefPlan(sourceKey: string, targetKey: string): Promise<boolean> {
  const source = georefForPlan(sourceKey)
  if (!source?.pairs.length || sourceKey === targetKey) return false
  const pairs = source.pairs.map((p) => ({
    ...p,
    plan: { ...p.plan },
    lngLat: { ...p.lngLat },
  }))
  await saveGeoref(targetKey, { pairs })
  rev++
  listeners.forEach((l) => l())
  return true
}

/** Test seam — drops the mode and any pending write without touching the network. */
export function resetGeorefMode() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  savePending = null
  delete phoneTargetResolvers.plan
  delete phoneTargetResolvers.map
  state = GEOREF_OFF
  listeners.forEach((l) => l())
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }

/** The live mode, for any surface that has to draw part of it. */
export function useGeorefMode(): GeorefModeState {
  return useSyncExternalStore(subscribe, georefSnapshot, georefSnapshot)
}

/** Arm the mode on a plan, seeded with whatever that plan already carries.
 *  `aspect` is the sheet's measured width/height — the surface that HAS measured the bitmap
 *  hands it over, because the map half solves the same fit and cannot measure anything.
 *  `check` arms it straight into «Deckung prüfen»: the split comes up with the sheet's outline
 *  already on the map, which is what the Passung's own check button wants. */
export function startGeorefMode(planId: string, aspect: number, opts?: { storageKey?: string; check?: boolean; returnToQuality?: boolean; previewUrl?: string | null }) {
  const storageKey = opts?.storageKey ?? planId
  georefDispatch({ type: 'start', planId, storageKey, pairs: georefForPlan(storageKey)?.pairs ?? [], aspect, check: opts?.check, returnToQuality: opts?.returnToQuality, previewUrl: opts?.previewUrl })
}

/**
 * The phone's surface hop, wired in ONE place (IncidentWorkspace owns `mode`).
 *
 * On a phone there is no room for the two-pane split, so the app follows the explicit surface
 * switch in the mode card. Placement itself never navigates: somebody may mark three points on
 * the Karte, switch once, then mark the same three on the Modul — or do the exact reverse. On
 * anything wider both halves are on screen at once and `want` only drives the shared prompt and
 * loupe.
 */
export function useGeorefSurfaceBridge(go: (surface: 'map' | 'plans') => void) {
  const isPhone = useIsPhone()
  const { planId, want, check } = useGeorefMode()
  const goRef = useRef(go)
  useEffect(() => { goRef.current = go })
  useEffect(() => {
    if (!isPhone || !planId) return
    // Coverage is painted by the one live MapLibre surface, so it always owns the phone screen.
    // The plan snapshot is already the raster laid over it; keeping the PDF surface mounted here
    // hid both pictures and made «Deckung prüfen» look broken on phones.
    goRef.current(check || want === 'map' ? 'map' : 'plans')
  }, [isPhone, planId, want, check])
}

/** May a map tap place or re-place right now? The map side asks this to decide whether a click
 *  is a placement or a mis-timed tap, and whether to raise the crosshair + loupe. Free order
 *  means the answer is «whenever the mode is armed» — with one exception: */
export function georefWantsMap(s: GeorefModeState): boolean {
  // Coverage is inspection, never placement. Without this guard a still tap used to append a
  // fresh map half, which immediately dismissed «Deckung prüfen» and dropped the operator back
  // into the point setter. Pan/zoom remain MapLibre's ordinary gestures while the check is up.
  return !!s.planId && !s.check
}

/** Esc follows the visible exit action everywhere — including on the Karte surface, where the
 *  plan's own Escape handler is not even mounted. Coverage is a sub-mode, so Esc leaves it via
 *  the same return path as its «Fertig» rather than abandoning the parent alignment/Passung. */
export function useGeorefEscape(active: boolean, checking = false, picked = false) {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const el = e.target instanceof HTMLElement ? e.target : null
      // typing in a field, or a modal on top of the board — Escape belongs to those first
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (el?.closest('[role="dialog"], [role="alertdialog"]')) return
      e.stopPropagation()
      // Escape peels ONE layer at a time: an armed «Verschieben» or an open popover first
      // (`unpick` — the cross goes back down untouched), then coverage, then the mode. Esc is
      // never the ONLY exit: «Behalten» in the popover and the visible bar buttons do the same.
      georefDispatch({ type: picked ? 'unpick' : checking ? 'finishCheck' : 'end' })
    }
    // capture, so the mode backs out before the board's own Escape drops a selection
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, checking, picked])
}
