import { ShellLoader } from './ShellLoader'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { GIT_SHA } from '../lib/buildInfo'
import { diagnosePdfFailure, type PdfFailure } from '../lib/pdfDiagnosis'
import { bake, cachedBake, clamp01, DPR, evictPlan, loadDoc, pdfWorkerUrl, type Baked } from '../lib/pdfRaster'
import { RetryButton } from './RetryButton'
import s from './PdfViewport.module.css'
import { pdfPageOf } from '../lib/whiteboard'
import { dropTileManifest, loadTileManifest, tileSource, type TileManifest } from '../lib/planTiles'
import { PlanTileLayer } from './PlanTileLayer'
import { PlanSharpnessContext } from '../lib/planSharpness'

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

const REFINE_FROM = 1.15  // engage the full-res pass just past the base bitmap's crisp range, so there's no blurry dead zone between base and refine
const SETTLE_MS = 40      // re-raster quickly after the view settles (kept non-zero so a continuous zoom gesture doesn't thrash pdf.js)
export const RETRY_AFTER_MS = 5_000 // show «Erneut laden» once a load has been pending this long

// Two board-child canvases (they pan/zoom with the board via CSS — instant, no
// per-gesture re-raster). BASE blits the cached page bitmap (rasterized once,
// reused forever). REFINE re-renders only the visible region at full resolution
// when zoomed in deep, after the view settles — the base shows underneath so
// nothing ever blanks. (Refine is single-page only; a stitched multi-page plan
// is served from the base bitmap alone.)
/**
 * The plan on the board. ⚠️ Since 21.09.2026 it is drawn from the server's TILE PYRAMID whenever
 * the revision has one (lib/planTiles, PlanTileLayer) – no pdf.js, no page-sized bitmap, any
 * zoom. The pdf.js viewport below is what every other sheet keeps: an unpinned or bundled PDF, a
 * server without tiles, and a device that is offline with the PDF cached but its tiles not
 * (a tile that cannot be had hands over to it).
 */
export function PdfViewport(props: Props) {
  const { url } = props
  const source = useMemo(() => tileSource(url), [url])
  // undefined = still asking · null = no pyramid, pdf.js
  const [tiles, setTiles] = useState<{ url: string; manifest: TileManifest | null } | undefined>(undefined)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setReady(false)
    if (!source) { setTiles({ url, manifest: null }); return }
    let cancelled = false
    setTiles(undefined)
    loadTileManifest(source).then(
      (manifest) => { if (!cancelled) setTiles({ url, manifest }) },
      () => { if (!cancelled) setTiles({ url, manifest: null }) },
    )
    return () => { cancelled = true }
  }, [url]) // eslint-disable-line react-hooks/exhaustive-deps
  const answer = tiles?.url === url ? tiles : undefined
  if (answer && (!answer.manifest || !source)) return <PdfJsViewport {...props} />
  return (
    <>
      {answer?.manifest && source && (
        <PlanTileLayer
          {...props}
          source={source}
          manifest={answer.manifest}
          onReady={() => setReady(true)}
          onFail={() => { dropTileManifest(source); setTiles({ url, manifest: null }) }}
        />
      )}
      {!ready && (
        <div className={s['wb-pdf-status']} role="status"><ShellLoader size="surface" /><span>{appConfig.copy.pdf.loading}</span></div>
      )}
    </>
  )
}

function PdfJsViewport({ url, fitW, fitH, scale, pos, vw, vh, onAspect }: Props) {
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
  // soft on the glass (lib/planSharpness): the prewarm's small preview while the full bake is
  // still coming, or a deep zoom whose sharp refine pass has not landed (or gave up) yet
  const [soft, setSoft] = useState(false)
  const [refineMiss, setRefineMiss] = useState<string | null>(null)

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
    if (stale && stale !== fresh) stale.then((b) => { if (!cancelled && !painted) { paint(b); setSoft(true) } }).catch(() => {})
    fresh
      .then((b) => {
        if (cancelled) return
        setSoft(false)
        if (painted === b) return // the reused crisp bake is already on the canvas
        paint(b)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setSoft(false)
        setStatus('error')
        void diagnosePdfFailure(err, pdfWorkerUrl()).then((f) => { if (!cancelled) setFail(f) })
      })
    return () => { cancelled = true }
  }, [url, vw, vh, attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  // refine — visible region at full zoom resolution, on settle, only when zoomed deep (single-page
  // plans only; a stitched multi-page plan stays on its base bitmap)
  const refineWanted = scale > REFINE_FROM && pages <= 1 && !!vw && !!vh && !!fitW
  const viewKey = `${url}|${scale}|${pos.x}|${pos.y}|${vw}|${vh}|${fitW}|${fitH}`
  useEffect(() => {
    // The refine canvas is positioned in absolute scaled px, so the instant the view
    // changes (pinch/pan) its old rect is misaligned with the freshly laid-out base —
    // which reads as a second, offset copy of the plan. Drop it immediately on every
    // view change; the base shows underneath (never blanks) and the sharp overlay
    // reappears only once it's re-rendered at the new scale/pos below.
    setRect(null)
    if (!refineWanted) return
    let cancelled = false
    const miss = () => { if (!cancelled) setRefineMiss(viewKey) }
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
          if (nx1 <= nx0 || ny1 <= ny0) { miss(); return }
          const canvas = refineRef.current
          if (!canvas) { miss(); return }
          const dpr = DPR()
          const pageScaleDev = (scale * fitW / base.width) * dpr
          const vp = page.getViewport({ scale: pageScaleDev, offsetX: -nx0 * fitW * scale * dpr, offsetY: -ny0 * fitH * scale * dpr })
          canvas.width = Math.round((nx1 - nx0) * fitW * scale * dpr)
          canvas.height = Math.round((ny1 - ny0) * fitH * scale * dpr)
          const ctx = canvas.getContext('2d')
          if (!ctx) { miss(); return }
          refineTask.current?.cancel()
          const task = page.render({ canvas, canvasContext: ctx, viewport: vp })
          refineTask.current = task
          await task.promise.catch(() => {})
          if (cancelled) return
          // the board is layout-scaled (its box is fit × scale), so the refine
          // canvas is positioned in those scaled px — not the unscaled fit px
          setRect({ left: nx0 * fitW * scale, top: ny0 * fitH * scale, width: (nx1 - nx0) * fitW * scale, height: (ny1 - ny0) * fitH * scale })
        })
        .catch(miss)
    }, SETTLE_MS)
    return () => { cancelled = true; clearTimeout(t); refineTask.current?.cancel() }
  }, [url, pages, scale, pos.x, pos.y, vw, vh, fitW, fitH, refineWanted, viewKey])

  const sharpness = useContext(PlanSharpnessContext)
  const sharp = status !== 'ready' ? 'sharp' : soft || (refineWanted && !rect && refineMiss !== viewKey) ? 'loading' : 'sharp'
  useEffect(() => { sharpness?.report(sharp) }, [sharpness, sharp])
  useEffect(() => () => sharpness?.report('sharp'), [sharpness])

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
          {status !== 'error' && <ShellLoader size="surface" />}
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
