import { useEffect, useRef, useState } from 'react'
import type * as PdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { appConfig } from '../config/appConfig'
import { GIT_SHA } from '../lib/buildInfo'
import { ByteBudgetCache } from '../lib/byteBudgetCache'
import { diagnosePdfFailure, type PdfFailure } from '../lib/pdfDiagnosis'
import s from './PdfViewport.module.css'

// The worker asset's URL, remembered for the diagnosis path: when a PDF fails, whether that
// file is still being served is the single most telling fact we can gather (lib/pdfDiagnosis).
// Stays null while the pdfjs chunk has never resolved — which is itself a diagnosis.
let workerUrl: string | null = null
export const pdfWorkerUrl = () => workerUrl

// pdfjs (+ its ~1.2 MB worker) is the single heaviest dependency in the app and is only
// needed on the Plan tab. Load it lazily via dynamic import() so it lands in its own chunk
// and never ships in the initial bundle — the PDF stack downloads on first plan render.
//
// ⚠️ `?url` makes the worker its own EMITTED ASSET (pdf.worker.min-<hash>.mjs), not a chunk —
// so it has to be matched by the service worker's `globPatterns` BY EXTENSION. It was not
// (`.mjs` was missing) until 2026-08-25, which meant the one file the whole PDF stack cannot
// work without was the one file never precached: fetched from the server on every open, and
// gone from the server the moment the next deploy replaced its hash. Devices still on the old
// build — registerType is 'prompt', and an installed iOS app is never closed — then failed
// EVERY PDF while the rest of the app ran happily out of their precache.
let pdfjsPromise: Promise<typeof PdfjsLib> | null = null
function getPdfjs(): Promise<typeof PdfjsLib> {
  if (!pdfjsPromise) {
    const p = (async () => {
      const [pdfjsLib, { default: url }] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ])
      workerUrl = url
      pdfjsLib.GlobalWorkerOptions.workerSrc = url
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
const bitmapCache = new ByteBudgetCache<Baked>(bitmapBudget, bitmapBytes)

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
function bake(url: string, vw: number, vh: number, maxSide = Infinity): Promise<Baked> {
  const existing = bitmapCache.get(url) // a read touches the entry (LRU)
  if (existing) {
    // keep if it's already at least as crisp as we'd now ask for
    const want = (a: number) => Math.min(targetSide(a, vw, vh), maxSide)
    const reuse = existing.then((b) => (b.side >= want(b.aspect) ? b : Promise.reject('stale')))
    // fall through to re-bake only on the stale rejection
    const p = reuse.catch(() => render(url, vw, vh, maxSide))
    bitmapCache.set(url, p)
    return p
  }
  const p = render(url, vw, vh, maxSide)
  bitmapCache.set(url, p)
  return p
}

/** The bake already held for `url`, whatever its size — a stale preview is still a first paint. */
const cachedBake = (url: string) => bitmapCache.get(url)

function render(url: string, vw: number, vh: number, maxSide: number): Promise<Baked> {
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
    let side = Math.min(targetSide(aspect, vw, vh), maxSide) // stitched bitmap WIDTH in px
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
const PREVIEW_CAP = 4
const previewCache = new Map<string, Promise<string>>()
export function planPreviewUrl(url: string, vw: number, vh: number): Promise<string> {
  const bw = Math.max(vw, 900), bh = Math.max(vh, 900)
  const key = `${url}@${bw}x${bh}`
  const cached = previewCache.get(key)
  // touch for LRU — an entry still being asked for is the last one that should be dropped
  if (cached) { previewCache.delete(key); previewCache.set(key, cached); return cached }
  const p = bake(url, bw, bh).then((b) => {
    const maxSide = 1800
    const k = Math.min(1, maxSide / Math.max(b.bitmap.width, b.bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(b.bitmap.width * k))
    canvas.height = Math.max(1, Math.round(b.bitmap.height * k))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d ctx')
    ctx.drawImage(b.bitmap, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.86)
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
  // why the last attempt failed — rendered under the message so a field report carries a
  // cause instead of «geht nicht» (lib/pdfDiagnosis)
  const [fail, setFail] = useState<PdfFailure | null>(null)
  if (url !== statusUrl) { setStatusUrl(url); setStatus('loading'); setFail(null) }

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
    setFail(null)
    setAttempt((a) => a + 1)
  }

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
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
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
          {fail && <PdfFailDetail fail={fail} reasonClass={s['wb-pdf-reason']} codeClass={s['wb-pdf-code']} />}
          {(status === 'error' || slow) && (
            <button type="button" className={s['wb-pdf-retry']} onClick={retry}>{appConfig.copy.pdf.retry}</button>
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
    </>
  )
}
