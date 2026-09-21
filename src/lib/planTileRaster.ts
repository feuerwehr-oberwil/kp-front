/**
 * A RASTER of a tiled sheet (or of one region of it), composed from the server's tiles.
 *
 * Several callers want pixels rather than a view: the Karte's plan backdrop, the image
 * «Automatisch ausrichten» uploads, the ink scan that trims a new Gebäude's frame. Each used to
 * take them from a pdf.js bake — one more multi-second walk over the page's display list and a
 * page-sized bitmap held for it (components/PdfViewport). For a sheet with a pyramid the same
 * pixels are a handful of small images away, so they are drawn from those instead; `null` means
 * «no pyramid here» and the caller keeps its pdf.js path.
 */
import {
  loadTileManifest, pickLevel, sheetLayout, sourcePages, tileSource, tileUrl, visibleTiles,
} from './planTiles'

type Clip = readonly [number, number, number, number]
const WHOLE: Clip = [0, 0, 1, 1]

async function tileImage(url: string): Promise<ImageBitmap> {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`tile ${res.status}`)
  return createImageBitmap(await res.blob())
}

/**
 * `clip` of the sheet behind `url` (fractions of the sheet as the BOARD lays it out — for a
 * single page that is the page), drawn `maxSide` px on its long side at most, on white.
 * Resolves null when the sheet has no tiles; REJECTS when it has but one could not be had.
 */
export async function composeTiles(url: string, clip: Clip = WHOLE, maxSide = 1800): Promise<HTMLCanvasElement | null> {
  const source = tileSource(url)
  if (!source || typeof createImageBitmap !== 'function') return null
  const manifest = await loadTileManifest(source).catch(() => null)
  if (!manifest) return null
  const layout = sheetLayout(sourcePages(manifest, source))
  const [cx0, cy0, cx1, cy1] = clip
  const cw = cx1 - cx0, ch = cy1 - cy0
  if (!(cw > 0) || !(ch > 0)) return null
  // the output's size: the clip's own shape, its long side at maxSide
  const shape = (ch * layout.aspect) / cw // height / width of the clip, in sheet units
  const outW = Math.max(1, Math.round(shape >= 1 ? maxSide / shape : maxSide))
  const outH = Math.max(1, Math.round(shape >= 1 ? maxSide : maxSide * shape))
  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d ctx')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, outW, outH)
  ctx.imageSmoothingQuality = 'high'
  for (const box of layout.boxes) {
    // this page's part of the clip, in PAGE fractions
    const rect: [number, number, number, number] = [
      Math.max(0, (cx0 - box.left) / box.width), Math.max(0, (cy0 - box.top) / box.height),
      Math.min(1, (cx1 - box.left) / box.width), Math.min(1, (cy1 - box.top) / box.height),
    ]
    if (rect[2] <= rect[0] || rect[3] <= rect[1]) continue
    // px the WHOLE page would span at the output's resolution — what the level has to cover
    const level = pickLevel(box.page, (outW / cw) * box.width)
    for (const t of visibleTiles(level, manifest.tileSize, rect)) {
      const bitmap = await tileImage(tileUrl(source, box.page.page, level.z, t.x, t.y))
      try {
        const sx = box.left + t.left * box.width, sy = box.top + t.top * box.height // sheet fractions
        ctx.drawImage(
          bitmap,
          ((sx - cx0) / cw) * outW, ((sy - cy0) / ch) * outH,
          ((t.width * box.width) / cw) * outW + 0.5, ((t.height * box.height) / ch) * outH + 0.5,
        )
      } finally {
        bitmap.close?.()
      }
    }
  }
  return canvas
}
