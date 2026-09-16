// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FloorPage } from './FloorPage'
import { FLOOR_PAGE_SIDE, pageCanvasBudget } from '../lib/pdfRenderBudget'
import { joinShifts } from '../lib/floorPackBinding'
import { packFrameRing, packPagePlacement } from '../lib/stackFit'
import type { PlanFloor } from '../lib/api/reference'
import { buildView, type Pt } from '../lib/footprint'

/* The storey tile renders ITS OWN rectangle of the sheet (16.09.2026). Two things must hold, and
 * both were bugs once: the raster is asked for by REGION (a page raster clipped to a fifth of an
 * A1 was a fifth as sharp as the same sheet on Modul 6), and it is never asked for in the tile's
 * on-screen size (the tile grows with the zoom, and a bake per pinch tick is what jetsammed a
 * phone on 15.09.). */

const planRegionUrl = vi.fn(() => Promise.resolve('data:image/jpeg;base64,AAAA'))
// a DELIBERATELY tiny crop: every tile below is drawn far bigger than 10 px, so the sharp render
// is asked for — which is what the older assertions in this file are about
const planRegionCropUrl = vi.fn(() => Promise.resolve({ url: 'data:image/jpeg;base64,CROP', width: 10 }))
vi.mock('./PdfViewport', () => ({
  planRegionUrl: (...args: unknown[]) => planRegionUrl(...(args as [])),
  planRegionCropUrl: (...args: unknown[]) => planRegionCropUrl(...(args as [])),
}))

// the page laid into the tile box 1:1, and the storey's drawing on the left-hand 40 % of it
const PAGE: [Pt, Pt, Pt] = [[0, 0], [1, 0], [0, 1]]
const EG: [number, number, number, number] = [0.1, 0.2, 0.5, 0.6]

const sheet = (ui: React.ReactNode) => render(<svg viewBox="0 0 400 300">{ui}</svg>)

afterEach(() => { planRegionUrl.mockClear(); planRegionCropUrl.mockClear() })

