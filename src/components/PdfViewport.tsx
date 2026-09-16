import { useEffect, useRef, useState } from 'react'
import type * as PdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { appConfig } from '../config/appConfig'
import { GIT_SHA } from '../lib/buildInfo'
import { ByteBudgetCache } from '../lib/byteBudgetCache'
import { diagnosePdfFailure, type PdfFailure } from '../lib/pdfDiagnosis'
// MAIN-THREAD side of the pdf.js engine polyfills (Samsung Internet, 08.09.) — static and
// first, so they are installed before the pdfjs chunk can resolve; the fake-worker fallback
// runs on this thread too. The real worker gets its own copy through the shim below.
import '../lib/pdfPolyfills'
// the worker BOOT SHIM as one bundled asset: polyfills + pdf.worker.min.mjs (lib/pdfWorkerEntry)
import pdfWorkerShimUrl from '../lib/pdfWorkerEntry?worker&url'
import { RetryButton } from './RetryButton'
import s from './PdfViewport.module.css'
import { pdfPageOf } from '../lib/whiteboard'
import { FLOOR_PAGE_SIDE, pageCanvasBudget, rasterSide, regionRaster, renderScale } from '../lib/pdfRenderBudget'

// The worker asset's URL, remembered for the diagnosis path: when a PDF fails, whether that
// file is still being served is the single most telling fact we can gather (lib/pdfDiagnosis).
// Stays null while the pdfjs chunk has never resolved — which is itself a diagnosis.
let workerUrl: string | null = null
export const pdfWorkerUrl = () => workerUrl

// pdfjs (+ its ~1.2 MB worker) is the single heaviest dependency in the app and is only
// needed on the Plan tab. Load it lazily via dynamic import() so it lands in its own chunk
// and never ships in the initial bundle — the PDF stack downloads on first plan render.
//
// ⚠️ `?worker&url` makes the worker its own EMITTED ASSET (pdfWorkerEntry-<hash>.js since
// 08.09., pdf.worker.min-<hash>.mjs before), not a chunk — so it has to be matched by the
// service worker's `globPatterns` BY EXTENSION. It was not (`.mjs` was missing) until
// 2026-08-25, which meant the one file the whole PDF stack cannot work without was the one
// file never precached: fetched from the server on every open, and gone from the server the
// moment the next deploy replaced its hash. Devices still on the old build — registerType is
// 'prompt', and an installed iOS app is never closed — then failed EVERY PDF while the rest
// of the app ran happily out of their precache.
let pdfjsPromise: Promise<typeof PdfjsLib> | null = null
function getPdfjs(): Promise<typeof PdfjsLib> {
  if (!pdfjsPromise) {
    const p = (async () => {
      // the worker boots through lib/pdfWorkerEntry (polyfills + the real worker, one bundled
      // asset) — never the bare pdf.worker.min.mjs, which throws on engines below ~Chrome 141
      const pdfjsLib = await import('pdfjs-dist')
      workerUrl = pdfWorkerShimUrl
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerShimUrl
      return pdfjsLib
    })()
    // a failed chunk load (brief offline moment) must not poison the app until a full
    // reload — drop the cached rejection so the next attempt re-imports
    p.catch(() => { if (pdfjsPromise === p) pdfjsPromise = null })
    pdfjsPromise = p
  }
  return pdfjsPromise
}

const LOAD_TIMEOUT_MS = 20_000 // stall guard on the doc open — pdf.js' own fetch has no timeout

// Doc cache entries keep the pdf.js loading task alongside the promise so a stuck or
// superseded load can be aborted (destroy cancels the underlying fetch). Failed loads
// self-evict — a transient error must be retryable, not replayed from the cache forever.
type DocEntry = { promise: Promise<PDFDocumentProxy>; destroy: () => void }
const docCache = new Map<string, DocEntry>()
/** one pdf.js document per PDF, whichever `#page=N` sheet asked – the fragment names a page
 *  of the same bytes (lib/whiteboard · pdfPageOf); every BITMAP cache stays keyed by the full URL */
const docKey = (url: string) => url.replace(/#.*$/, '')
function docEntry(rawUrl: string): DocEntry {
  const url = docKey(rawUrl)
  let e = docCache.get(url)
  if (!e) {
    let dead = false
    let task: PdfjsLib.PDFDocumentLoadingTask | null = null
    const promise = getPdfjs().then((lib) => {
      task = lib.getDocument({ url })
      if (dead) void task.destroy()
      return task.promise
    })
    const entry: DocEntry = {
      promise,
      destroy: () => {
        dead = true
        void task?.destroy().catch(() => {})
        if (docCache.get(url) === entry) docCache.delete(url)
      },
    }
    promise.catch(() => { if (docCache.get(url) === entry) docCache.delete(url) })
    docCache.set(url, entry)
    e = entry
  }
  return e
}
export function loadDoc(url: string) { return docEntry(url).promise }

// Doc open with the stall guard: a request that hangs (tablet radio limbo) would pin
// «PDF wird geladen…» forever — after LOAD_TIMEOUT_MS the entry is destroyed + evicted,
// so the next attempt (auto or «Erneut laden») starts a fresh fetch.
export function loadDocTimed(url: string): Promise<PDFDocumentProxy> {
  const e = docEntry(url)
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { e.destroy(); reject(new Error('pdf load timeout')) }, LOAD_TIMEOUT_MS)
    e.promise.then(
      (doc) => { clearTimeout(t); resolve(doc) },
      (err) => { clearTimeout(t); reject(err) },
    )
  })
}

