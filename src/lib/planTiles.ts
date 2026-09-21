/**
 * A plan sheet as TILES (backend · app/plan_tiles) — the pure half: which level, which tiles,
 * where they lie, and how far the zoom may go.
 *
 * Why tiles at all (21.09.2026): pdf.js walks a page's whole display list on every render, so the
 * Gymnasium's A1 Modul 6 (357 000 paths) cost 4.5 s a pass on a desktop and well past 10 s on a
 * tablet — for the first paint, for each storey of the Gebäude, and again after every pan at
 * depth. Its room stamps are 0.29 mm tall on paper, which takes ~600 dpi to read: a 280 M px
 * raster nobody can hold, so the pixel budget (lib/pdfRenderBudget) capped it to mush. The server
 * renders each immutable revision ONCE into a pyramid instead, and what this device holds is a
 * screenful of 512-px images whatever the sheet's size or the zoom.
 *
 * A sheet without a pyramid (an unpinned URL, a bundled /public PDF, an older server, a long
 * reader document) answers `null` from `tileSource` / a 404 from the manifest, and every caller
 * keeps the pdf.js path it had.
 */
import { pdfBytesKey, pinnedPdfVersion } from './pdfBytes'
import { pdfPageOf } from './whiteboard'

export interface TileLevel { z: number; width: number; height: number; cols: number; rows: number }
export interface TilePage { page: number; widthPt: number; heightPt: number; levels: TileLevel[] }
export interface TileManifest { tileSize: number; pages: TilePage[]; complete: boolean }

/** What a plan URL says about its pyramid: the dataset's own address, the pinned revision, and
 *  the ONE page a floor sheet names (`#page=N`) — or null for the whole document, stitched. */
export interface TileSource { base: string; version: number; page: number | null }

/** Only a PINNED reference URL has tiles: the revision is part of a tile's address, which is
 *  what makes the address immutable (lib/pdfBytes · pinnedPdfVersion). */
export function tileSource(url: string): TileSource | null {
  const version = pinnedPdfVersion(url)
  const base = pdfBytesKey(url).split('?')[0]
  if (version == null || !base.startsWith('/api/reference/')) return null
  return { base, version, page: pdfPageOf(url) }
}

export const tileManifestUrl = (s: TileSource) => `${s.base}/tiles?v=${s.version}`
export const tileUrl = (s: TileSource, page: number, z: number, x: number, y: number) =>
  `${s.base}/tiles/${s.version}/${page}/${z}/${x}/${y}`

/** The pages a source shows: the one it names, else all of them. */
export const sourcePages = (m: TileManifest, s: TileSource): TilePage[] =>
  s.page == null ? m.pages : m.pages.filter((p) => p.page === Math.min(s.page!, m.pages.length - 1))

export interface PageBox { page: TilePage; left: number; top: number; width: number; height: number }

/**
 * Where each page lies on the board, as fractions of it — the SAME layout the pdf.js bake
 * stitched (components/PdfViewport · render): the board is as wide as the widest page, pages
 * run top-down, a narrower one is centred. ⚠️ Ink on a multi-page sheet is stored in these
 * fractions, so this must never drift from that function.
 */
export function sheetLayout(pages: TilePage[]): { aspect: number; boxes: PageBox[] } {
  const W = Math.max(...pages.map((p) => p.widthPt), 1)
  const H = pages.reduce((sum, p) => sum + p.heightPt, 0) || 1
  let y = 0
  const boxes = pages.map((page) => {
    const box = { page, left: (W - page.widthPt) / 2 / W, top: y / H, width: page.widthPt / W, height: page.heightPt / H }
    y += page.heightPt
    return box
  })
  return { aspect: H / W, boxes }
}

/**
 * A level is «enough» until it would be stretched by more than √2 — the rule every map library
 * uses. ⚠️ Measured, not taste (21.09.2026): insisting on ~1:1 picked the NEXT level at zoom 4 of
 * an A1, which drew the screen from 70 tiles at 1.6× oversampling — 76 MB decoded, on the devices
 * this whole file exists to spare. At √2 the same view is ~30 tiles, and a 1.2× stretch of line
 * art on a 2× screen is not something anybody can point at.
 */
const LEVEL_SLACK = Math.SQRT1_2

/** The level to show a page at, when it is drawn `devicePxAcross` device px wide: the smallest
 *  that still covers it, else the top one (past it the tiles are upscaled – soft, never blank). */
export function pickLevel(page: TilePage, devicePxAcross: number): TileLevel {
  return page.levels.find((l) => l.width >= devicePxAcross * LEVEL_SLACK) ?? page.levels[page.levels.length - 1]
}

/** The long side the always-mounted UNDERLAY may have: six tiles or so, ~4 MB decoded. It is
 *  what shows while sharper tiles are still on their way, so nothing ever blanks. */
