import { useEffect, useRef, useState } from 'react'
import { planRegionCropUrl, planRegionUrl, type RegionCrop } from './PdfViewport'
import { FLOOR_PAGE_SIDE, pageCanvasBudget } from '../lib/pdfRenderBudget'
import { regionCorners } from '../lib/stackFit'
import type { Pt } from '../lib/footprint'

/** the whole page – a footprint stack lays one sheet per storey, uncropped */
const WHOLE: [number, number, number, number] = [0, 0, 1, 1]

/**
 * One storey's Geschossplan under its tile on the Gebäude stack.
 *
 * The RASTER IS THE DRAWING: only this floor's rectangle on the page is rendered
 * (PdfViewport · planRegionUrl), placed on the three corners the page's placement gives it
 * (lib/stackFit · regionCorners) – a similarity, so the drawing turns and scales with the
 * building. A whole-page storey simply asks for the whole page.
 *
 * ⚠️ 16.09.2026: it used to bake the WHOLE page and show this floor's part of it through a
 * clip-path, which spent the budget on the four fifths of an A1 nobody looks at – «Gebäude ist
 * unschärfer als Modul 6» was that, exactly. Same bytes, ~2.3× the pixels across the drawing.
 * ⚠️ The size is the region's share of the device budget and NEVER the tile's on-screen size:
 * the tile grows with the zoom, and asking in tile pixels minted a fresh bake, JPEG and decoded
 * image at every tick of a pinch (15.09.2026). Past that the CSS scales the bitmap – a slightly
 * soft plan is readable at 3am, a killed tab is not.
 */
export function FloorPage({ url, corners, region = WHOLE, w, h, floors }: {
  url: string
  /** the PAGE's (0,0), (1,0), (0,1) in the tile's 0..1 box (lib/stackFit) */
  corners: [Pt, Pt, Pt]
  /** this floor's rectangle on the page, normalized [x0, y0, x1, y1] */
  region?: [number, number, number, number]
  /** the tile box in SVG px, and how many storeys SHARE one pixel budget (lib/pdfRenderBudget) */
  w: number; h: number; floors: number
}) {
  // the page's own bake, cut to this drawing – the tile's first picture, and the yardstick for
  // whether the screen has outgrown it
  const [crop, setCrop] = useState<RegionCrop | null>(null)
  // …and the drawing rendered ALONE at the full budget, once the zoom asks for it
  const [sharp, setSharp] = useState<string | null>(null)
  const asked = useRef(false)
  const alive = useRef(true)
  const [x0, y0, x1, y1] = region
  /**
   * Two pictures, in this order.
   *
   * ⚠️ The BASE is cut out of the page's own bake (PdfViewport · planRegionCropUrl) and costs no
   * pdf.js pass at all, because the pass is what a dense sheet charges for: the Tramdepot's A1
   * measures ~2 s per render whatever the canvas size, and its pack is six drawings on that one
   * page. Rendering each of them separately meant the Gebäude took six passes to come up where
   * «Modul 6» — the same PDF — takes one, which is exactly how it felt (16.09.2026).
   *
   * The REFINE is that separate render, and it still happens: a region gets the whole pixel
   * budget to itself, which is what keeps a small storey legible when the stack is zoomed. It
   * lands behind the base and swaps, so nobody waits for it.
   */
  useEffect(() => {
    alive.current = true
    asked.current = false
    setCrop(null); setSharp(null)
    void planRegionCropUrl(url, [x0, y0, x1, y1])
      .then((c) => { if (alive.current) setCrop(c) })
      // no bake, no yardstick: fall back to the render that always worked
      .catch(() => { if (alive.current) refine() })
    // a stack torn down mid-bake stops the queue behind it rather than rasterising for nobody
    return () => { alive.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, x0, y0, x1, y1, floors])

  const refine = () => {
    if (asked.current) return
    asked.current = true
    void planRegionUrl(url, [x0, y0, x1, y1], pageCanvasBudget(floors), FLOOR_PAGE_SIDE, () => alive.current)
      .then((u) => { if (alive.current) setSharp(u) })
      .catch(() => { /* the crop, or the outline alone as before */ })
  }
  const [o, px, py] = regionCorners(corners, [x0, y0, x1, y1])
  const m = [(px[0] - o[0]) * w, (px[1] - o[1]) * h, (py[0] - o[0]) * w, (py[1] - o[1]) * h, o[0] * w, o[1] * h]
  const at = `matrix(${m.map((v) => v.toFixed(4)).join(' ')})`
  // How wide this drawing is being DRAWN, in board px — the tile box grows with the zoom, so this
  // is where the crop stops being enough and the sharp render is worth its pass over the page.
  const drawnPx = Math.hypot(m[0], m[1])
  useEffect(() => {
    if (crop && drawnPx > crop.width) refine()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crop, drawnPx])
  const src = sharp ?? crop?.url ?? null
  // ⚠️ The bakes are serialised (planRegionUrl), so on a four-storey stack the last tile waits for
  // the three before it – and a tile with nothing in it looks like a storey WITHOUT a plan rather
  // than one still coming (Bastian, 16.09.2026). The placeholder is the drawing's own rectangle,
  // exactly where the raster will land, so the tile does not jump when it arrives.
  if (!src) return <rect className="wb-floor-page-wait" width={1} height={1} transform={at} />
  return (
    <image
      href={src}
      width={1}
      height={1}
      preserveAspectRatio="none"
      className="wb-floor-page"
      transform={at}
    />
  )
}