/**
 * The sheet's ground height in metres, read off its own printed «1:NNN» scale.
 *
 * The LAST textual `1:NNN` on page 1 (the FireGIS sheets print it in the footer; a page with
 * several drawings/scales is ambiguous and the last one matched every tested sheet — the same
 * heuristic the auto-alignment experiment validated). PDF points are 1/72 inch, so the page's
 * physical height × the printed denominator is the ground distance the sheet's full height
 * covers — exactly the `mPerU` semantics of the plan calibration (planScale.ts), and per-sheet
 * truth where a station-default calibration can silently be the WRONG module's scale.
 * Null when no scale text is found (a scan, a foreign template).
 */
export async function planPrintedMPerU(url: string): Promise<number | null> {
  const doc = await loadDocTimed(url)
  const page = await doc.getPage((pdfPageOf(url) ?? 0) + 1)
  const tc = await page.getTextContent()
  const text = tc.items.map((it) => ('str' in it ? it.str : '')).join(' ')
  const found = [...text.matchAll(/1\s*:\s*(\d{3,5})\b/g)]
  if (!found.length) return null
  const den = Number(found[found.length - 1][1])
  const vp = page.getViewport({ scale: 1 })
  if (!(vp.height > 0)) return null
  return den * (vp.height / 72) * 0.0254
}

// Forget everything cached for one plan URL — the «Erneut laden» tap goes through here
// so the re-bake starts from a clean fetch instead of a stuck/rejected promise. The page
// raster, every region raster of it and the data URLs made from them: a retry that left a
// stale JPEG behind would redraw exactly the picture the operator asked to be rid of.
export function evictPlan(url: string) {
  docCache.get(docKey(url))?.destroy()
  bitmapCache.delete(url)
  for (const key of [...previewCache.keys()]) if (key.startsWith(`${url}@`)) previewCache.delete(key)
}

/**
 * The load state both PDF surfaces run on — this viewport (the plan on the board) and the
 * PdfScroller column. Same three facts, same recovery, and they were written twice:
 *
 *  · `status` / `fail`, which the placeholder reads;
 *  · `slow`, the «Erneut laden» button surfacing only once a load has been pending for a while
 *    — the cached and prewarmed fast paths must never flash it;
 *  · `retry()`, which busts every cache for this document (`evictPlan`) and re-bakes. Before it
 *    existed only a full page reload cleared the module-level caches, which mid-Einsatz means
 *    leaving the app to get a plan back.
 *
 * `attempt` is the re-run key: bump it and the caller's own load effect starts over.
 */
export function usePdfLoad(url: string) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [fail, setFail] = useState<PdfFailure | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    if (status !== 'loading') { setSlow(false); return }
    setSlow(false)
    const t = setTimeout(() => setSlow(true), RETRY_AFTER_MS)
    return () => clearTimeout(t)
  }, [status, url, attempt])

  const retry = () => {
    evictPlan(url)
    setStatus('loading')
    setFail(null)
    setAttempt((a) => a + 1)
  }

  return { status, setStatus, fail, setFail, attempt, slow, retry }
}

interface Props {
  url: string
  fitW: number
  fitH: number
  scale: number
  pos: { x: number; y: number }
  vw: number
  vh: number
  onAspect: (a: number) => void
}

const BASE_HEADROOM = 1.4 // bake the page a bit above display res so panning + small zooms stay crisp from the cached bitmap alone
const REFINE_FROM = 1.15  // engage the full-res pass just past the base bitmap's crisp range, so there's no blurry dead zone between base and refine
const SETTLE_MS = 40      // re-raster quickly after the view settles (kept non-zero so a continuous zoom gesture doesn't thrash pdf.js)
export const RETRY_AFTER_MS = 5_000 // show «Erneut laden» once a load has been pending this long
const MAX_COMPOSITE_PX = 12000 // ceiling on the stitched bitmap's long side (browser canvas limit safety for many-page plans)
// Width (px) a plan is baked at when it is NOT the active plan or one of its rail neighbours —
// enough for the blurry first paint a switch shows while the full bake runs, ~5 MB instead of
// up to ~83 MB. `bake` upgrades it the first time a viewport asks for more.
const PREVIEW_SIDE = 1024
const DPR = () => Math.min(window.devicePixelRatio || 1, 2)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

type Baked = { bitmap: ImageBitmap; aspect: number; side: number; pages: number }

// What the resident bitmaps may weigh together. ⚠️ Bytes, not a count: one stitched A4 plan at
// 3840 px on an iPad is ~83 MB, and the old cap of twelve bitmaps allowed close to a gigabyte —
// allocated by the prewarm before the operator had opened the Plan tab, at which point iOS
// reclaimed the tab. Read live at every eviction, so a phone-sized viewport gets the small one.
const BUDGET_TABLET = 200 * 1024 * 1024
const BUDGET_PHONE = 60 * 1024 * 1024
const bitmapBudget = () =>
  (typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches ? BUDGET_PHONE : BUDGET_TABLET)
