import { describe, expect, it } from 'vitest'
import { freeResizeLocal, norm360, pointerDeg, rotationEnd, rotationEndDeg, rotorDeg } from './rotorMath'

// The turn/size maths both surfaces share (23.09.2026). Each case pins the function against the
// inline formula it replaced — kept here VERBATIM as the oracle — over a spread of pointer
// positions, bearings and rotations, bit for bit (Object.is): a stored angle or size that moved by
// one ulp would be a different number in the record, and a different number on the other device.
const rnd = (() => { let s = 20260923; return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) })()
const samples = Array.from({ length: 400 }, () => ({
  px: rnd() * 1200 - 100, py: rnd() * 900 - 100, cx: rnd() * 1000, cy: rnd() * 800,
  bearing: rnd() * 720 - 360, rot: rnd() * 720 - 360, grip: rnd() * 40,
}))

describe('rotorMath matches the inline maths it replaced', () => {
  it('rotor grips — the Plan (no bearing) and the Karte (+ bearing), every mode', () => {
    for (const { px, py, cx, cy, bearing } of samples) {
      const deg = (Math.atan2(py - cy, px - cx) * 180) / Math.PI
      const p = { x: px, y: py }, c = { x: cx, y: cy }
      // Whiteboard · rotMove (rotate / rotate2) and its cage
      expect(Object.is(rotorDeg(p, c, 'rotate'), Math.round((((deg + 90) % 360) + 360) % 360))).toBe(true)
      expect(Object.is(rotorDeg(p, c, 'rotate2'), Math.round((((deg + -90) % 360) + 360) % 360))).toBe(true)
      expect(Object.is(rotorDeg(p, c, 'aim'), Math.round(((deg % 360) + 360) % 360))).toBe(true)
      // MapMarkers · rotMove, shapeMove (rotate / rotate2, cage)
      expect(Object.is(rotorDeg(p, c, 'aim', bearing), Math.round((((deg + bearing) % 360) + 360) % 360))).toBe(true)
      expect(Object.is(rotorDeg(p, c, 'rotate', bearing), Math.round((((deg + 90 + bearing) % 360) + 360) % 360))).toBe(true)
      expect(Object.is(rotorDeg(p, c, 'rotate2', bearing), Math.round((((deg + -90 + bearing) % 360) + 360) % 360))).toBe(true)
    }
  })

  it('a Rotation end: pulled back along the run, and its bearing for either grip', () => {
    for (const { px, py, cx, cy, bearing, grip } of samples) {
      const f = { x: cx, y: cy }
      const d = Math.hypot(px - f.x, py - f.y) || 1
      const ux = (px - f.x) / d, uy = (py - f.y) / d
      const ex = px - ux * grip, ey = py - uy * grip
      const e = rotationEnd({ x: px, y: py }, f, grip)
      expect(Object.is(e.x, ex) && Object.is(e.y, ey)).toBe(true)
      const degB = (Math.atan2(ey - f.y, ex - f.x) * 180) / Math.PI
      const degA = (Math.atan2(f.y - ey, f.x - ex) * 180) / Math.PI
      expect(Object.is(rotationEndDeg('endB', f, e), Math.round(((degB % 360) + 360) % 360))).toBe(true)
      expect(Object.is(rotationEndDeg('endA', f, e), Math.round(((degA % 360) + 360) % 360))).toBe(true)
      expect(Object.is(rotationEndDeg('endB', f, e, bearing), Math.round((((degB + bearing) % 360) + 360) % 360))).toBe(true)
      expect(Object.is(rotationEndDeg('endA', f, e, bearing), Math.round((((degA + bearing) % 360) + 360) % 360))).toBe(true)
    }
  })

  it('a pointer on its own centre is no direction — the run length falls back to 1, as before', () => {
    expect(rotationEnd({ x: 5, y: 5 }, { x: 5, y: 5 }, 10)).toEqual({ x: 5, y: 5 })
  })

  it('the free-aspect corner, turned into the Form’s own frame', () => {
    for (const { px, py, cx, cy, rot } of samples) {
      const rad = (-rot * Math.PI) / 180
      const dx = px - cx, dy = py - cy
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
      const got = freeResizeLocal({ x: px, y: py }, { x: cx, y: cy }, rot)
      expect(Object.is(got.lx, lx) && Object.is(got.ly, ly)).toBe(true)
    }
  })

  it('norm360 and pointerDeg on the obvious cases', () => {
    expect(norm360(-90)).toBe(270)
    expect(norm360(725)).toBe(5)
    expect(pointerDeg({ x: 1, y: 1 }, { x: 0, y: 0 })).toBeCloseTo(45, 12)
  })
})
