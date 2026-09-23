// @vitest-environment jsdom
// (jsdom only for the last block, which drives the INSTALLED MapLibre's own rotate handler;
// everything above it is pure)
import { describe, expect, it, vi } from 'vitest'
import { Point, TwoFingersTouchRotateHandler } from 'maplibre-gl'
import {
  TWIST_ENGAGE_ARC_PX,
  TWIST_ENGAGE_DEG,
  createTwistGate,
  gateTouchRotation,
  installTwistGate,
  twistDelta,
  type TwistPoint,
} from './mapTwist'

const RAD = Math.PI / 180

/** the two fingers of a gesture whose midpoint is (cx, cy), `dist` px apart, the line from the
 *  second finger to the first at `deg` degrees (screen frame, y down) */
const fingers = (cx: number, cy: number, dist: number, deg: number): [TwistPoint, TwistPoint] => {
  const dx = (Math.cos(deg * RAD) * dist) / 2
  const dy = (Math.sin(deg * RAD) * dist) / 2
  return [{ x: cx + dx, y: cy + dy }, { x: cx - dx, y: cy - dy }]
}

/** Replays a gesture through a fresh gate and returns what the MAP would do: the bearing it
 *  ends on (the sum of every delta the gate handed out, from 0), plus per-frame detail. */
const replay = (frames: Array<[TwistPoint, TwistPoint]>) => {
  const gate = createTwistGate()
  gate.start(...frames[0])
  let bearing = 0
  let engagedAt = -1
  const deltas: Array<number | null> = []
  for (let i = 1; i < frames.length; i++) {
    const d = gate.move(...frames[i])
    deltas.push(d)
    if (d != null) {
      if (engagedAt < 0) engagedAt = i
      bearing += d
    }
  }
  return { bearing, engagedAt, deltas, gate }
}

/** deterministic PRNG (mulberry32) — a soak that fails must fail the same way twice */
const rng = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