const bitmapBytes = (b: Baked) => b.bitmap.width * b.bitmap.height * 4

// One baked bitmap per document, held in memory. A multi-page plan (e.g. Modul 6 Geschosspläne)
// is STITCHED into a single tall bitmap — page 1 at the bottom, later pages stacked above (like
// the Gebäude floor-stack) — so the whole plan scrolls/zooms as one board. The first render is the
// ONLY pdf.js rasterization for normal viewing; open / switch / pan / zoom are served from this
// bitmap (a GPU blit + CSS transform), so they're instant. Keyed by url; memory-bounded by the
// byte budget above (LRU; a rejected bake drops out on its own so a failed load can be retried).
// ⚠️ …and an evicted bitmap is CLOSED, not merely forgotten: an ImageBitmap's pixels are not
// the JS heap's, and on iOS the collection that would free them is exactly what does not happen
// under memory pressure. Every reader draws it inside the `.then` of the promise it holds, so
// the two paint sites guard against the one race this opens (a bitmap evicted between resolve
// and draw) by falling back to no paint rather than throwing.
const bitmapCache = new ByteBudgetCache<Baked>(bitmapBudget, bitmapBytes, (b) => b.bitmap.close?.())

// Compute the contain-fit of a page (h/w aspect) inside the viewport, then the
// pixel width to bake at — display size × dpr × headroom, rounded to a step so
// minor viewport jitter doesn't spawn endless re-renders.
function targetSide(aspect: number, vw: number, vh: number) {
  const byW = { w: vw, h: vw * aspect }
  const fit = byW.h <= vh ? byW : { w: vh / aspect, h: vh }
  const px = fit.w * DPR() * BASE_HEADROOM
  // clamp: floor keeps tiny viewports usable, ceiling bounds memory (~40MB/page);
  // deeper zoom past what this resolves is handled crisply by the refine pass
  return Math.min(4096, Math.max(640, Math.round(px / 128) * 128))
}

// Rasterize the document once at the given fit and cache the bitmap. Concurrent/repeat
// callers share the in-flight promise. Re-bakes only if a larger size is asked
// for (e.g. the window grew, or a preview bake meets its first real viewport); shrinking
// reuses the crisper bitmap. `maxSide` caps the bake width — the prewarm's preview size.
function bake(url: string, vw: number, vh: number, maxSide = Infinity, budgetPx = pageCanvasBudget()): Promise<Baked> {
  const existing = bitmapCache.get(url) // a read touches the entry (LRU)
  if (existing) {
    // keep if it's already at least as crisp as we'd now ask for — measured through the SAME
    // capped width the render uses, or a budget-capped bake reads as stale on every open
    const want = (a: number) => bakeWidth(a, vw, vh, maxSide, budgetPx)
    const reuse = existing.then((b) => (b.side >= want(b.aspect) - 0.5 ? b : Promise.reject('stale')))
    // fall through to re-bake only on the stale rejection
    const p = reuse.catch(() => render(url, vw, vh, maxSide, budgetPx))
    bitmapCache.set(url, p)
    return p
  }
  const p = render(url, vw, vh, maxSide, budgetPx)
  bitmapCache.set(url, p)
  return p
}

/** The bake already held for `url`, whatever its size — a stale preview is still a first paint. */
const cachedBake = (url: string) => bitmapCache.get(url)

/** The matcher's working resolution (A4 @ 150 dpi ≈ 1755 px long side) — the server normalizes
 *  to it anyway, so baking finer only burns time. */
const MATCHER_SIDE = 1755

/**
 * The raster «Automatisch ausrichten» uploads, as a JPEG blob.
 *
 * ⚠️ REUSES the resident bake whenever one is crisp enough: the operator is LOOKING at this
 * sheet, so its bitmap is normally already in `bitmapCache` — encoding it costs a fraction of a
 * second. Only a cold sheet is rasterized, and then CAPPED at the matcher's own resolution:
 * `planPreviewUrl`'s display-oriented path bakes at display × DPR × headroom (4096 px on a
 * retina screen), which is exactly what made «Plan rendern» take forever.
 */
