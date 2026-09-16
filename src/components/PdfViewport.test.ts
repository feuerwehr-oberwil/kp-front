// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { regionRaster } from '../lib/pdfRenderBudget'

/* `planRegionUrl` is what a Gebäude storey draws: pdf.js renders THIS floor's rectangle into a
 * canvas the size of the rectangle, the rest of the page shifted off it by the viewport's
 * offset. No full-page canvas is allocated at any point — which is the whole difference between
 * a storey that is as sharp as the same sheet on Modul 6 and one that is a fifth as sharp
 * (16.09.2026), and between 42 MB of storey rasters and 475 MB (15.09.2026). */

const A1_W = 1684, A1_H = 2384
const render = vi.fn((_params: { canvas: HTMLCanvasElement }) => ({ promise: Promise.resolve(), cancel: vi.fn() }))
const cleanup = vi.fn()
const getViewport = vi.fn(({ scale }: { scale: number }) => ({ width: A1_W * scale, height: A1_H * scale }))
const getPage = vi.fn(() => Promise.resolve({ getViewport, render, cleanup }))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve({ numPages: 3, getPage }), destroy: () => Promise.resolve() }),
}))

// the canvas as it was SIZED — `renderRegion` hands its backing store back (width = 0) the
// moment the JPEG holds the pixels, so it has to be read at the one point it is still alive
const canvases: { el: HTMLCanvasElement; width: number; height: number }[] = []
beforeEach(() => {
  vi.clearAllMocks()
  canvases.length = 0
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    canvases.push({ el: this, width: this.width, height: this.height })
    return {} as CanvasRenderingContext2D
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AAAA')
})

describe('planRegionUrl – one region of a page, rendered alone', () => {
  it('sizes the canvas to the region and shifts the rest of the page off it', async () => {
    const { planRegionUrl } = await import('./PdfViewport')
    const clip: [number, number, number, number] = [0.19, 0.08, 0.81, 0.3] // the Dreilinden EG storey
    const budget = 3_200_000 // a phone's document budget split between five storeys
    const out = await planRegionUrl('/plans/dreilinden.pdf#page=2', clip, budget)
    expect(out).toBe('data:image/jpeg;base64,AAAA')

    const want = regionRaster(A1_W, A1_H, clip, budget)
    expect(getPage).toHaveBeenCalledWith(2) // the pack's second sheet, as the fragment names it
    expect(getViewport).toHaveBeenLastCalledWith({ scale: want.scale, offsetX: want.offsetX, offsetY: want.offsetY })
    const canvas = canvases[0]
    expect([canvas.width, canvas.height]).toEqual([want.width, want.height])
    expect(canvas.el.width).toBe(0) // …and handed back as soon as the JPEG had them
    // …and the region, not the page: an A1 at this scale would be far bigger than what we drew
    expect(canvas.width).toBeLessThan(A1_W * want.scale)
    expect(canvas.height).toBeLessThan(A1_H * want.scale)
    // the page's render internals go back; the DOCUMENT stays, the next storey is a page of it
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(render.mock.calls[0][0]).toMatchObject({ canvas: canvas.el })
  })

  it('serves a second ask for the same region from the cache instead of rendering again', async () => {
    const { planRegionUrl } = await import('./PdfViewport')
    const clip: [number, number, number, number] = [0, 0, 0.5, 0.5]
    await planRegionUrl('/plans/dreilinden.pdf#page=4', clip, 3_200_000)
    await planRegionUrl('/plans/dreilinden.pdf#page=4', clip, 3_200_000)
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('never starts a render the tile no longer wants', async () => {
    const { planRegionUrl } = await import('./PdfViewport')
    await expect(planRegionUrl('/plans/dreilinden.pdf#page=3', [0, 0, 1, 1], 3_200_000, 2048, () => false))
      .rejects.toThrow()
    expect(render).not.toHaveBeenCalled()
  })
})