describe('twistDelta — MapLibre\'s bearingDelta convention', () => {
  it('is the negative of the on-screen angle the finger line turned through', () => {
    // v = (cos θ, sin θ): delta(next, prev) = θprev − θnext — a clockwise twist (y down) lowers
    // the bearing, which turns the map content clockwise WITH the fingers
    expect(twistDelta({ x: 0, y: 1 }, { x: 1, y: 0 })).toBeCloseTo(-90, 12)
    expect(twistDelta({ x: 1, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90, 12)
  })
  it('matches MapLibre\'s own Point.angleWith', () => {
    const a = new Point(3, -7)
    const b = new Point(-2, 5)
    expect(twistDelta(a, b)).toBeCloseTo((a.angleWith(b) * 180) / Math.PI, 12)
  })
  it('wraps: crossing the ±180° seam is a small step, not a whole turn', () => {
    const at = (deg: number) => ({ x: Math.cos(deg * RAD), y: Math.sin(deg * RAD) })
    expect(twistDelta(at(-170), at(170))).toBeCloseTo(-20, 9)
    expect(twistDelta(at(170), at(-170))).toBeCloseTo(20, 9)
  })
})

describe('createTwistGate — rotation only after a deliberate twist', () => {
  it('a pinch with ±8° of twist noise never engages', () => {
    const frames: Array<[TwistPoint, TwistPoint]> = []
    for (let i = 0; i <= 120; i++) {
      const dist = 180 + i * 3 // spreading: a zoom-in
      frames.push(fingers(400, 300, dist, 30 + 8 * Math.sin(i / 4)))
    }
    const r = replay(frames)
    expect(r.engagedAt).toBe(-1)
    expect(r.deltas.every((d) => d === null)).toBe(true)
    expect(r.bearing).toBe(0)
  })

  it('a pinch that started as a zoom does not turn on noise later in the same gesture', () => {
    const frames: Array<[TwistPoint, TwistPoint]> = []
    for (let i = 0; i <= 60; i++) frames.push(fingers(400, 300, 400 - i * 4, 0)) // pure pinch-in
    for (let i = 0; i <= 60; i++) frames.push(fingers(400, 300, 160, (i % 2 ? 1 : -1) * 9)) // then jitter
    expect(replay(frames).bearing).toBe(0)
  })

  it('a deliberate 20° twist engages — and does not jump by the threshold', () => {
    const frames: Array<[TwistPoint, TwistPoint]> = []
    for (let deg = 0; deg <= 20; deg += 5) frames.push(fingers(400, 300, 240, deg))
    const r = replay(frames)
    expect(r.engagedAt).toBe(3) // the 15° frame, the first past 12°
    expect(r.gate.engaged).toBe(true)
    expect(r.deltas[r.engagedAt - 1]).toBe(0) // the engaging frame turns nothing
    // only what is twisted AFTER engaging turns the map: 20 − 15 = 5°, clockwise ⇒ bearing −5
    expect(r.bearing).toBeCloseTo(-5, 9)
  })

  it('after engaging, the bearing follows the twist delta exactly, frame by frame — zoom and pan alongside', () => {
    const angles = [0, 5, 13, 20, 18, 45, 44.5, 90, 60]
    const frames = angles.map((deg, i) => fingers(400 + i * 17, 300 - i * 9, 250 + i * 30, deg))
    const r = replay(frames)
    expect(r.engagedAt).toBe(2)
    for (let i = 3; i < angles.length; i++) expect(r.deltas[i - 1]).toBeCloseTo(-(angles[i] - angles[i - 1]), 9)
    expect(r.bearing).toBeCloseTo(-(60 - 13), 9)
  })

  it('lifting a finger ends the gesture: nothing turns until two fingers come down again, un-engaged', () => {
    const gate = createTwistGate()
    gate.start(...fingers(0, 0, 300, 0))
    expect(gate.move(...fingers(0, 0, 300, 30))).toBe(0)
    expect(gate.engaged).toBe(true)
    gate.end()
    expect(gate.engaged).toBe(false)
    expect(gate.move(...fingers(0, 0, 300, 60))).toBeNull()
    // a new gesture has to earn it again from ITS touch-down
    gate.start(...fingers(0, 0, 300, 60))
    expect(gate.move(...fingers(0, 0, 300, 68))).toBeNull()
  })

  it('handles the ±180° wrap: a twist across the seam engages and follows as a small turn', () => {
    const frames: Array<[TwistPoint, TwistPoint]> = []
    // 170° → −150° on screen, i.e. a 40° twist through the seam; it engages at 185° (= −175°)
    for (let deg = 170; deg <= 210; deg += 5) frames.push(fingers(0, 0, 300, deg > 180 ? deg - 360 : deg))
    const r = replay(frames)
    expect(r.engagedAt).toBe(3)
    expect(r.bearing).toBeCloseTo(-25, 9)
  })

  it('gloves: fingers close together need real travel along their circle, not just degrees', () => {
    // 50 px apart, 25° of «twist» — 11 px of arc, the wander of a gloved contact
    const r = replay([fingers(0, 0, 50, 0), fingers(0, 0, 50, 12), fingers(0, 0, 50, 25), fingers(0, 0, 50, 12)])
    expect(r.engagedAt).toBe(-1)
    // …while the same fingers really turning do engage once the arc is travelled
    const needDeg = (TWIST_ENGAGE_ARC_PX / 25) / RAD // arc = θ · r, r = 25
    const r2 = replay([fingers(0, 0, 50, 0), fingers(0, 0, 50, needDeg + 1)])
    expect(r2.engagedAt).toBe(1)
  })
})

describe('field case (iPad 23.09.2026) — a two-finger pan with slight roll', () => {
  it('leaves the bearing at exactly 0 over many frames', () => {
    const frames: Array<[TwistPoint, TwistPoint]> = []
    // a long diagonal two-finger scroll, the wrist rolling up to ±10° and the spread breathing
    for (let i = 0; i <= 600; i++) {
      frames.push(fingers(200 + i * 1.3, 700 - i * 0.9, 220 + 25 * Math.sin(i / 11), 10 * Math.sin(i / 7) * Math.cos(i / 29)))
    }
    expect(replay(frames).bearing).toBe(0)
  })
})

describe('soak — 10 000 randomised gestures', () => {
  it('pans and pinches with twist noise below the threshold never turn the map', () => {
    const rand = rng(0x5eed)
    for (let g = 0; g < 10_000; g++) {
      let cx = rand() * 1000, cy = rand() * 800
      let dist = 60 + rand() * 500
      const base = rand() * 360 - 180
      let noise = 0
      const n = 5 + Math.floor(rand() * 40)
      const frames: Array<[TwistPoint, TwistPoint]> = [fingers(cx, cy, dist, base)]
      for (let i = 0; i < n; i++) {
        cx += (rand() - 0.5) * 60; cy += (rand() - 0.5) * 60
        dist = Math.max(20, dist * (0.85 + rand() * 0.3))
        noise = Math.max(-11.5, Math.min(11.5, noise + (rand() - 0.5) * 8)) // wanders, never reaches 12°
        let deg = base + noise
        if (deg > 180) deg -= 360
        if (deg <= -180) deg += 360
        frames.push(fingers(cx, cy, dist, deg))
      }
      const r = replay(frames)
      if (r.bearing !== 0) throw new Error(`gesture ${g} turned the map to ${r.bearing}`)
    }
  })

  it('deliberate twists end on exactly the twist made after engaging (±1e-6)', () => {
    const rand = rng(0xbea7)
    for (let g = 0; g < 10_000; g++) {
      let cx = rand() * 1000, cy = rand() * 800
      let dist = 200 + rand() * 300 // a hand apart: the 12° threshold is the one that decides
      const sign = rand() < 0.5 ? -1 : 1
      const target = sign * (TWIST_ENGAGE_DEG + 1 + rand() * 500) // up to more than a full turn
      const base = rand() * 360 - 180
      // the generator's own, UNWRAPPED angle sequence is the truth the gate is checked against
      const theta: number[] = [0]
      let t = 0
      while (Math.abs(t) < Math.abs(target)) {
        t += sign * (0.5 + rand() * 20) + (rand() - 0.5) * 4 // mostly forward, with jitter
        theta.push(t)
      }
      const frames = theta.map((th) => {
        cx += (rand() - 0.5) * 30; cy += (rand() - 0.5) * 30
        dist = Math.min(500, Math.max(200, dist * (0.9 + rand() * 0.2)))
        return fingers(cx, cy, dist, base + th)
      })
      const engage = theta.findIndex((th) => Math.abs(th) >= TWIST_ENGAGE_DEG)
      const expected = -(theta[theta.length - 1] - theta[engage])
      const r = replay(frames)
      if (r.engagedAt !== engage || Math.abs(r.bearing - expected) > 1e-6) {
        throw new Error(`gesture ${g}: engaged at ${r.engagedAt} (expected ${engage}), bearing ${r.bearing} (expected ${expected})`)
      }
    }
  })
})

describe('installTwistGate — on the installed MapLibre\'s own rotate handler', () => {
  const touches = (n: number) => Array.from({ length: n }, (_, i) => ({ identifier: i }) as Touch)
  const ev = { preventDefault: () => {} } as unknown as TouchEvent
  const pts = (p: [TwistPoint, TwistPoint]) => p.map((q) => new Point(q.x, q.y))
  const handler = () => {
    const h = new TwoFingersTouchRotateHandler()
    h.enable()
    expect(installTwistGate(h)).toBe(true)
    return h
  }

  it('reports no rotation — and is not active — below the threshold, then follows once engaged', () => {
    const h = handler()
    h.touchstart(ev, pts(fingers(400, 300, 300, 0)), touches(2))
    // MapLibre alone would have engaged here (25 px of arc at 300 px apart is ~9.5°)
    expect(h.touchmove(ev, pts(fingers(400, 300, 300, 10)), touches(2))).toBeUndefined()
    expect(h.isActive()).toBe(false)
    const engage = h.touchmove(ev, pts(fingers(410, 290, 320, 14)), touches(2)) as { bearingDelta: number; pinchAround: { x: number; y: number } }
    expect(engage.bearingDelta).toBe(0)
    expect(engage.pinchAround).toMatchObject({ x: 410, y: 290 }) // turns about the point between the fingers
    expect(h.isActive()).toBe(true)
    const next = h.touchmove(ev, pts(fingers(410, 290, 320, 34)), touches(2)) as { bearingDelta: number }
    expect(next.bearingDelta).toBeCloseTo(-20, 9)
  })

  it('a finger lifting ends it (MapLibre\'s own touchend → reset)', () => {
    const h = handler()
    h.touchstart(ev, pts(fingers(400, 300, 300, 0)), touches(2))
    h.touchmove(ev, pts(fingers(400, 300, 300, 30)), touches(2))
    expect(h.isActive()).toBe(true)
    h.touchend(ev, pts(fingers(400, 300, 300, 30)).slice(0, 1), touches(1))
    expect(h.isActive()).toBe(false)
    expect(h.touchmove(ev, pts(fingers(400, 300, 300, 60)), touches(2))).toBeUndefined()
  })

  it('the field case through MapLibre: a rolled two-finger pan hands the map no bearing at all', () => {
    const h = handler()
    h.touchstart(ev, pts(fingers(200, 700, 220, 0)), touches(2))
    let bearing = 0
    for (let i = 1; i <= 400; i++) {
      const r = h.touchmove(ev, pts(fingers(200 + i, 700 - i, 220 + 20 * Math.sin(i / 9), 11 * Math.sin(i / 13))), touches(2))
      if (r && 'bearingDelta' in r) bearing += r.bearingDelta ?? 0
    }
    expect(bearing).toBe(0)
    expect(h.isActive()).toBe(false)
  })

  it('refuses a handler of the wrong shape, and the Karte then switches touch rotation OFF', () => {
    expect(installTwistGate(null)).toBe(false)
    expect(installTwistGate({ _move: () => {} })).toBe(false)
    const disableRotation = vi.fn()
    gateTouchRotation({ touchZoomRotate: { disableRotation } })
    expect(disableRotation).toHaveBeenCalledOnce()
    // …and a well-formed one is gated, not disabled
    const ok = vi.fn()
    gateTouchRotation({ touchZoomRotate: { disableRotation: ok, _touchRotate: new TwoFingersTouchRotateHandler() } as never })
    expect(ok).not.toHaveBeenCalled()
  })

  it('installing twice is harmless (a context-loss remount re-runs onLoad)', () => {
    const h = new TwoFingersTouchRotateHandler()
    expect(installTwistGate(h)).toBe(true)
    const move = (h as unknown as { _move: unknown })._move
    expect(installTwistGate(h)).toBe(true)
    expect((h as unknown as { _move: unknown })._move).toBe(move)
  })
})