export async function planMatcherImage(url: string): Promise<Blob> {
  const resident = await cachedBake(url)?.catch(() => null)
  const baked = resident && Math.max(resident.bitmap.width, resident.bitmap.height) >= 1200
    ? resident
    : await bake(url, MATCHER_SIDE, MATCHER_SIDE, MATCHER_SIDE)
  const k = Math.min(1, MATCHER_SIDE / Math.max(baked.bitmap.width, baked.bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(baked.bitmap.width * k))
  canvas.height = Math.max(1, Math.round(baked.bitmap.height * k))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d ctx')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(baked.bitmap, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86))
  canvas.width = canvas.height = 0
  if (!blob) throw new Error('jpeg encode failed')
  return blob
}

/**
 * The stitched bitmap's WIDTH in px: what the display asks for, capped by the many-page ceiling
 * and then by the app's one pixel budget (lib/pdfRenderBudget). ⚠️ The budget applies to the
 * WHOLE stitched canvas — it is one canvas holding every page — and the caller says how much of
 * it this document may have: a Gebäude floor-stack hands each storey the stack's Nth share,
 * because five storeys are five bitmaps held at once.
 *
 * Shared by `render` and by `bake`'s reuse check, or a budget-capped bake would look «too small»
 * to the next caller and be re-rendered on every open.
 */
function bakeWidth(aspect: number, vw: number, vh: number, maxSide: number, budgetPx: number): number {
  const want = Math.min(targetSide(aspect, vw, vh), maxSide, MAX_COMPOSITE_PX / Math.max(0.001, aspect))
  return renderScale(1, aspect, want, 1, budgetPx) // a 1 × aspect page: the scale IS the width
}

function render(url: string, vw: number, vh: number, maxSide: number, budgetPx: number): Promise<Baked> {
  return loadDocTimed(url).then(async (pdf) => {
    // a floor sheet (`#page=N`) is ONE page of the pack; anything else is the whole document
    const only = pdfPageOf(url)
    const pageNos = only != null ? [Math.min(only, pdf.numPages - 1) + 1] : Array.from({ length: pdf.numPages }, (_, i) => i + 1)
    const n = pageNos.length
    // measure every page; stitched width is the widest page, height is the sum
    const metas: { page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>; w: number; h: number }[] = []
    let W = 0, totalH = 0
    for (const i of pageNos) {
      const pg = await pdf.getPage(i)
      const vp = pg.getViewport({ scale: 1 })
      metas.push({ page: pg, w: vp.width, h: vp.height })
      W = Math.max(W, vp.width)
      totalH += vp.height
    }
    const aspect = totalH / W
    // ⚠️ `targetSide` asks for display × DPR × headroom, which on an A1 Geschossplan
    // (1684 × 2384 pt) is a 4096 × 5799 canvas: 23.7 M px — past what iOS Safari will draw into
    // at all AND 95 MB of RGBA, per storey of a floor stack. Past the budget the bitmap is
    // simply softer than the screen; that is a trade a crash does not offer.
    const side = bakeWidth(aspect, vw, vh, maxSide, budgetPx) // stitched bitmap WIDTH in px
    const k = side / W
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(side)
    canvas.height = Math.round(totalH * k)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d ctx')
    // top-down, as the PDF reads: page 1 at the top, each later page below it (14.09.2026 – it
    // used to stack bottom-up, which showed a multi-page Zusatz sheet in reverse)
    let yTop = 0
    for (const m of metas) {
      const vp = m.page.getViewport({ scale: k })
      const pw = Math.round(vp.width), ph = Math.round(vp.height)
      // ⚠️ A single-page sheet renders STRAIGHT into the stitched canvas. The scratch canvas
      // doubles the peak (two full-size RGBA buffers plus the ImageBitmap that follows), and a
      // document of one page — every Modul sheet and every floor of a pack — never needed it.
      if (n === 1) {
        await m.page.render({ canvas, canvasContext: ctx, viewport: vp }).promise
        m.page.cleanup() // the page's own render internals; the doc is SHARED across storey sheets
        yTop += ph
        continue
      }
      const tmp = document.createElement('canvas')
      tmp.width = pw; tmp.height = ph
      const tctx = tmp.getContext('2d')
      if (tctx) {
        await m.page.render({ canvas: tmp, canvasContext: tctx, viewport: vp }).promise
        m.page.cleanup()
        ctx.drawImage(tmp, Math.round((side - pw) / 2), yTop)
        yTop += ph
      }
      tmp.width = tmp.height = 0 // release the scratch buffer now, not at the next GC
    }
    const bitmap = await createImageBitmap(canvas)
    // the bitmap owns the pixels from here; zeroing the canvas hands its backing store back
    // immediately instead of waiting for a collection that an iOS tab may not get to
    canvas.width = canvas.height = 0
    return { bitmap, aspect, side, pages: n }
  })
}

// Warm the plans' bitmaps in the background, one at a time so they never contend with the
// active document's render. The plans in `near` (the active one and its rail neighbours) are
// baked at the given viewport, so a switch to them is an instant crisp blit; every other plan
// gets a PREVIEW_SIDE bake that the first real open upgrades — see `bake`. A plan already held
// at any size is left alone unless it is in `near` and its bake is smaller than the viewport asks.
// Previews go first: they are cheap, and baking the big ones LAST leaves them the most recently
// used entries, so the byte budget evicts a preview before it evicts the active plan.
let warmQueue: Promise<unknown> = Promise.resolve()
export function prewarmPlans(urls: string[], vw: number, vh: number, near: string[] = []) {
  if (!vw || !vh) return
  const full = new Set(near)
  const order = [...urls.filter((u) => !full.has(u)), ...urls.filter((u) => full.has(u))]
  for (const url of order) {
    if (!full.has(url) && bitmapCache.has(url)) continue
    warmQueue = warmQueue.then(() => bake(url, vw, vh, full.has(url) ? Infinity : PREVIEW_SIDE).catch(() => {}))
  }
}

// A georeferenced sheet can be shown as an ordinary raster layer on the Lage map. Reuse the
// exact baked bitmap the whiteboard already owns; rendering the PDF again would double both the
// wait and the memory. Data URLs are cached because MapLibre may rebuild its image source after
// a WebGL recovery, while the underlying sheet has not changed.
// Keyed by url AND bake size, not by url alone: `bake` re-renders when a LARGER viewport is
// asked for, so a url-only key froze every later caller at the resolution of whichever one
// happened to run first (a preview requested from a narrow window stayed blurry after rotating).
// Capped small because these are full-size JPEG data URLs (up to 1800px, ~0.5–2 MB of base64
// each) and the only caller keeps at most a couple alive: one per plan whose Ebenen backdrop row
// is on, and a rotation adds a second key per plan. 4 covers two visible sheets in both
// orientations; anything older is cheaper to re-bake than to hold.
// ⚠️ 8, not 4, and it has to stay ≥ the storeys of a floor stack: five keys in a four-slot map
// evict one on every render and re-bake it forever. What was dangerous about the stack was never
// the COUNT but the SIZE — 3600 px a storey; every entry is now bounded by the render budget
// (lib/pdfRenderBudget), the stack's storeys sharing one document's worth of it.
const PREVIEW_CAP = 8
const previewCache = new Map<string, Promise<string>>()
export function planPreviewUrl(url: string, vw: number, vh: number, maxSide = 1800, budgetPx = pageCanvasBudget()): Promise<string> {
  const bw = Math.max(vw, 900), bh = Math.max(vh, 900)
  const key = `${url}@${bw}x${bh}@${maxSide}`
  const cached = previewCache.get(key)
  // touch for LRU — an entry still being asked for is the last one that should be dropped
  if (cached) { previewCache.delete(key); previewCache.set(key, cached); return cached }
  const p = bake(url, bw, bh, maxSide, budgetPx).then((b) => {
    // ⚠️ The DECODED image is what this costs, not the base64 string: every <img>/<image> that
    // points at the data URL holds one, and the Gebäude stack points one per storey at it. So
    // the same budget that bounds the bake bounds this raster too (lib/pdfRenderBudget).
    const k = Math.min(1, Math.min(maxSide, rasterSide(b.aspect, budgetPx)) / Math.max(b.bitmap.width, b.bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(b.bitmap.width * k))
    canvas.height = Math.max(1, Math.round(b.bitmap.height * k))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d ctx')
    ctx.drawImage(b.bitmap, 0, 0, canvas.width, canvas.height) // throws if evicted+closed: the
    // promise then rejects, this key self-evicts, and the next ask re-bakes — see previewCache
    const out = canvas.toDataURL('image/jpeg', 0.86)
    canvas.width = canvas.height = 0 // the JPEG holds the pixels now
    return out
  })
  p.catch(() => { if (previewCache.get(key) === p) previewCache.delete(key) })
  previewCache.set(key, p)
  while (previewCache.size > PREVIEW_CAP) {
    const oldest = previewCache.keys().next().value
    if (oldest === undefined) break
    previewCache.delete(oldest) // the data URL is GC'd once no map source holds it
  }
  return p
}

/**
 * ONE REGION of a page as a JPEG data URL — a Gebäude storey tile's SHARP picture.
 *
 * ⚠️ Since 16.09.2026 this is the refinement, not the first paint: the tile comes up from
 * `planRegionCropUrl` (the page's own bake, cut to the region) and asks for this only once it is
 * drawn bigger than that crop. The reason is the pass, not the pixels — see there.
 *
 * Not `planPreviewUrl` + a clip-path: a storey that covers a fifth of an A1 got a fifth of the
 * page raster's pixels, so the stack read visibly softer than the very same sheet opened whole
 * on Modul 6 (Bastian, 16.09.2026). Here pdf.js draws into a canvas the size of the REGION, the
 * rest of the page shifted off it by the viewport's offset — no full-page buffer is allocated at
 * any moment, and the region spends the whole budget the page used to (lib/pdfRenderBudget ·
 * `regionRaster`). `budgetPx` is the caller's share: a stack passes the document budget divided
 * by its storeys, so the SUM over the tiles is what one page was allowed.
 *
 * ⚠️ No ImageBitmap in between. The tile wants a data URL, and a resident bitmap beside the
 * JPEG's decoded copy is the same pixels held twice — on the one surface that holds them per
 * storey. The transient canvas is handed back the instant the JPEG has the pixels.
 *
 * ⚠️ Renders are SERIALISED — five storeys rasterising at once is five peaks at the same
 * moment, and pdf.js hands them to one worker anyway. `alive` is asked again at the head of the
 * queue, so a stack torn down mid-bake never starts the storeys still waiting behind it (the one
 * already in the engine is left to finish; it is a single region, and cancelling it saves less
 * than a half-drawn canvas costs).
 */
export function planRegionUrl(
  url: string,
  clip: readonly [number, number, number, number],
  budgetPx = pageCanvasBudget(),
  maxSide = FLOOR_PAGE_SIDE,
  alive: () => boolean = () => true,
): Promise<string> {
  const key = `${url}@${clip.map((v) => v.toFixed(4)).join(',')}@${maxSide}@${Math.round(budgetPx)}`
  const cached = previewCache.get(key)
  if (cached) { previewCache.delete(key); previewCache.set(key, cached); return cached } // touch for LRU
  const p = regionQueue.then(() => {
    if (!alive()) throw new Error('region bake dropped')
    return renderRegion(url, clip, budgetPx, maxSide)
  })
  regionQueue = p.catch(() => {}) // one rejection must not break the queue for the storeys behind it
  p.catch(() => { if (previewCache.get(key) === p) previewCache.delete(key) })
  previewCache.set(key, p)
  while (previewCache.size > PREVIEW_CAP) {
    const oldest = previewCache.keys().next().value
    if (oldest === undefined) break
    previewCache.delete(oldest)
  }
  return p
}

let regionQueue: Promise<unknown> = Promise.resolve()

async function renderRegion(
  url: string,
  clip: readonly [number, number, number, number],
  budgetPx: number,
  maxSide: number,
): Promise<string> {
  const pdf = await loadDocTimed(url)
  // the page of the floor pack this sheet names (`#page=N`); the DOCUMENT is shared across the
  // stack's storeys, so only the page's own render internals are ever released below
  const page = await pdf.getPage((pdfPageOf(url) ?? 0) + 1)
  let task: ReturnType<typeof page.render> | null = null
  let done = false
  try {
    const base = page.getViewport({ scale: 1 })
    const r = regionRaster(base.width, base.height, clip, budgetPx, maxSide)
    const canvas = document.createElement('canvas')
    canvas.width = r.width
    canvas.height = r.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d ctx')
    task = page.render({
      canvas,
      canvasContext: ctx,
      viewport: page.getViewport({ scale: r.scale, offsetX: r.offsetX, offsetY: r.offsetY }),
    })
    await task.promise
    done = true
    const out = canvas.toDataURL('image/jpeg', 0.86)
    canvas.width = canvas.height = 0 // the JPEG holds the pixels now
    return out
  } finally {
    if (!done) task?.cancel() // a failed or timed-out bake must not leave pdf.js drawing
    page.cleanup()
  }
}

/**
 * ONE REGION of a page, cut out of the page's OWN bake — the storey tile's first picture.
 *
 * ⚠️ This exists because of what a dense sheet costs to RENDER, not what it costs to store.
 * pdf.js walks the whole page's display list on every render call, whatever size canvas it is
 * drawing into: the BLT Tramdepot's A1 measures ~2 s per pass at 40 dpi and at 200 dpi alike. Its
 * pack is six drawings on that one page, so a stack that renders each region separately pays six
 * passes before it is complete, while «Modul 6» — the same PDF, opened as a sheet — pays one
 * (Bastian, 16.09.2026: «taking a bit too long for comfort, especially compared to just Modul 6»).
 *
 * So the tiles come up from a single page bake (the cache every other surface uses, so a prewarm
 * or an already-open Modul 6 makes it free), cropped per region — a blit, no display list. The
 * sharp per-region render still happens, behind them: `FloorPage` swaps it in when it lands.
 */
export async function planRegionCropUrl(url: string, clip: InkBox): Promise<RegionCrop> {
  const key = `crop@${url}@${clip.map((v) => v.toFixed(4)).join(',')}`
  const cached = cropCache.get(key)
  if (cached) { cropCache.delete(key); cropCache.set(key, cached); return cached }
  const p = (async () => {
    const baked = await bake(url, CROP_BAKE_SIDE, CROP_BAKE_SIDE)
    return cropBitmap(baked.bitmap, clip, Infinity)
  })()
  p.catch(() => { if (cropCache.get(key) === p) cropCache.delete(key) })
  cropCache.set(key, p)
  while (cropCache.size > PREVIEW_CAP) {
    const oldest = cropCache.keys().next().value
    if (oldest === undefined) break
    cropCache.delete(oldest)
  }
  return p
}

/** A region cut from the page bake: the picture, and how many pixels wide it actually is — which
 *  is what tells the tile whether the screen has outgrown it (components/FloorPage). */
export interface RegionCrop { url: string; width: number }
const cropCache = new Map<string, Promise<RegionCrop>>()

/** The viewport the crop bake asks for: big enough that the largest region of a sheet is sharp at
 *  a fitted stack, and bounded by the same budget every other bake respects. */
const CROP_BAKE_SIDE = 4096

/** One region of a baked page as a JPEG data URL, optionally shrunk to `maxSide`. White first: a
 *  PDF page is transparent where nothing is drawn, and a JPEG has no alpha to keep it that way. */
function cropCanvas(bitmap: ImageBitmap, clip: InkBox, maxSide: number): HTMLCanvasElement {
  const [x0, y0, x1, y1] = clip
  const sx = Math.max(0, Math.round(x0 * bitmap.width)), sy = Math.max(0, Math.round(y0 * bitmap.height))
  const sw = Math.max(1, Math.round((x1 - x0) * bitmap.width)), sh = Math.max(1, Math.round((y1 - y0) * bitmap.height))
  const k = Math.min(1, maxSide / Math.max(sw, sh))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * k))
  canvas.height = Math.max(1, Math.round(sh * k))
  const ctx = canvas.getContext('2d', { willReadFrequently: maxSide < Infinity })
  if (!ctx) throw new Error('no 2d ctx')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return canvas
}

