import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CANVAS_MAX_SIDE, MAX_CANVAS_PX, SMALL_DEVICE_DOC_PX, SMALL_DEVICE_PX,
  FLOOR_PAGE_SIDE, floorPageSide, pageCanvasBudget, rasterSide, renderScale, smallMemoryDevice,
} from './pdfRenderBudget'

/* The one ceiling every pdf.js render site in the app renders under (15.09.2026). An A1
 * Geschossplan asked at screen resolution is a 1.2 GB canvas, and the Gebäude floor-stack asks
 * for one per storey — which is exactly how an iPhone lost the tab on prod. */

// A1: the sheet a Geschossplan is drawn on, in PDF points
const A1_W = 1684, A1_H = 2384
// A4 portrait — the ordinary Modul sheet
const A4_W = 595, A4_H = 842

const px = (w: number, h: number, k: number) => Math.floor(w * k) * Math.floor(h * k)

afterEach(() => { vi.unstubAllGlobals() })

/** pretend to be the device that reports this much memory (Chromium) */
const withDeviceMemory = (gb: number) =>
  vi.stubGlobal('navigator', { deviceMemory: gb, userAgent: 'test', maxTouchPoints: 0 } as unknown as Navigator)

describe('renderScale – the scale a page may be rasterised at', () => {
  it('leaves an ordinary sheet exactly where the screen asked for it', () => {
    // A4 at the fit on a 3× phone: 1785 × 2526 = 4.5 M px, inside the budget
    expect(renderScale(A4_W, A4_H, 1, 3, MAX_CANVAS_PX)).toBe(3)
    expect(renderScale(A4_W, A4_H, 1, 2, MAX_CANVAS_PX)).toBe(2)
  })

  it('caps the A1 floor plan that killed the tab – zoom 4, dpr 3', () => {
    // what the screen asked for: 1684×4×3 = 20 208 × 28 608 px ≈ 578 M px, 2.3 GB
    expect(px(A1_W, A1_H, 4 * 3)).toBeGreaterThan(570_000_000)
    const k = renderScale(A1_W, A1_H, 4, 3, SMALL_DEVICE_PX)
    expect(px(A1_W, A1_H, k)).toBeLessThanOrEqual(SMALL_DEVICE_PX)
    expect(px(A1_W, A1_H, k)).toBeGreaterThan(SMALL_DEVICE_PX * 0.99) // and not a pixel less than it may
    expect(k).toBeLessThan(4 * 3)
  })

  it('shares one budget between the storeys of a floor pack', () => {
    // five storeys of the same A1 on a phone: each gets a fifth of the DOCUMENT budget, so the
    // stack as a whole costs what one sheet was allowed to — 64 MB of RGBA, not 475
    withDeviceMemory(2)
    const k = renderScale(A1_W, A1_H, 4, 3, pageCanvasBudget(5))
    expect(px(A1_W, A1_H, k) * 5).toBeLessThanOrEqual(SMALL_DEVICE_DOC_PX)
    expect(px(A1_W, A1_H, k) * 4 * 5).toBeLessThan(70 * 1024 * 1024) // bytes, 4 to a pixel
  })

  it('never asks for a side no engine will allocate', () => {
    // a stitched twelve-page strip: the side limit binds long before the area does
    const k = renderScale(600, 30_000, 1, 3, MAX_CANVAS_PX)
    expect(30_000 * k).toBeLessThanOrEqual(CANVAS_MAX_SIDE)
  })

  it('answers with the wanted scale rather than NaN on a degenerate page', () => {
    expect(renderScale(0, 0, 2, 3, MAX_CANVAS_PX)).toBe(6)
  })
})

describe('the budget knows what kind of device it is on', () => {
  it('is the full canvas limit on a desktop and a sixth of it on a phone', () => {
    withDeviceMemory(16)
    expect(smallMemoryDevice()).toBe(false)
    expect(pageCanvasBudget(1)).toBe(MAX_CANVAS_PX)
    withDeviceMemory(2)
    expect(smallMemoryDevice()).toBe(true)
    expect(pageCanvasBudget(1)).toBe(SMALL_DEVICE_PX)
  })

  it('reads an iPad as small – it reports neither deviceMemory nor its own name', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', maxTouchPoints: 5 } as unknown as Navigator)
    expect(smallMemoryDevice()).toBe(true)
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', maxTouchPoints: 0 } as unknown as Navigator)
    expect(smallMemoryDevice()).toBe(false)
  })

  it('a long document divides its budget, a short one does not', () => {
    withDeviceMemory(16)
    expect(pageCanvasBudget(30)).toBe(3_200_000)
    expect(pageCanvasBudget(0)).toBe(MAX_CANVAS_PX)
  })
})

describe('rasterSide – one bitmap per page, scaled by CSS from there', () => {
  it('is the long side whose area is the budget', () => {
    withDeviceMemory(2)
    const side = rasterSide(A1_H / A1_W, pageCanvasBudget(5))
    const w = side / (A1_H / A1_W)
    expect(w * side).toBeLessThanOrEqual(pageCanvasBudget(5) * 1.01)
    expect(side).toBeLessThanOrEqual(CANVAS_MAX_SIDE)
  })
})

describe('floorPageSide – what one storey of a Gebäude stack may raster', () => {
  it('is bounded by the ceiling, never by the tile\'s zoomed size', () => {
    withDeviceMemory(16)
    expect(floorPageSide(1)).toBe(FLOOR_PAGE_SIDE)
    expect(floorPageSide(5)).toBe(FLOOR_PAGE_SIDE)
    // …and well under the 3600 px the stack asked for before (15.09.2026)
    expect(floorPageSide(5)).toBeLessThan(3600)
  })
  it('divides the phone\'s budget between the storeys, so the stack costs one sheet', () => {
    withDeviceMemory(2)
    const side = floorPageSide(8)
    expect(side).toBeLessThan(FLOOR_PAGE_SIDE)
    const perFloor = (side / Math.SQRT2) * side // w × h of one A-format raster
    expect(perFloor * 8 * 4).toBeLessThan(70 * 1024 * 1024) // bytes of decoded RGBA, all storeys
  })
})
