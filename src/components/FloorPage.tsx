import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { planRegionCropUrl, planRegionUrl, type RegionCrop } from './PdfViewport'
import { FLOOR_PAGE_SIDE, pageCanvasBudget } from '../lib/pdfRenderBudget'
import { regionCorners } from '../lib/stackFit'
import type { Pt } from '../lib/footprint'
import {
  loadTileManifest, pickLevel, ptToMm, sourcePages, tileSource, tileUrl, underlayLevel, visibleTiles,
  type Tile, type TileManifest, type TilePage,
} from '../lib/planTiles'

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
function RasterFloorPage({ url, corners, region = WHOLE, w, h, floors }: {
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

type FloorPageProps = Parameters<typeof RasterFloorPage>[0] & {
  /** how many board px one PAPER millimetre of this drawing spans right now – only a tiled
   *  storey can say (the manifest states the page size), and the board turns it into the stack's
   *  zoom ceiling (lib/planTiles · paperMaxScale) */
  onDensity?: (boardPxPerPaperMm: number) => void
}

/**
 * One storey's Geschossplan under its tile. ⚠️ Since 21.09.2026 it is drawn from the server's
 * TILE PYRAMID whenever the sheet has one (`TiledFloorPage`), and the raster pair above is what a
 * sheet without tiles keeps. Why it matters most HERE: a storey is a fifth of an A1 shown on a
 * sixth of the board, its one raster was capped at 2048 px, and the Gymnasium's room stamps are
 * 0.29 mm tall – «which room is this» could not be answered on the Gebäude at any zoom.
 */
export function FloorPage(props: FloorPageProps) {
  const source = useMemo(() => tileSource(props.url), [props.url])
  const [answer, setAnswer] = useState<{ url: string; manifest: TileManifest | null } | null>(null)
  useEffect(() => {
    if (!source) return
    let cancelled = false
    loadTileManifest(source).then(
      (manifest) => { if (!cancelled) setAnswer({ url: props.url, manifest }) },
      () => { if (!cancelled) setAnswer({ url: props.url, manifest: null }) },
    )
    return () => { cancelled = true }
  }, [props.url, source])
  const mine = answer && answer.url === props.url ? answer : null
  const page = mine?.manifest && source ? sourcePages(mine.manifest, source)[0] : undefined
  if (source && !mine) {
    // still asking: the drawing's own rectangle, exactly where the picture will land
    const [o, px, py] = regionCorners(props.corners, props.region ?? WHOLE)
    const { w, h } = props
    const m = [(px[0] - o[0]) * w, (px[1] - o[1]) * h, (py[0] - o[0]) * w, (py[1] - o[1]) * h, o[0] * w, o[1] * h]
    return <rect className="wb-floor-page-wait" width={1} height={1} transform={`matrix(${m.map((v) => v.toFixed(4)).join(' ')})`} />
  }
  if (!page || !mine?.manifest || !source) { const { onDensity: _unused, ...raster } = props; void _unused; return <RasterFloorPage {...raster} /> }
  return (
    <TiledFloorPage {...props} page={page} tileSize={mine.manifest.tileSize}
      href={(z, x, y) => tileUrl(source, page.page, z, x, y)}
      onFail={() => setAnswer({ url: props.url, manifest: null })} />
  )
}

const SETTLE_MS = 90
/** how long the previous level's tiles stay under a new level's while those load */
const KEEP_MS = 1500
const DPR = () => Math.min(window.devicePixelRatio || 1, 2)

/**
 * The storey's drawing as tiles, inside the stack's SVG. The group carries the SAME matrix the
 * raster carried, so its unit square is the drawing's REGION on the page; a tile lies in it at
 * its page fractions re-based onto that region, and a clip cuts away what the page shows beside
 * the drawing. Which tiles: the underlay level's, always (soft, instant), plus – settled – the
 * tiles of the level the zoom asks for that are ON SCREEN, found by taking the window's corners
 * back through the group's own screen matrix (a storey may be turned, so it is a quad's bounds,
 * not a rectangle). A storey off screen mounts no detail tiles at all.
 */
function TiledFloorPage({ corners, region = WHOLE, w, h, page, tileSize, href, onFail, onDensity }: FloorPageProps & {
  page: TilePage
  tileSize: number
  href: (z: number, x: number, y: number) => string
  onFail: () => void
}) {
  const [x0, y0, x1, y1] = region
  const rw = x1 - x0, rh = y1 - y0
  const [o, px, py] = regionCorners(corners, [x0, y0, x1, y1])
  const m = [(px[0] - o[0]) * w, (px[1] - o[1]) * h, (py[0] - o[0]) * w, (py[1] - o[1]) * h, o[0] * w, o[1] * h]
  const at = `matrix(${m.map((v) => v.toFixed(4)).join(' ')})`
  const drawnPx = Math.hypot(m[0], m[1]) // the REGION's width in board px – grows with the zoom
  const drawnPy = Math.hypot(m[2], m[3]) // …and its height
  const clipId = useId()
  const group = useRef<SVGGElement>(null)

  const under = useMemo(() => {
    const level = underlayLevel(page)
    return { z: level.z, tiles: visibleTiles(level, tileSize, [x0, y0, x1, y1]) }
  }, [page, tileSize, x0, y0, x1, y1])
  const [detail, setDetail] = useState<{ z: number; tiles: Tile[]; id: string } | null>(null)
  // the set before it, kept a moment under the new one: a level change goes sharp → sharp
  const [kept, setKept] = useState<{ z: number; tiles: Tile[]; id: string } | null>(null)
  const detailId = useRef('')
  const detailRef = useRef<typeof detail>(null)
  useEffect(() => {
    if (!kept) return
    const t = setTimeout(() => setKept(null), KEEP_MS)
    return () => clearTimeout(t)
  }, [kept])

  const density = Math.round((drawnPx / (rw * ptToMm(page.widthPt))) * 1000) / 1000
  useEffect(() => { if (density > 0) onDensity?.(density) }, [density]) // eslint-disable-line react-hooks/exhaustive-deps

  // after EVERY render: the board re-renders this on each pan and zoom, and where the storey sits
  // on the glass is only known from the DOM
  useLayoutEffect(() => {
    const t = setTimeout(() => {
      const g = group.current
      const ctm = g?.getScreenCTM()
      if (!g || !ctm) return
      const level = pickLevel(page, (drawnPx / rw) * DPR())
      let next: { z: number; tiles: Tile[]; id: string } | null = null
      if (level.z > under.z) {
        const inv = ctm.inverse()
        const pts = [[0, 0], [window.innerWidth, 0], [0, window.innerHeight], [window.innerWidth, window.innerHeight]]
          .map(([sx, sy]) => new DOMPoint(sx, sy).matrixTransform(inv))
        // the window in REGION units, clamped to the region, then said in page fractions
        const ux0 = Math.max(0, Math.min(...pts.map((p) => p.x))), ux1 = Math.min(1, Math.max(...pts.map((p) => p.x)))
        const uy0 = Math.max(0, Math.min(...pts.map((p) => p.y))), uy1 = Math.min(1, Math.max(...pts.map((p) => p.y)))
        const tiles = ux1 > ux0 && uy1 > uy0
          // no ring of margin here: six storeys would each pay for one, and the underlay
          // already covers the strip a pan uncovers
          ? visibleTiles(level, tileSize, [x0 + ux0 * rw, y0 + uy0 * rh, x0 + ux1 * rw, y0 + uy1 * rh])
          : []
        next = { z: level.z, tiles, id: `${level.z}:${tiles.map((t) => `${t.x}-${t.y}`).join(',')}` }
      }
      if ((next?.id ?? '') === detailId.current) return
      detailId.current = next?.id ?? ''
      if (detailRef.current && next && detailRef.current.z !== next.z) setKept(detailRef.current)
      detailRef.current = next
      setDetail(next)
    }, SETTLE_MS)
    return () => clearTimeout(t)
  })

  const image = (z: number, t: Tile, underlay: boolean) => (
    <image
      key={`${z}:${t.x}-${t.y}`}
      href={href(z, t.x, t.y)}
      x={(t.left - x0) / rw}
      y={(t.top - y0) / rh}
      // half a PIXEL of overlap, said in the group's units: neighbouring tiles land on fractional
      // device px and would show a hairline between them. ⚠️ In px, never a constant of the unit
      // square – at zoom 16 «0.0004» was 4 px of stretch, which nicked every line at a tile border.
      width={t.width / rw + 0.5 / Math.max(1, drawnPx)}
      height={t.height / rh + 0.5 / Math.max(1, drawnPy)}
      preserveAspectRatio="none"
      className="wb-floor-page"
      onError={underlay ? onFail : undefined}
    />
  )

  return (
    <g ref={group} transform={at}>
      <clipPath id={clipId}><rect width={1} height={1} /></clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect width={1} height={1} fill="#fff" />
        {under.tiles.map((t) => image(under.z, t, true))}
        {kept && kept.z !== detail?.z && kept.tiles.map((t) => image(kept.z, t, false))}
        {detail?.tiles.map((t) => image(detail.z, t, false))}
      </g>
    </g>
  )
}