function cropBitmap(bitmap: ImageBitmap, clip: InkBox, maxSide: number): RegionCrop {
  const canvas = cropCanvas(bitmap, clip, maxSide)
  const out = { url: canvas.toDataURL('image/jpeg', 0.86), width: canvas.width }
  canvas.width = canvas.height = 0
  return out
}

/** how wide the throwaway canvas an ink scan renders into may be – enough that a 1 pt line still
 *  lands on a pixel, small enough that four storeys cost one page raster between them */
const INK_SCAN_SIDE = 360
/** a pixel this dark (0..255, any channel) counts as drawing rather than paper. Deliberately
 *  generous: a scan's grey ground sits around 245, a plotted hairline well under 200. */
const INK_LEVEL = 232

const inkCache = new Map<string, Promise<InkBox | null>>()
export type InkBox = readonly [number, number, number, number]

/**
 * The bounding box of what is actually DRAWN inside a page region, in the page's own normalized
 * coordinates — or null when the region is blank, could not be rendered, or the browser refuses
 * to hand back the pixels.
 *
 * The Gebäude stack's tiles all show ONE frame (lib/floorPackBinding), and that frame used to be
 * the reference drawing's rectangle as somebody drew it in the admin: every millimetre of paper
 * margin around the drawings was then paper margin on every storey tile, multiplied by the storey
 * count. This measures where the ink stops, so the frame can be trimmed to it once, when the stack
 * is created (IncidentWorkspace).
 *
 * ⚠️ Scanned sheets: a hard border or a stamp in the corner IS ink and will hold the box open.
 * That is the honest answer — a trim that guessed which ink is «real» would eventually cut a
 * drawing in half, and nothing here may ever do that.
 */
