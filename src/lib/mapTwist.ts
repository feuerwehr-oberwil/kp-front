// The Karte turns the way Google Maps turns, and in no other way (24.09.2026, the user's words:
// «Just how apps like Google Maps behave and nothing else»).
//
// ⚠️ Field symptom 23.09.2026 (iPad, Feueralarm post-mortem «Symptom 3»): «the background turned
// and moved when just scrolling». MapLibre's two-finger rotate engages after 25 px of travel
// along the circle the fingers span — with the fingers a hand apart on a tablet that is ~5° of
// twist, which the wrist rolls into any two-finger pan or pinch — and it turned basemap and plan
// overlay together. The old 6° north-snap on release only healed the drifts that ended within
// 6°; everything past it stayed turned.
//
// Now: a two-finger gesture pans and zooms at once, as before, but it only TURNS after a
// deliberate twist past `TWIST_ENGAGE_DEG` measured from where the two fingers came down. Once
// engaged, the bearing follows the fingers exactly for the rest of that gesture (zoom and pan
// keep running alongside), with no jump by the threshold it took to get there. Lifting a finger
// ends it; the next two-finger gesture starts un-engaged again. Nothing snaps back afterwards —
// a deliberate turn is deliberate, and «Nach Norden» (the compass) is the way back.
//
// Pure gate + the one bridge into MapLibre's own rotate handler. Mouse right-drag rotation and
// the keyboard are MapLibre's own handlers and are untouched.

/**
 * Degrees of twist, from where the two fingers came down, before the map starts to turn.
 *
 * 12° sits in the 10–15° band where the big map apps engage rotation. Below ~10° the roll a
 * wrist puts into an ordinary two-finger pan or pinch crosses it (the field case); above ~15° a
 * deliberate twist feels stuck before it answers. It is measured as the NET twist since touch-down,
 * so noise that wobbles back and forth never adds up to it.
 */
export const TWIST_ENGAGE_DEG = 12

/**
 * …and the fingers must also have travelled this far ALONG the circle they span (px) — the
 * same kind of guard MapLibre's own handler has (it uses 25 px alone). It only bites when the
 * fingers are close together: a gloved fingertip's contact centroid wanders several pixels, and
 * at 50 px apart that wander alone reads as 15–20° of «twist». Two fingers a hand apart reach it
 * well before 12°, so there the degree threshold is the one that decides.
 */
export const TWIST_ENGAGE_ARC_PX = 20

export interface TwistPoint { x: number; y: number }

/** The signed angle from `prev` to `next` in degrees, in MapLibre's convention
 *  (`two_fingers_touch · getBearingDelta` = `next.angleWith(prev)`) — i.e. exactly what a
 *  rotate handler's `bearingDelta` means. Always in (−180, 180], so a gesture that crosses the
 *  ±180° seam between two frames is a small step, never a whole turn. */
export const twistDelta = (next: TwistPoint, prev: TwistPoint): number =>
  (Math.atan2(next.x * prev.y - next.y * prev.x, next.x * prev.x + next.y * prev.y) * 180) / Math.PI

export interface TwistGate {
  /** the first two fingers came down at `a` and `b` */
  start(a: TwistPoint, b: TwistPoint): void
  /** one frame of the two fingers: the bearing delta to apply this frame, or `null` while the
   *  twist has not engaged (then the gesture must not turn the map at all). The frame that
   *  engages returns 0 — the map turns from HERE, it does not jump by the threshold. */
  move(a: TwistPoint, b: TwistPoint): number | null
  /** a finger lifted / the gesture was cancelled */
  end(): void
  readonly engaged: boolean
}

export function createTwistGate(): TwistGate {
  let last: TwistPoint | null = null
  /** net twist since touch-down, unwrapped (a sum of per-frame steps, so it can pass ±180°) */
  let twist = 0
  let engaged = false
  return {
    start(a, b) { last = { x: a.x - b.x, y: a.y - b.y }; twist = 0; engaged = false },
    move(a, b) {
      if (!last) return null
      const v = { x: a.x - b.x, y: a.y - b.y }
      const step = twistDelta(v, last)
      last = v
      twist += step
      if (engaged) return step
      const dist = Math.hypot(v.x, v.y)
      const arc = (Math.abs(twist) * Math.PI / 180) * (dist / 2)
      if (Math.abs(twist) < TWIST_ENGAGE_DEG || arc < TWIST_ENGAGE_ARC_PX) return null
      engaged = true
      return 0
    },
    end() { last = null; twist = 0; engaged = false },
    get engaged() { return engaged },
  }
}

/** The slice of MapLibre's `TwoFingersTouchRotateHandler` (v4.7) the gate replaces. */
interface RotateHandlerInternals {
  _start: (points: [TwistPoint, TwistPoint]) => void
  _move: (points: [TwistPoint, TwistPoint], pinchAround: unknown, e?: unknown) => { bearingDelta: number; pinchAround: unknown } | void
  reset: () => void
  _active?: boolean
  __twistGate?: TwistGate
}

/**
 * Puts the gate in front of a MapLibre two-finger rotate handler instance: its `_start` / `_move`
 * / `reset` are replaced so the handler reports rotation only once the twist engaged, and reports
 * itself ACTIVE only from then on — before that the handler manager sees no rotation at all, so
 * the built-in pan and zoom run exactly as they did. `pinchAround` is passed through, so the map
 * turns about the point between the fingers. Returns false when the instance does not have the
 * shape this was written against (a MapLibre upgrade renamed its internals).
 */
export function installTwistGate(handler: unknown): boolean {
  const h = handler as Partial<RotateHandlerInternals> | null | undefined
  if (!h || typeof h._start !== 'function' || typeof h._move !== 'function' || typeof h.reset !== 'function') return false
  if (h.__twistGate) return true
  const gate = createTwistGate()
  const baseReset = h.reset.bind(h)
  h.__twistGate = gate
  h.reset = () => { baseReset(); gate.end() }
  h._start = (points) => gate.start(points[0], points[1])
  h._move = (points, pinchAround) => {
    const bearingDelta = gate.move(points[0], points[1])
    if (bearingDelta == null) return
    h._active = true
    return { bearingDelta, pinchAround }
  }
  return true
}

/**
 * The Karte's two-finger rotation, gated. ⚠️ Fail-closed: if the handler's internals are not
 * where MapLibre 4.7 keeps them, touch rotation is switched OFF rather than left un-gated —
 * a map that cannot be twisted is a lesser harm than one that turns under every pan.
 * (`mapTwist.test.ts` pins the shape against the installed MapLibre, so an upgrade fails there
 * first.)
 */
export function gateTouchRotation(map: { touchZoomRotate: { disableRotation: () => void } }): void {
  const tzr = map.touchZoomRotate as unknown as { _touchRotate?: unknown }
  if (!installTwistGate(tzr._touchRotate)) map.touchZoomRotate.disableRotation()
}