const UNDERLAY_SIDE = 1280

export function underlayLevel(page: TilePage): TileLevel {
  const fits = page.levels.filter((l) => Math.max(l.width, l.height) <= UNDERLAY_SIDE)
  return fits[fits.length - 1] ?? page.levels[0]
}

export interface Tile { x: number; y: number; left: number; top: number; width: number; height: number }

/**
 * The tiles of `level` that touch `rect` (page-normalised, [x0, y0, x1, y1]), each with its box
 * as FRACTIONS of the page — the edge tiles of a level are narrower than `tileSize`, and saying
 * so in fractions is what lets the caller lay them out in any unit (CSS %, an SVG user unit).
 * `margin` tiles are added on every side: the ones a pan reaches next are already there.
 */
export function visibleTiles(
  level: TileLevel,
  tileSize: number,
  rect: readonly [number, number, number, number],
  margin = 0,
): Tile[] {
  const [x0, y0, x1, y1] = rect
  if (!(x1 > x0) || !(y1 > y0)) return []
  const c0 = Math.max(0, Math.floor((x0 * level.width) / tileSize) - margin)
  const c1 = Math.min(level.cols - 1, Math.ceil((x1 * level.width) / tileSize) - 1 + margin)
  const r0 = Math.max(0, Math.floor((y0 * level.height) / tileSize) - margin)
  const r1 = Math.min(level.rows - 1, Math.ceil((y1 * level.height) / tileSize) - 1 + margin)
  const out: Tile[] = []
  for (let y = r0; y <= r1; y++) {
    for (let x = c0; x <= c1; x++) {
      const px = x * tileSize, py = y * tileSize
      out.push({
        x, y,
        left: px / level.width,
        top: py / level.height,
        width: Math.min(tileSize, level.width - px) / level.width,
        height: Math.min(tileSize, level.height - py) / level.height,
      })
    }
  }
  return out
}

/** Every tile address of a source — what the per-object prefetch walks (lib/planTilePrefetch). */
export function allTileUrls(m: TileManifest, s: TileSource): string[] {
  const out: string[] = []
  for (const page of sourcePages(m, s)) {
    for (const level of page.levels) {
      for (let y = 0; y < level.rows; y++) for (let x = 0; x < level.cols; x++) out.push(tileUrl(s, page.page, level.z, x, y))
    }
  }
  return out
}

/** PDF points are 1/72 inch. */
export const ptToMm = (pt: number) => (pt / 72) * 25.4

/**
 * How many CSS px one PAPER millimetre may be magnified to. ~5× life size on a tablet
 * (a CSS px there is ~0.19 mm), which puts a 0.29 mm room stamp at about 1.5 mm on the glass —
 * the size below which nobody reads anything at arm's length.
 */
export const MAX_CSS_PX_PER_PAPER_MM = 28

/**
 * The zoom ceiling of a board whose drawing is `drawnCssPxAtFit` CSS px wide at scale 1 and
 * `paperMm` wide on paper.
 *
 * ⚠️ Why the ceiling follows the PAPER (21.09.2026): board scale is relative to «eingepasst», so
 * a fixed 8× meant 8× life size for an A4 and 1.4× for an A1 — the bigger and denser the sheet,
 * the LESS of it a zoom could reach, which is backwards. `floor` is the old constant: a small
 * sheet keeps exactly the zoom it had.
 */
export function paperMaxScale(drawnCssPxAtFit: number, paperMm: number, floor: number): number {
  if (!(drawnCssPxAtFit > 0) || !(paperMm > 0)) return floor
  return Math.max(floor, (MAX_CSS_PX_PER_PAPER_MM * paperMm) / drawnCssPxAtFit)
}

// ---------------------------------------------------------------------------------------------
// the manifest
// ---------------------------------------------------------------------------------------------

const manifests = new Map<string, Promise<TileManifest | null>>()

/**
 * One source's manifest, or null when it has no pyramid. Held for the session: the geometry
 * cannot change under a pinned revision. A NETWORK failure is not an answer and is not kept —
 * offline the service worker serves the cached copy, and with none the caller falls back to
 * pdf.js exactly as before.
 */
export function loadTileManifest(s: TileSource): Promise<TileManifest | null> {
  const key = tileManifestUrl(s)
  const held = manifests.get(key)
  if (held) return held
  const p = fetch(key, { credentials: 'same-origin' }).then(async (res) => {
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`tile manifest ${res.status}`)
    const doc = (await res.json()) as TileManifest
    return doc.pages?.length && doc.tileSize > 0 ? doc : null
  })
  p.catch(() => { if (manifests.get(key) === p) manifests.delete(key) })
  manifests.set(key, p)
  return p
}

/** «Erneut laden» / tests: ask again. */
export const dropTileManifest = (s: TileSource) => { manifests.delete(tileManifestUrl(s)) }
