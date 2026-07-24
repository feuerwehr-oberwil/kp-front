import { useEffect, useRef, useState } from 'react'
import type * as PdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { appConfig } from '../config/appConfig'
import s from './PdfViewport.module.css'

// pdfjs (+ its ~1.2 MB worker) is the single heaviest dependency in the app and is only
// needed on the Plan tab. Load it lazily via dynamic import() so it lands in its own chunk
// and never ships in the initial bundle — the PDF stack downloads on first plan render.
let pdfjsPromise: Promise<typeof PdfjsLib> | null = null
function getPdfjs(): Promise<typeof PdfjsLib> {
  if (!pdfjsPromise) {
    const p = (async () => {
      const [pdfjsLib, { default: workerUrl }] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ])
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
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
function docEntry(url: string): DocEntry {
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

// Forget everything cached for one plan URL — the «Erneut laden» tap goes through here
// so the re-bake starts from a clean fetch instead of a stuck/rejected promise.
export function evictPlan(url: string) {
  docCache.get(url)?.destroy()
  bitmapCache.delete(url)
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
const BITMAP_CAP = 12     // how many baked page bitmaps to keep resident
export const RETRY_AFTER_MS = 5_000 // show «Erneut laden» once a load has been pending this long
const MAX_COMPOSITE_PX = 12000 // ceiling on the stitched bitmap's long side (browser canvas limit safety for many-page plans)
const DPR = () => Math.min(window.devicePixelRatio || 1, 2)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

type Baked = { bitmap: ImageBitmap; aspect: number; side: number; pages: number }

// One baked bitmap per document, held in memory. A multi-page plan (e.g. Modul 6 Geschosspläne)
// is STITCHED into a single tall bitmap — page 1 at the bottom, later pages stacked above (like
// the Gebäude floor-stack) — so the whole plan scrolls/zooms as one board. The first render is the
// ONLY pdf.js rasterization for normal viewing; open / switch / pan / zoom are served from this
// bitmap (a GPU blit + CSS transform), so they're instant. Keyed by url; memory-bounded by a count cap.
const bitmapCache = new Map<string, Promise<Baked>>()

// Never keep a rejected bake — a failed/timed-out load must be retryable on the next
// mount (or the «Erneut laden» tap) instead of replaying the cached rejection.
function setBitmap(url: string, p: Promise<Baked>) {
  p.catch(() => { if (bitmapCache.get(url) === p) bitmapCache.delete(url) })
  bitmapCache.set(url, p)
}

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
// for (e.g. the window grew); shrinking reuses the crisper bitmap.
function bake(url: string, vw: number, vh: number): Promise<Baked> {
  const existing = bitmapCache.get(url)
  if (existing) {
    // keep if it's already at least as crisp as we'd now ask for
    const want = (a: number) => targetSide(a, vw, vh)
    const reuse = existing.then((b) => (b.side >= want(b.aspect) ? b : Promise.reject('stale')))
    // touch for LRU
    bitmapCache.delete(url); bitmapCache.set(url, existing)
    // fall through to re-bake only on the stale rejection
    const p = reuse.catch(() => render(url, vw, vh))
    setBitmap(url, p)
    return p
  }
  const p = render(url, vw, vh)
  setBitmap(url, p)
  evict()
  return p
}

function render(url: string, vw: number, vh: number): Promise<Baked> {
  return loadDocTimed(url).then(async (pdf) => {
    const n = pdf.numPages
    // measure every page; stitched width is the widest page, height is the sum
    const metas: { page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>; w: number; h: number }[] = []
    let W = 0, totalH = 0
    for (let i = 1; i <= n; i++) {
      const pg = await pdf.getPage(i)
      const vp = pg.getViewport({ scale: 1 })
      metas.push({ page: pg, w: vp.width, h: vp.height })
      W = Math.max(W, vp.width)
      totalH += vp.height
    }
    const aspect = totalH / W
    let side = targetSide(aspect, vw, vh) // stitched bitmap WIDTH in px
    if (side * aspect > MAX_COMPOSITE_PX) side = MAX_COMPOSITE_PX / aspect // keep within canvas limits
    const renderScale = side / W
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(side)
    canvas.height = Math.round(totalH * renderScale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d ctx')
    // draw bottom-up: page 1 sits at the bottom, each later page stacked above it
    let yBottom = canvas.height
    for (const m of metas) {
      const vp = m.page.getViewport({ scale: renderScale })
      const pw = Math.round(vp.width), ph = Math.round(vp.height)
      const tmp = document.createElement('canvas')
      tmp.width = pw; tmp.height = ph
      const tctx = tmp.getContext('2d')
      if (tctx) {
        await m.page.render({ canvas: tmp, canvasContext: tctx, viewport: vp }).promise
        yBottom -= ph
        ctx.drawImage(tmp, Math.round((side - pw) / 2), yBottom)
      }
    }
    const bitmap = await createImageBitmap(canvas)
    return { bitmap, aspect, side, pages: n }
  })
}

function evict() {
  while (bitmapCache.size > BITMAP_CAP) {
    const oldest = bitmapCache.keys().next().value
    if (oldest === undefined) break
    bitmapCache.delete(oldest) // resolved bitmap is GC'd once nothing draws it
  }
}

// Warm every plan's bitmap in the background, one at a time so they never
// contend with the active document's render. Called when the Plan tab mounts.
let warmQueue: Promise<unknown> = Promise.resolve()
export function prewarmPlans(urls: string[], vw: number, vh: number) {
  if (!vw || !vh) return
  for (const url of urls) {
    if (bitmapCache.has(url)) continue
    warmQueue = warmQueue.then(() => bake(url, vw, vh).catch(() => {}))
  }
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
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [statusUrl, setStatusUrl] = useState(url)
  const [attempt, setAttempt] = useState(0)
  const [slow, setSlow] = useState(false)
  if (url !== statusUrl) { setStatusUrl(url); setStatus('loading') }

  // «Erneut laden» surfaces once a load has been pending for a while — the normal
  // cached/prewarmed fast path never flashes the button
  useEffect(() => {
    if (status !== 'loading') { setSlow(false); return }
    setSlow(false)
    const t = setTimeout(() => setSlow(true), RETRY_AFTER_MS)
    return () => clearTimeout(t)
  }, [status, statusUrl, attempt])

  // bust every cache for this document and re-bake — the in-app recovery for a stuck or
  // failed load (previously only a full page reload cleared the module-level caches)
  const retry = () => {
    evictPlan(url)
    setStatus('loading')
    setAttempt((a) => a + 1)
  }

  // base — blit the baked bitmap (instant if cached/prewarmed; a single render otherwise)
  useEffect(() => {
    if (!vw || !vh) return
    let cancelled = false
    bake(url, vw, vh)
      .then(({ bitmap, aspect, pages: n }) => {
        if (cancelled) return
        onAspect(aspect)
        setPages(n)
        const canvas = baseRef.current
        if (!canvas) return
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
        setStatus('ready')
      })
      .catch(() => { if (!cancelled) setStatus('error') })
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
          const page = await pdf.getPage(1)
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
          {(status === 'error' || slow) && (
            <button type="button" className={s['wb-pdf-retry']} onClick={retry}>{appConfig.copy.pdf.retry}</button>
          )}
        </div>
      )}
    </>
  )
}