describe('FloorPage', () => {
  it('asks for the storey\'s own region, at the storeys\' share of the budget', async () => {
    sheet(<FloorPage url="/plans/pack.pdf#page=2" corners={PAGE} region={EG} w={400} h={300} floors={5} />)
    await waitFor(() => expect(planRegionUrl).toHaveBeenCalled())
    const [url, clip, budget, maxSide] = planRegionUrl.mock.calls[0] as unknown as [string, number[], number, number]
    expect(url).toBe('/plans/pack.pdf#page=2')
    expect(clip).toEqual(EG)
    expect(budget).toBe(pageCanvasBudget(5)) // five storeys, one document's worth between them
    expect(maxSide).toBe(FLOOR_PAGE_SIDE)
  })

  it('does not re-bake when the tile grows – the zoom must never reach the raster', async () => {
    const { rerender } = sheet(<FloorPage url="/p.pdf" corners={PAGE} region={EG} w={400} h={300} floors={3} />)
    await waitFor(() => expect(planRegionUrl).toHaveBeenCalledTimes(1))
    rerender(<svg viewBox="0 0 400 300"><FloorPage url="/p.pdf" corners={PAGE} region={EG} w={3200} h={2400} floors={3} /></svg>)
    await Promise.resolve()
    expect(planRegionUrl).toHaveBeenCalledTimes(1)
  })

  it('covers the region 1:1 – the raster IS the drawing, so nothing is clipped away', async () => {
    const { container } = sheet(<FloorPage url="/p.pdf" corners={PAGE} region={EG} w={400} h={300} floors={2} />)
    const img = await waitFor(() => {
      const el = container.querySelector('image')
      expect(el).toBeTruthy()
      return el!
    })
    // the unit square lands on the region: 0.4 × 0.4 of a 400 × 300 box, offset by (0.1, 0.2)
    expect(img.getAttribute('transform')).toBe('matrix(160.0000 0.0000 0.0000 120.0000 40.0000 60.0000)')
    expect(container.querySelector('clipPath')).toBeNull()
  })

  // ⚠️ A dense sheet charges per RENDER, not per pixel: the Tramdepot's A1 is ~2 s a pass at any
  // size, and its pack is six drawings on that one page. So the tile comes up from the page's own
  // bake (a blit) and the sharp per-region render swaps in behind it (16.09.2026).
  it('shows the page crop first and swaps the sharp region in when it lands', async () => {
    let land = (_u: string) => {}
    planRegionUrl.mockImplementationOnce(() => new Promise<string>((res) => { land = res }))
    const { container } = sheet(<FloorPage url="/p.pdf" corners={PAGE} region={EG} w={400} h={300} floors={6} />)

    await waitFor(() => expect(container.querySelector('image')?.getAttribute('href')).toBe('data:image/jpeg;base64,CROP'))
    expect(planRegionCropUrl).toHaveBeenCalledWith('/p.pdf', EG)

    land('data:image/jpeg;base64,SHARP')
    await waitFor(() => expect(container.querySelector('image')?.getAttribute('href')).toBe('data:image/jpeg;base64,SHARP'))
  })

  // ⚠️ …and it is NOT asked for while the crop is enough. A fitted stack of six drawings would
  // otherwise spend six passes over a dense A1 in the background for a picture nobody can tell
  // apart from the one already on screen.
  it('leaves the page alone while the crop is bigger than the tile is drawn', async () => {
    planRegionCropUrl.mockResolvedValueOnce({ url: 'data:image/jpeg;base64,BIG', width: 4000 })
    const { container } = sheet(<FloorPage url="/p.pdf" corners={PAGE} region={EG} w={400} h={300} floors={6} />)

    await waitFor(() => expect(container.querySelector('image')?.getAttribute('href')).toBe('data:image/jpeg;base64,BIG'))
    expect(planRegionUrl).not.toHaveBeenCalled()
  })

  // …until the zoom outgrows it: the tile box grows with the board, and then the drawing is
  // worth its own pass.
  it('asks for the sharp render once the zoom outgrows the crop', async () => {
    planRegionCropUrl.mockResolvedValueOnce({ url: 'data:image/jpeg;base64,BIG', width: 900 })
    const { container, rerender } = sheet(<FloorPage url="/p.pdf" corners={PAGE} region={EG} w={400} h={300} floors={6} />)
    await waitFor(() => expect(container.querySelector('image')).toBeTruthy())
    expect(planRegionUrl).not.toHaveBeenCalled()

    // 6× zoom: the region's own width on the board passes the crop's 900 px
    rerender(<svg viewBox="0 0 2400 1800"><FloorPage url="/p.pdf" corners={PAGE} region={EG} w={2400} h={1800} floors={6} /></svg>)
    await waitFor(() => expect(planRegionUrl).toHaveBeenCalledTimes(1))
  })

  // ⚠️ A bake that will not come is the one case where the tile has nothing to show and nothing to
  // measure against: it waits on its placeholder, and asks for the sharp render the moment the
  // bake FAILS rather than leaving the storey blank.
  it('falls back to the region render when the page bake fails', async () => {
    planRegionCropUrl.mockRejectedValueOnce(new Error('no bake'))
    const { container } = sheet(<FloorPage url="/p.pdf" corners={PAGE} region={EG} w={400} h={300} floors={2} />)

    await waitFor(() => expect(container.querySelector('image')?.getAttribute('href')).toBe('data:image/jpeg;base64,AAAA'))
    expect(planRegionUrl).toHaveBeenCalledTimes(1)
  })

  // ⚠️ the bakes are serialised, so the last tile of a stack waits for the ones before it – an
  // empty tile read as «kein Geschossplan» rather than «kommt gleich» (Bastian, 16.09.2026)
  it('holds the drawing\'s place while the raster is still baking', async () => {
    let land = (_u: string) => {}
    planRegionUrl.mockImplementationOnce(() => new Promise<string>((res) => { land = res }))
    const { container } = sheet(<FloorPage url="/p.pdf" corners={PAGE} region={EG} w={400} h={300} floors={2} />)
    const wait = container.querySelector('.wb-floor-page-wait')!
    expect(wait).toBeTruthy()
    // …on exactly the rectangle the raster will land on, so the tile never jumps
    expect(wait.getAttribute('transform')).toBe('matrix(160.0000 0.0000 0.0000 120.0000 40.0000 60.0000)')
    land('data:image/jpeg;base64,AAAA')
    await waitFor(() => expect(container.querySelector('image')).toBeTruthy())
    expect(container.querySelector('.wb-floor-page-wait')).toBeNull()
  })

  it('renders the whole page when a storey has no rectangle of its own', async () => {
    sheet(<FloorPage url="/p.pdf" corners={PAGE} w={400} h={300} floors={1} />)
    await waitFor(() => expect(planRegionUrl).toHaveBeenCalled())
    expect((planRegionUrl.mock.calls[0] as unknown as [string, number[]])[1]).toEqual([0, 0, 1, 1])
  })

  // A Geschoss drawn as two wings (16.09.2026) is two rasters on ONE tile: each asks for its own
  // rectangle and lands through its own join shift, so the two halves meet where the building does.
  it('a storey drawn twice is two rasters, each its own region and its own place', async () => {
    const west: PlanFloor = { index: 1, part: 0, page: 0, name: null, clip: [0.05, 0.55, 0.45, 0.95], join: { to: 0, at: [0.1, 0.6], there: [0.1, 0.1] } }
    const east: PlanFloor = { index: 1, part: 1, page: 0, name: null, clip: [0.55, 0.55, 0.95, 0.95], join: { to: 0, at: [0.6, 0.6], there: [0.6, 0.1] } }
    const ground: PlanFloor = { index: 0, part: 0, page: 0, name: null, clip: [0.05, 0.05, 0.95, 0.45] }
    const shifts = joinShifts([ground, west, east], ground)
    const { container } = sheet(<>
      {[west, east].map((f) => (
        <FloorPage key={f.part} url="/p.pdf" region={f.clip!} floors={2} w={400} h={300}
          corners={packPagePlacement(buildView(packFrameRing({ aspect: 1, frame: ground.clip! }), 0), 1, { shift: shifts.get(`${f.index}:${f.part}`)! })} />
      ))}
    </>)
    await waitFor(() => expect(container.querySelectorAll('image')).toHaveLength(2))
    expect(planRegionUrl.mock.calls.map((call) => (call as unknown as [string, number[]])[1]))
      .toEqual([west.clip, east.clip])
    const [a, b] = [...container.querySelectorAll('image')].map((el) => el.getAttribute('transform'))
    expect(a).not.toBe(b) // two drawings, two places – never one raster drawn twice
  })
})
