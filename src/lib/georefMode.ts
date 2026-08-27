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
 *  ## The machine
 *
 *  Three flags carry the whole mode:
 *    `planId`  — set ⇒ the mode is armed on that plan. null ⇒ off.
 *    `queue`   — plan points waiting for their map counterpart, OLDEST FIRST.
 *    `edit`    — one half of an EXISTING pair was picked up and is being re-placed. Replaces,
 *                never appends (see georef · replacePair).
 *  `want` says which surface has to be in front of the operator; the phone follows it, the
 *  tablet/desktop split ignores it because both halves are already visible.
 *
 *  ## Why a QUEUE and not one open half
 *
 *  ⚠️ Until 26.08. the mode enforced strict alternation: one plan point, then its map point,
 *  then the next. On a phone that is a surface hop per HALF pair — plan, map, plan, map — and
 *  the operator is thrown off the sheet mid-thought every time. The natural way to work is to
 *  walk the plan and mark the corners you recognise (1, 2, 3 …), then go to the map once and
 *  match them in the same order. So plan taps QUEUE, and a map tap always completes the OLDEST
 *  open point — which makes strict alternation a special case of the queue (one in, one out)
 *  rather than a rule, and it still feels exactly as it did.
 *
 *  A queued point is not a pair and never persists: «Abbrechen» drops the open ones and keeps
 *  every pair that is complete.
 *
 *  The mode stays armed after a completed pair on purpose — the third point is what turns
 *  «aus 2 Punkten» into a measured residual, and it has to be cheap to add.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { BASELINE_WARN_M, replacePair, residualClaim, samePlanPt, type GeoPt, type GeorefFit, type GeorefPair, type PlanPt } from './georef'
import { georefForPlan, saveGeoref } from './stationPlanScale'
import { useIsPhone } from './useIsPhone'

/** Which surface the mode is waiting on. */
export type GeorefSide = 'plan' | 'map'

