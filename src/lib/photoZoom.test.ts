import { describe, expect, it } from 'vitest'
import { PHOTO_ZOOM_MAX, TAP_ZOOM, ZOOM_FIT, clampZoom, containSize, onPicture, pinchTo, toggleZoomAt, zoomAbout } from './photoZoom'

/* The full-size picture viewer's maths (lib/ui · PhotoZoom; owner, 08.10.2026: «zoom in … doesn't
 * actually zoom in»). Points are px from the frame's centre; a picture spot q lands at x + k·q. */
const phone = { w: 390, h: 784 } // the phone viewer's frame under its head row
const photo = { w: 1600, h: 1200 } // a landscape 4:3 photo

describe('containSize', () => {
  it('fits the picture inside the frame, keeping its shape', () => {
    expect(containSize(phone, photo)).toEqual({ w: 390, h: 292.5 })
    const wide = containSize({ w: 1000, h: 500 }, photo)
    expect(wide.w).toBeCloseTo(500 * (4 / 3))
    expect(wide.h).toBeCloseTo(500)
  })
  it('takes the frame itself while the picture has no size yet (still loading)', () => {
    expect(containSize(phone, null)).toEqual(phone)
    expect(containSize(phone, { w: 0, h: 0 })).toEqual(phone)
  })
})

describe('clampZoom', () => {
  const pic = containSize(phone, photo)
  it('holds k to [1, MAX] and snaps a near-fit back to exactly the fit', () => {
    expect(clampZoom({ k: 0.5, x: 30, y: 30 }, phone, pic)).toEqual(ZOOM_FIT)
    expect(clampZoom({ k: 1.01, x: 30, y: 30 }, phone, pic)).toEqual(ZOOM_FIT)
    expect(clampZoom({ k: 20, x: 0, y: 0 }, phone, pic).k).toBe(PHOTO_ZOOM_MAX)
  })
  it('pans no further than the picture\'s own edge, and keeps a side that still fits centred', () => {
    // at 2×: 780 × 585 drawn — 195px to spare sideways each way, none vertically (585 < 784)
    expect(clampZoom({ k: 2, x: 1000, y: 1000 }, phone, pic)).toEqual({ k: 2, x: 195, y: 0 })
    expect(clampZoom({ k: 2, x: -1000, y: -1000 }, phone, pic)).toEqual({ k: 2, x: -195, y: -0 })
    // at 4×: 1170 tall — now it may move vertically too, by (1170 − 784) / 2
    expect(clampZoom({ k: 4, x: 0, y: -1000 }, phone, pic)).toEqual({ k: 4, x: 0, y: -193 })
  })
})

describe('zoomAbout', () => {
  it('keeps the spot under the finger where it was', () => {
    const at = { x: 100, y: -50 }
    const z = zoomAbout(ZOOM_FIT, 3, at)
    // the picture spot that was under `at` (q = at at the fit) lands at x + k·q = at again
    expect(z.x + z.k * at.x).toBeCloseTo(at.x)
    expect(z.y + z.k * at.y).toBeCloseTo(at.y)
    // …from a zoomed state as well
    const q = { x: (at.x - z.x) / z.k, y: (at.y - z.y) / z.k }
    const z2 = zoomAbout(z, 5, at)
    expect(z2.x + z2.k * q.x).toBeCloseTo(at.x)
    expect(z2.y + z2.k * q.y).toBeCloseTo(at.y)
  })
  it('stops at the limits without the anchor drifting', () => {
    const z = zoomAbout({ k: 7, x: 40, y: 0 }, 50, { x: 40, y: 0 })
    expect(z).toEqual({ k: PHOTO_ZOOM_MAX, x: 40, y: 0 })
  })
})

describe('pinchTo', () => {
  it('spreads the fingers → zooms by the spread, about the midpoint', () => {
    const mid = { x: 20, y: 10 }
    const z = pinchTo(ZOOM_FIT, mid, 100, mid, 250)
    expect(z.k).toBe(2.5)
    expect(z.x + z.k * mid.x).toBeCloseTo(mid.x)
    expect(z.y + z.k * mid.y).toBeCloseTo(mid.y)
  })
  it('moves the midpoint → the picture moves with it (a pinch pans as well)', () => {
    const start = { k: 2, x: 0, y: 0 }
    expect(pinchTo(start, { x: 0, y: 0 }, 100, { x: 30, y: -40 }, 100)).toEqual({ k: 2, x: 30, y: -40 })
  })
  it('ignores a degenerate spread (two fingers on one spot)', () => {
    expect(pinchTo({ k: 2, x: 5, y: 5 }, { x: 0, y: 0 }, 0, { x: 0, y: 0 }, 80)).toEqual({ k: 2, x: 5, y: 5 })
  })
})

describe('toggleZoomAt (double tap / click)', () => {
  it('zooms in about the tapped spot, and back to the fit from any zoom', () => {
    const z = toggleZoomAt(ZOOM_FIT, { x: 60, y: 0 })
    expect(z.k).toBe(TAP_ZOOM)
    expect(z.x + z.k * 60).toBeCloseTo(60)
    expect(toggleZoomAt(z, { x: 0, y: 0 })).toEqual(ZOOM_FIT)
  })
})

describe('onPicture', () => {
  const pic = containSize(phone, photo) // 390 × 292.5, centred
  it('tells the picture from the dark letterbox around it (where a tap closes)', () => {
    expect(onPicture(ZOOM_FIT, pic, { x: 0, y: 0 })).toBe(true)
    expect(onPicture(ZOOM_FIT, pic, { x: 0, y: 140 })).toBe(true)
    expect(onPicture(ZOOM_FIT, pic, { x: 0, y: 200 })).toBe(false)
    expect(onPicture(ZOOM_FIT, pic, { x: 0, y: -300 })).toBe(false)
  })
  it('follows the zoom: at 3× the letterbox is gone', () => {
    expect(onPicture({ k: 3, x: 0, y: 0 }, pic, { x: 0, y: 300 })).toBe(true)
  })
})