export function regionInkBox(url: string, clip: InkBox): Promise<InkBox | null> {
  const key = `${url}@${clip.map((v) => v.toFixed(4)).join(',')}`
  const cached = inkCache.get(key)
  if (cached) return cached
  const p = scanRegionInk(url, clip).catch(() => null)
  inkCache.set(key, p)
  return p
}

/** ⚠️ Reads the page's own bake — the same one the tiles are cropped from — instead of rendering
 *  the region again. Measuring six drawings used to be six passes over the display list ON TOP of
 *  the six the tiles cost, which is what made a marked A1 slower to open than the plain sheet
 *  (16.09.2026). From the bake it is a blit and a pixel walk over at most a few hundred px. */
async function scanRegionInk(url: string, clip: InkBox): Promise<InkBox | null> {
  const baked = await bake(url, CROP_BAKE_SIDE, CROP_BAKE_SIDE)
  const canvas = cropCanvas(baked.bitmap, clip, INK_SCAN_SIDE)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const { width, height } = canvas
  const { data } = ctx.getImageData(0, 0, width, height)
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (data[i] > INK_LEVEL && data[i + 1] > INK_LEVEL && data[i + 2] > INK_LEVEL) continue
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
  canvas.width = canvas.height = 0
  if (maxX < 0) return null // an empty region trims to nothing, and says so
  const [cx0, cy0, cx1, cy1] = clip
  const sx = (cx1 - cx0) / width, sy = (cy1 - cy0) / height
  // …one scan pixel of air on every side, so the trim never shaves the outermost stroke
  return [
    cx0 + Math.max(0, minX - 1) * sx, cy0 + Math.max(0, minY - 1) * sy,
    cx0 + Math.min(width, maxX + 2) * sx, cy0 + Math.min(height, maxY + 2) * sy,
  ]
}