export interface GeorefModeState {
  /** the plan being georeferenced — null means the mode is off */
  planId: string | null
  /** station-storage key for this concrete object's sheet. `planId` is only the reusable
   *  Modul slot; keeping both prevents Modul 2 of object A from overwriting Modul 2 of object B. */
  storageKey: string | null
  /** the pairs as they stand this instant: every cross, the live fit and the chip read from here */
  pairs: GeorefPair[]
  /** plan points still waiting for their map counterpart, OLDEST FIRST — the next map tap
   *  completes `queue[0]`. Discarded on cancel: half a pair is not a pair. */
  queue: PlanPt[]
  /** Map points placed before their plan counterparts, oldest first. Exactly one pending queue
   *  is populated: a tap on the opposite surface completes the oldest numbered half. */
  mapQueue: GeoPt[]
  /** a cross was tapped: exactly THIS half is being re-placed. `pending` distinguishes an
   *  unmatched half from a completed pair without changing the long-standing pair edit shape. */
  edit: { idx: number; side: GeorefSide; pending?: true } | null
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

export const GEOREF_OFF: GeorefModeState = { planId: null, storageKey: null, pairs: [], queue: [], mapQueue: [], edit: null, want: 'plan', aspect: 1, check: false, checkReturn: null, returnToQuality: false, checkOpacity: 0.58, previewUrl: null }

export type GeorefAction =
  | { type: 'start'; planId: string; storageKey?: string; pairs: GeorefPair[]; aspect: number; check?: boolean; returnToQuality?: boolean; previewUrl?: string | null }
  /** «Fertig» / Esc / «Abbrechen» — every point still waiting for its map half is dropped */
  | { type: 'end' }
  /** Hard teardown after a parent return has been restored, or when its document disappeared. */
  | { type: 'dismiss' }
  /** «Auf der Karte zuordnen» — the phone's explicit hop to the map, once points are queued.
   *  ⚠️ The ONLY way there now: a hop per plan tap is what made the mode unusable one-handed. */
  | { type: 'goMap' }
  | { type: 'goPlan' }
  | { type: 'planTap'; pt: PlanPt }
  | { type: 'mapTap'; lngLat: GeoPt }
  /** a cross was tapped (not dragged): pick up that ONE half to re-place it */
  | { type: 'pick'; idx: number; side: GeorefSide }
  /** an unmatched cross was tapped: make that otherwise ephemeral half correctable/removable */
  | { type: 'pickPending'; idx: number; side: GeorefSide }
  /** «Punkt löschen» on a picked-up cross: drop that PAIR and refit from what is left */
  | { type: 'removePair'; idx: number }
  /** «Punkt löschen» on a picked-up unmatched half */
  | { type: 'removePending'; idx: number; side: GeorefSide }
  /** «Punkte zurücksetzen» in the armed bar: drop every pair but STAY armed */
  | { type: 'clear' }
  /** Esc / «Abbrechen» on a picked-up cross: PUT IT BACK DOWN, unchanged.
   *  ⚠️ The only way out of `edit` that neither moves the point nor deletes it. Without it a
   *  mis-tapped cross pins the operator to that one surface — `goMap`/`goPlan` both refuse while
   *  `edit` is set, so on a phone the opposite-surface button is dead until the point is placed
   *  somewhere or thrown away. */
  | { type: 'unpick' }
  /** «Deckung prüfen» on / off — the sheet's outline on the map, for as long as nobody edits */
  | { type: 'check'; on: boolean; previewUrl?: string | null }
  /** Leave coverage without confusing it with «Fertig» for the alignment itself. */
  | { type: 'finishCheck' }
  | { type: 'checkOpacity'; opacity: number }
  /** live drag of an existing cross — refits on every frame, so it is its own action */
  | { type: 'dragPlan'; idx: number; pt: PlanPt }
  | { type: 'dragMap'; idx: number; lngLat: GeoPt }

/**
 * The whole mode as one pure function — armed / half-pair / complete / cancel / replace.
 *
 * Returns the SAME object when an action changes nothing, so a caller can compare by reference
 * (the store does, to decide whether to notify and whether to persist).
 */
/** The actions that move NOTHING the outline is drawn from: the check's own controls, arming
 *  (the Passung's check button arms the mode WITH the look already on), a surface hop, and
 *  putting a picked-up cross back down.
 *  ⚠️ Typed against `GeorefAction['type']` rather than a bare `string[]`: an untyped list stops
 *  matching the moment an action is renamed, and it does so SILENTLY — «Deckung prüfen» would
 *  simply start closing itself on every hop between the sheet and the Karte, with nothing to
 *  point at. Its sibling `EDITS_PAIRS` is typed for the same reason. */
const KEEPS_CHECK: ReadonlySet<GeorefAction['type']> = new Set(['check', 'checkOpacity', 'finishCheck', 'start', 'goMap', 'goPlan', 'unpick'])

export function georefReduce(s: GeorefModeState, a: GeorefAction): GeorefModeState {
  const next = fold(s, a)
  // ⚠️ «Deckung prüfen» is a LOOK, not a layer: the moment anything moves — a point placed, a
  // cross corrected, a pair dropped — the outline is out of date, so it goes. One rule here
  // instead of one `check: false` in every branch that could forget it.
  return next !== s && !KEEPS_CHECK.has(a.type) && next.check
    ? { ...next, check: false, checkReturn: null }
    : next
}

function fold(s: GeorefModeState, a: GeorefAction): GeorefModeState {
  switch (a.type) {
    case 'start':
      return { planId: a.planId, storageKey: a.storageKey ?? a.planId, pairs: a.pairs, queue: [], mapQueue: [], edit: null, want: 'plan', aspect: a.aspect, check: !!a.check, checkReturn: a.check ? 'quality' : null, returnToQuality: !!a.returnToQuality, checkOpacity: s.checkOpacity, previewUrl: a.previewUrl ?? null }
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
          ? { ...s, queue: [], mapQueue: [], edit: null, want: 'plan', check: false, checkReturn: 'quality' }
          : GEOREF_OFF
        : s
    case 'dismiss':
      return s.planId ? GEOREF_OFF : s
    case 'goMap':
      // ⚠️ Not while a cross is picked up: that correction has a surface of its own (`edit.side`),
      // and sending the phone to the map with a PLAN half outstanding leaves the operator on a
      // map whose every tap is ignored, reading an instruction about the sheet they just left.
      // Nothing queued ⇒ nothing to match either, except during «Deckung prüfen»: there the map
      // itself is the job and the phone must be able to show the overlay.
      return s.planId && !s.edit && s.want !== 'map' ? { ...s, want: 'map' } : s
    case 'goPlan':
      // On the split layout the pointer may cross back to the plan while several plan halves
      // are still queued. Follow the surface being aimed at; a picked MAP half remains map-only.
      return s.planId && !s.edit && s.want !== 'plan' ? { ...s, want: 'plan' } : s
    case 'planTap': {
      if (!s.planId) return s
      const edit = s.edit
      // re-placing the plan half of an existing pair: correct it and stay where the finger is
      if (edit?.side === 'plan' && edit.pending) {
        const queue = s.queue.map((pt, i) => (i === edit.idx ? a.pt : pt))
        return { ...s, queue, edit: null, want: 'plan' }
      }
      if (edit?.side === 'plan') {
        const pairs = s.pairs.map((p, i) => (i === edit.idx ? { ...p, plan: a.pt, kind: 'korrigiert' as const } : p))
        return { ...s, pairs, edit: null, want: 'plan' }
      }
      if (edit) return s // the MAP half is the one being waited on — the plan is inert
      const [mapOpen, ...mapRest] = s.mapQueue
      if (mapOpen) {
        return {
          ...s,
          // ⚠️ `replacePair`, exactly like the mirror branch in `mapTap`. Mark the map first,
          // then tap a landmark on the sheet that ALREADY carries a pair, and a bare append
          // would leave two pairs on one plan point holding different positions — the
          // self-contradiction replacePair exists to make impossible, dragging the least-squares
          // fit towards whichever of the two taps was worse.
          pairs: replacePair(s.pairs, { plan: a.pt, lngLat: mapOpen, kind: 'gesetzt' }),
          mapQueue: mapRest,
          want: 'plan',
        }
      }
      // ⚠️ QUEUES, never replaces. Marking three corners in a row and matching them afterwards
      // is the whole point (see the header); `want` deliberately stays on the plan, so a phone
      // is not thrown onto the map after every single tap.
      return { ...s, queue: [...s.queue, a.pt], want: 'plan' }
    }
    case 'mapTap': {
      if (!s.planId) return s
      const edit = s.edit
      if (edit?.side === 'map' && edit.pending) {
        const mapQueue = s.mapQueue.map((pt, i) => (i === edit.idx ? a.lngLat : pt))
        return { ...s, mapQueue, edit: null, want: 'map' }
      }
      if (edit?.side === 'map') {
        const pairs = s.pairs.map((p, i) => (i === edit.idx ? { ...p, lngLat: a.lngLat, kind: 'korrigiert' as const } : p))
        return { ...s, pairs, edit: null, want: 'map' }
      }
      if (edit) return s
      const [open, ...rest] = s.queue
      if (!open) return { ...s, mapQueue: [...s.mapQueue, a.lngLat], want: 'map' }
      return {
        ...s,
        pairs: replacePair(s.pairs, { plan: open, lngLat: a.lngLat, kind: 'gesetzt' }),
        queue: rest,
        // stay on the map while points are still open — that is what «zuordnen» is; the phone
        // goes back to the sheet by itself once the last one is matched
        want: rest.length ? 'map' : 'plan',
      }
    }
    case 'pick': {
      if (!s.planId || !s.pairs[a.idx]) return s
      // ⚠️ The queue SURVIVES: those points are work the operator did, and re-placing one cross
      // is not a reason to throw it away. Only `edit` is exclusive — one correction at a time.
      return { ...s, edit: { idx: a.idx, side: a.side }, want: a.side }
    }
    case 'pickPending': {
      const pending = a.side === 'plan' ? s.queue[a.idx] : s.mapQueue[a.idx]
      if (!s.planId || !pending) return s
      return { ...s, edit: { idx: a.idx, side: a.side, pending: true }, want: a.side }
    }
    case 'unpick':
      // ⚠️ `want` deliberately stays where it is: the operator is looking at this surface, and
      // yanking them to the other one is precisely what the picked-up cross was doing to them.
      // Nothing else changes — a cross put back down is a cross that was never touched.
      return s.planId && s.edit ? { ...s, edit: null } : s
    case 'removePair': {
      // A pair the operator can see is wrong has to be REMOVABLE, not only re-placeable: the
      // landmark itself can turn out to be the mistake («that is not the same corner»), and
      // re-placing it somewhere else only moves the error. Dropping it refits from the rest —
      // below two pairs there is no fit at all, which is the honest state and exactly what the
      // chip then says (fitSimilarity returns null, the twins disappear).
      if (!s.planId || !s.pairs[a.idx]) return s
      return { ...s, pairs: s.pairs.filter((_, i) => i !== a.idx), edit: null }
    }
    case 'removePending': {
      const pending = a.side === 'plan' ? s.queue[a.idx] : s.mapQueue[a.idx]
      if (!s.planId || !pending) return s
      return a.side === 'plan'
        ? { ...s, queue: s.queue.filter((_, i) => i !== a.idx), edit: null, want: 'plan' }
        : { ...s, mapQueue: s.mapQueue.filter((_, i) => i !== a.idx), edit: null, want: 'map' }
    }
    case 'clear': {
      // ⚠️ STAYS armed. «Punkte zurücksetzen» is «start over», not «leave» — the next thing
      // that happens is always a fresh first point. «Abbrechen» beside it is the one that keeps
      // what already stands.
      if (!s.planId || (!s.pairs.length && !s.queue.length && !s.mapQueue.length && !s.edit)) return s
      // the same empty array back when there was nothing to clear — the store persists on a
      // CHANGED `pairs` identity, and a write that deletes an entry that never existed is noise
      return { ...s, pairs: s.pairs.length ? [] : s.pairs, queue: [], mapQueue: [], edit: null, want: 'plan' }
    }
    case 'dragPlan': {
      const cur = s.pairs[a.idx]; if (!cur) return s
      // ⚠️ Never ONTO another cross. Two plan points closer than PAIR_EPS_N are the same landmark
      // (georef · samePlanPt), and references without plan-side spread have no fit at all — so
      // the whole sheet would come unstuck the moment a dragged finger passed over a neighbour.
      // Refusing the move leaves the cross where the operator last saw it, which is the only
      // outcome here they can act on.
      if (s.pairs.some((p, i) => i !== a.idx && samePlanPt(p.plan, a.pt))) return s
      return { ...s, pairs: s.pairs.map((p, i) => (i === a.idx ? { ...p, plan: a.pt, kind: 'korrigiert' as const } : p)) }
    }
    case 'dragMap': {
      const cur = s.pairs[a.idx]; if (!cur) return s
      return { ...s, pairs: s.pairs.map((p, i) => (i === a.idx ? { ...p, lngLat: a.lngLat, kind: 'korrigiert' as const } : p)) }
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
export const GEOREF_TAP_SLOP_PX = 10

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
 * same discrimination — and the same 10px — as the plan half. Panning, pinching and inertia are
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

/** Is one specific point being re-placed? While it is, EVERY cross goes inert on both surfaces —
 *  the tap that is meant to land that point must not be swallowed by whichever cross happens to
 *  sit under it. ⚠️ Queued points do NOT make the plan inert: on the sheet the operator is free
 *  to keep marking corners, to fine-tune a cross or to pick one up, all in the same breath. */
export function georefPlacing(s: GeorefModeState): boolean {
  return !!s.planId && !!s.edit
}

/** The MAP's paired crosses stay draggable while unmatched points are queued. An intentional
 *  press on an existing landmark is a correction, and making it inert forced phone users to
 *  delete and recreate the pair. Only an actively picked-up half makes every cross inert: its
 *  landing tap must belong to the map beneath it. A queued point cannot validly be placed on an
 *  existing cross anyway (`replacePair` would replace that landmark), so the cross may own its
 *  own hit target without creating two references at one place. */
export function georefMatching(s: GeorefModeState): boolean {
  return !!s.planId && !!s.edit
}

/**
 * 1-based number of the point the current step is about — the cross's badge and the prompt.
 *
 * On the plan that is the point about to be QUEUED (behind every pair and every open point); on
 * the map it is the OLDEST open one, because that is the one a tap over there completes.
 */
export function georefPointNo(s: GeorefModeState): number {
  if (s.edit) return s.edit.pending ? s.pairs.length + s.edit.idx + 1 : s.edit.idx + 1
  if (s.want === 'map') return s.pairs.length + (s.queue.length ? 1 : s.mapQueue.length + 1)
  return s.pairs.length + (s.mapQueue.length ? 1 : s.queue.length + 1)
}

/** The number a queued point carries on the sheet: pairs first, then the queue in order. */
export function georefQueueNo(s: GeorefModeState, i: number): number {
  return s.pairs.length + i + 1
}

export function georefMapQueueNo(s: GeorefModeState, i: number): number {
  return s.pairs.length + i + 1
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

// --- the store ------------------------------------------------------------------------------

let state: GeorefModeState = GEOREF_OFF
const listeners = new Set<() => void>()
// Bumped whenever a plan's STORED georeference changes. `georefForPlan` is a synchronous read of
// a module singleton, so a surface that shows the saved reference has nothing to re-render on —
// this counter is that something. Deliberately not part of the machine's state: it is a fact
// about storage, not about the mode.
let rev = 0

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

/** The actions that genuinely EDIT the reference. ⚠️ Everything else is deliberately excluded,
 *  and `end` above all: leaving the mode moves the pairs from the live list to the empty one, so
 *  a naive «pairs changed ⇒ save» would have written an EMPTY georeference every time somebody
 *  pressed «Fertig» — the one button whose whole job is to keep what was just built. */
const EDITS_PAIRS: ReadonlySet<GeorefAction['type']> = new Set(['planTap', 'mapTap', 'dragPlan', 'dragMap', 'removePair', 'clear'])

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
 * On a phone there is no room for the two-pane split, so the app follows the mode: tap on the
 * plan → the Karte comes up for the map half → back to the plan for the next point. Nobody goes
 * looking for the other surface. On anything wider both halves are on screen at once and `want`
 * is deliberately ignored.
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

/** Is the MAP the surface being waited on right now? The map side asks this to decide whether a
 *  click is a placement or a mis-timed tap, and whether to raise the crosshair + loupe. */
export function georefWantsMap(s: GeorefModeState): boolean {
  // Coverage is inspection, never placement. Without this guard a still tap used to append a
  // fresh map half, which immediately dismissed «Deckung prüfen» and dropped the operator back
  // into the point setter. Pan/zoom remain MapLibre's ordinary gestures while the check is up.
  return !!s.planId && !s.check && (s.edit ? s.edit.side === 'map' : true)
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
      // Escape peels ONE layer at a time, and a picked-up cross is the innermost one. Without
      // this rung there was no non-destructive way to put a cross back down: `planTap`/`mapTap`
      // move it, `removePair` deletes it, and `goMap`/`goPlan` refuse outright while `edit` is
      // set — so a mis-tap on a phone pinned the operator to that surface with the other one's
      // button greyed out, and «raus hier» meant abandoning the whole mode.
      georefDispatch({ type: picked ? 'unpick' : checking ? 'finishCheck' : 'end' })
    }
    // capture, so the mode backs out before the board's own Escape drops a selection
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, checking, picked])
}
