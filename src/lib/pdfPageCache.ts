/**
 * Rendered PDF pages, kept across an unmount.
 *
 * The plain multi-page reader (components/PdfScroller) rasterises every page of a document with
 * pdf.js and hangs the canvases in a column. That column dies with the component — and the
 * component dies on every tab switch (the Plan surface is mounted only while `mode === 'plans'`,
 * IncidentWorkspace) and on every document switch (`key={active.id}`). So coming back to an
 * «RWA» Referenz-PDF re-rasterised all of it, which on a tablet is seconds of white column and
 * reads exactly like a reload (18.09.2026).
 *
 * Rasterising is the expensive half; keeping the RESULT is cheap. Each finished page is snapshot
 * into an `ImageBitmap` and held here, keyed by document, page and the CSS width it was laid out
 * at (the zoom re-renders at a new width, so it gets its own entries). A reopen then blits from
 * the bitmap — a GPU copy, instant — instead of asking pdf.js again.
 *
 * ⚠️ Bounded by BYTES, and an evicted bitmap is CLOSED: an `ImageBitmap`'s pixels are not on the
 * JS heap, and on iOS the collection that would free them is the one that does not happen under
 * memory pressure (see lib/byteBudgetCache, components/PdfViewport · bitmapCache).
 */
import { ByteBudgetCache } from './byteBudgetCache'
import { pdfBytesKey } from './pdfBytes'
import { smallMemoryDevice } from './pdfRenderBudget'

/** One rendered page: document + page number + the CSS width it was laid out at. Rounded, so
 *  sub-pixel jitter in the column's measurement cannot mint a second copy of the same page. */
export const pdfPageKey = (url: string, page: number, cssW: number): string =>
  `${pdfBytesKey(url)}@${Math.max(1, Math.round(cssW))}#${page}`

/** Does this key belong to that document (any page, any width)? */
export const pdfPageKeyOf = (key: string, url: string): boolean => key.startsWith(`${pdfBytesKey(url)}@`)

/** What the kept page rasters may weigh together. Smaller than the board's bitmap budget: these
 *  sit BESIDE the on-screen canvases they were copied from, so the budget is paid twice while a
 *  document is open. */
const BUDGET_SMALL = 32 * 1024 * 1024
const BUDGET_DESKTOP = 128 * 1024 * 1024
const pageBudget = () => (smallMemoryDevice() ? BUDGET_SMALL : BUDGET_DESKTOP)

const pageCache = new ByteBudgetCache<ImageBitmap>(
  pageBudget,
  (b) => b.width * b.height * 4,
  (b) => b.close?.(),
)

/** The kept raster of one page, or undefined. ⚠️ The caller must tolerate a REJECTED promise and
 *  a bitmap closed between resolve and draw — both mean «render it again», never a throw. */
export const cachedPdfPage = (key: string): Promise<ImageBitmap> | undefined => pageCache.get(key)

/** Keep (or replace) one page's raster. A rejected snapshot drops out on its own. */
export const keepPdfPage = (key: string, bitmap: Promise<ImageBitmap>): void => pageCache.set(key, bitmap)

/** Snapshot a finished canvas, when the engine can — jsdom and old WebViews cannot, and there
 *  the reader simply keeps re-rendering as it did before. */
export function snapshotPdfPage(key: string, canvas: HTMLCanvasElement): void {
  if (typeof createImageBitmap !== 'function') return
  keepPdfPage(key, createImageBitmap(canvas))
}

/** Forget every kept page of one document — what «Erneut laden» means for this cache. */
export function dropPdfPages(url: string): void {
  for (const key of pageCache.keys()) {
    if (!pdfPageKeyOf(key, url)) continue
    const held = pageCache.get(key)
    pageCache.delete(key)
    void held?.then((b) => b.close?.(), () => {})
  }
}

/** Bytes currently kept, for tests and diagnostics. */
export const pdfPagesResident = () => pageCache.bytes
