import { useEffect, useRef, useState } from 'react'
import { planRegionUrl } from './PdfViewport'
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
  const [src, setSrc] = useState<string | null>(null) // keyed by url+floor in the parent – a new page mounts anew
  const alive = useRef(true)
  const [x0, y0, x1, y1] = region
  useEffect(() => {
    alive.current = true
    void planRegionUrl(url, [x0, y0, x1, y1], pageCanvasBudget(floors), FLOOR_PAGE_SIDE, () => alive.current)
      .then((u) => { if (alive.current) setSrc(u) })
      .catch(() => { /* the outline alone, as before */ })
    // a stack torn down mid-bake stops the queue behind it rather than rasterising for nobody
    return () => { alive.current = false }
  }, [url, x0, y0, x1, y1, floors])
  const [o, px, py] = regionCorners(corners, [x0, y0, x1, y1])
  const m = [(px[0] - o[0]) * w, (px[1] - o[1]) * h, (py[0] - o[0]) * w, (py[1] - o[1]) * h, o[0] * w, o[1] * h]
  const at = `matrix(${m.map((v) => v.toFixed(4)).join(' ')})`
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