// Two board-child canvases (they pan/zoom with the board via CSS — instant, no
// per-gesture re-raster). BASE blits the cached page bitmap (rasterized once,
// reused forever). REFINE re-renders only the visible region at full resolution
// when zoomed in deep, after the view settles — the base shows underneath so
// nothing ever blanks. (Refine is single-page only; a stitched multi-page plan
// is served from the base bitmap alone.)
export function PdfViewport({ url, fitW, fitH, scale, pos, vw, vh, onAspect }: Props) {
  const baseRef = useRef<HTMLCanvasElement>(null)
  const refineRef = useRef<HTMLCanvasElement>(null)
  const refineTask = useRef<{ cancel: () => void } | null>(null)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [pages, setPages] = useState(1)
  // cold-load status: an uncached first render takes a moment (pdf.js chunk + rasterize) and
  // used to show a silently blank board — surface a lightweight placeholder until the first
  // bitmap paints (mirrors PdfScroller's status line). Reset per document during render
  // (the adjust-state-on-prop-change pattern, no extra effect pass).
  const { status, setStatus, fail, setFail, attempt, slow, retry } = usePdfLoad(url)
  const [statusUrl, setStatusUrl] = useState(url)
  if (url !== statusUrl) { setStatusUrl(url); setStatus('loading'); setFail(null) }

  // base — blit the baked bitmap (instant if cached/prewarmed; a single render otherwise).
  // A plan the prewarm only holds as a small preview paints THAT first, so the switch shows the
  // sheet at once (blurry) and sharpens when the full bake lands, instead of «PDF wird geladen…».
  useEffect(() => {
    if (!vw || !vh) return
    let cancelled = false
    let painted: Baked | null = null
    const paint = (b: Baked) => {
      const { bitmap, aspect, pages: n } = b
      painted = b
      onAspect(aspect)
      setPages(n)
      const canvas = baseRef.current
      if (!canvas) return
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      try { canvas.getContext('2d')?.drawImage(bitmap, 0, 0) } catch { return } // evicted + closed under us
      setStatus('ready')
    }
    const stale = cachedBake(url)
    const fresh = bake(url, vw, vh)
    if (stale && stale !== fresh) stale.then((b) => { if (!cancelled && !painted) paint(b) }).catch(() => {})
    fresh
      .then((b) => {
        if (cancelled || painted === b) return // the reused crisp bake is already on the canvas
        paint(b)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setStatus('error')
        void diagnosePdfFailure(err, pdfWorkerUrl()).then((f) => { if (!cancelled) setFail(f) })
      })
    return () => { cancelled = true }
  }, [url, vw, vh, attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  // refine — visible region at full zoom resolution, on settle, only when zoomed deep (single-page
  // plans only; a stitched multi-page plan stays on its base bitmap)
  useEffect(() => {
    // The refine canvas is positioned in absolute scaled px, so the instant the view
    // changes (pinch/pan) its old rect is misaligned with the freshly laid-out base —
    // which reads as a second, offset copy of the plan. Drop it immediately on every
    // view change; the base shows underneath (never blanks) and the sharp overlay
    // reappears only once it's re-rendered at the new scale/pos below.
    setRect(null)
    if (scale <= REFINE_FROM || pages > 1 || !vw || !vh || !fitW) return
    let cancelled = false
    const t = setTimeout(() => {
      loadDoc(url)
        .then(async (pdf) => {
          const page = await pdf.getPage((pdfPageOf(url) ?? 0) + 1)
          if (cancelled) return
          const base = page.getViewport({ scale: 1 })
          const nx0 = clamp01((-vw / 2 - pos.x) / (scale * fitW) + 0.5)
          const nx1 = clamp01((vw / 2 - pos.x) / (scale * fitW) + 0.5)
          const ny0 = clamp01((-vh / 2 - pos.y) / (scale * fitH) + 0.5)
          const ny1 = clamp01((vh / 2 - pos.y) / (scale * fitH) + 0.5)
          if (nx1 <= nx0 || ny1 <= ny0) return
          const canvas = refineRef.current
          if (!canvas) return
          const dpr = DPR()
          const pageScaleDev = (scale * fitW / base.width) * dpr
          const vp = page.getViewport({ scale: pageScaleDev, offsetX: -nx0 * fitW * scale * dpr, offsetY: -ny0 * fitH * scale * dpr })
          canvas.width = Math.round((nx1 - nx0) * fitW * scale * dpr)
          canvas.height = Math.round((ny1 - ny0) * fitH * scale * dpr)
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          refineTask.current?.cancel()
          const task = page.render({ canvas, canvasContext: ctx, viewport: vp })
          refineTask.current = task
          await task.promise.catch(() => {})
          if (cancelled) return
          // the board is layout-scaled (its box is fit × scale), so the refine
          // canvas is positioned in those scaled px — not the unscaled fit px
          setRect({ left: nx0 * fitW * scale, top: ny0 * fitH * scale, width: (nx1 - nx0) * fitW * scale, height: (ny1 - ny0) * fitH * scale })
        })
        .catch(() => {})
    }, SETTLE_MS)
    return () => { cancelled = true; clearTimeout(t); refineTask.current?.cancel() }
  }, [url, pages, scale, pos.x, pos.y, vw, vh, fitW, fitH])

  return (
    <>
      <canvas ref={baseRef} className={s['wb-pdf-base']} />
      <canvas
        ref={refineRef}
        className={s['wb-pdf-refine']}
        style={rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : { display: 'none' }}
      />
      {status !== 'ready' && (
        <div className={s['wb-pdf-status']} role="status">
          <span>{status === 'error' ? appConfig.copy.pdf.failed : appConfig.copy.pdf.loading}</span>
          {fail && <PdfFailDetail fail={fail} reasonClass={s['wb-pdf-reason']} codeClass={s['wb-pdf-code']} />}
          {(status === 'error' || slow) && (
            <RetryButton label={appConfig.copy.pdf.retry} onClick={retry} />
          )}
        </div>
      )}
    </>
  )
}

/**
 * The two lines under «PDF konnte nicht geladen werden.»: what to do about it, and the code to
 * read out. Shared with PdfScroller — same information, each surface's own class names.
 *
 * The code is shown, not hidden behind a tap: at 3am nobody goes looking for details, and a
 * reason nobody reads is worth nothing. It is selectable so it can be copied on a desk machine,
 * and short enough to say over the radio («worker-404, Build 692d28a»).
 */
export function PdfFailDetail({ fail, reasonClass, codeClass }: { fail: PdfFailure; reasonClass?: string; codeClass?: string }) {
  return (
    <>
      <span className={reasonClass}>{appConfig.copy.pdf.reason[fail.reason]}</span>
      <code className={codeClass}>{`${fail.code} · ${GIT_SHA}`}</code>
      {/* an `unknown` carries the thrown message — the one clue a photo of this screen has */}
      {fail.detail && <code className={codeClass}>{fail.detail}</code>}
    </>
  )
}
