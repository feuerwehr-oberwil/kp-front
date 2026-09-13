import { useEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { loadDocTimed, pdfWorkerUrl, PdfFailDetail, usePdfLoad } from './PdfViewport'
import { diagnosePdfFailure } from '../lib/pdfDiagnosis'
import { pinchZoom, scrollAfterZoom, stepZoom, toggleZoom, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../lib/pdfZoom'
import { RetryButton } from './RetryButton'
import s from './PdfScroller.module.css'

// A plain, scrollable multi-page PDF viewer for viewer-only plans (e.g. PV / documentation
// sheets). Unlike the board's PdfViewport — which stitches all pages into ONE pan/zoom bitmap
// for annotation — this renders each page top→bottom as its own canvas in a natively-scrolling
// column, the "normal PDF viewer" experience. Reuses PdfViewport's pdf.js loader + doc cache.
//
// Zoom (13.09.2026): a small drawing on a big screen, or any drawing on a phone, needs more than
// «fit the column». The ± cluster, ctrl/⌘+wheel, a pinch and a double tap zoom the column from
// 1× (fit) to 4×; the pages re-render crisp at the new width (a pinch previews with a CSS
// transform and commits on release) and the point under the fingers stays where it was.

const DPR = () => Math.min(window.devicePixelRatio || 1, 2)
const MAX_COL_W = 1100 // cap the page column so wide screens don't render huge canvases
const MAX_CANVAS_W = 4096 // zoomed pages: bound the backing store, not the CSS size

export function PdfScroller({ url }: { url: string }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(1)
  zoomRef.current = zoom
  /** zoom to `next`, keeping the point at `focal` (viewport px inside the scroller) in place */
  const zoomTo = (next: number, focal?: { x: number; y: number }) => {
    const el = wrapRef.current
    const from = zoomRef.current
    if (next === from) return
    if (el) {
      const f = focal ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 }
      const target = scrollAfterZoom({ left: el.scrollLeft, top: el.scrollTop }, f, next / from)
      pendingScroll.current = target
    }
    setZoom(next)
  }
  const pendingScroll = useRef<{ left: number; top: number } | null>(null)
  // status / «Erneut laden» / retry — the same machine the board's PdfViewport runs on
  const { status, setStatus, fail, setFail, attempt, slow, retry } = usePdfLoad(url)

  // track the available column width so pages render crisp at the current size
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])

  useEffect(() => {
    const host = pagesRef.current
    if (!host || !width) return
    let cancelled = false
    setStatus('loading')
    setFail(null)
    const cssW = Math.round(Math.max(120, Math.min(width - 24, MAX_COL_W)) * zoom) // minus the column padding
    const dpr = Math.min(DPR(), MAX_CANVAS_W / cssW)
    loadDocTimed(url)
      .then(async (pdf) => {
        const frag = document.createDocumentFragment()
        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) return
          const page = await pdf.getPage(i)
          const base = page.getViewport({ scale: 1 })
          const vp = page.getViewport({ scale: (cssW / base.width) * dpr })
          const canvas = document.createElement('canvas')
          canvas.width = Math.round(vp.width)
          canvas.height = Math.round(vp.height)
          canvas.className = s.page
          canvas.style.width = `${cssW}px`
          canvas.style.height = `${Math.round(vp.height / dpr)}px`
          const ctx = canvas.getContext('2d')
          if (ctx) await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise
          if (cancelled) return
          frag.appendChild(canvas)
        }
        if (cancelled) return
        host.replaceChildren(frag) // swap in atomically (also clears a prior render)
        host.style.transform = '' // a pinch preview, if one was up, is now the real thing
        const target = pendingScroll.current
        if (target && wrapRef.current) { pendingScroll.current = null; wrapRef.current.scrollTo(target) }
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setStatus('error')
        void diagnosePdfFailure(err, pdfWorkerUrl()).then((f) => { if (!cancelled) setFail(f) })
      })
    return () => { cancelled = true }
    // setStatus/setFail are `useState` setters handed through usePdfLoad, so their identity is
    // stable and they never re-run this — they are listed only because the lint rule cannot see
    // through the hook's return object to know that.
  }, [url, width, zoom, attempt, setStatus, setFail])

  // ctrl/⌘ + wheel zooms around the cursor (a plain wheel keeps scrolling); passive: false so the
  // browser's own page zoom stays out of it
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomTo(stepZoom(zoomRef.current, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), { x: e.clientX - r.left, y: e.clientY - r.top })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // pinch: preview with a transform on the page column, commit (re-render crisp) on release
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinch = useRef<{ zoom: number; dist: number; mid: { x: number; y: number }; live: number } | null>(null)
  const lastTap = useRef(0)
  const dist = () => { const [a, b] = [...pointers.current.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0 }
  const mid = () => { const [a, b] = [...pointers.current.values()]; const r = wrapRef.current?.getBoundingClientRect(); return a && b && r ? { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top } : { x: 0, y: 0 } }
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) pinch.current = { zoom: zoomRef.current, dist: dist(), mid: mid(), live: zoomRef.current }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = pinch.current, host = pagesRef.current
    if (!g || !host || pointers.current.size < 2) return
    g.live = pinchZoom(g.zoom, g.dist, dist())
    host.style.transformOrigin = `${g.mid.x + (wrapRef.current?.scrollLeft ?? 0)}px ${g.mid.y + (wrapRef.current?.scrollTop ?? 0)}px`
    host.style.transform = `scale(${g.live / g.zoom})`
  }
  const onPointerEnd = (e: React.PointerEvent) => {
    const start = pointers.current.get(e.pointerId)
    pointers.current.delete(e.pointerId)
    const g = pinch.current
    if (g && pointers.current.size < 2) {
      pinch.current = null
      if (Math.abs(g.live - g.zoom) < 0.02) { if (pagesRef.current) pagesRef.current.style.transform = '' }
      else zoomTo(Math.round(g.live * 100) / 100, g.mid)
      lastTap.current = 0
      return
    }
    // double tap, detected here rather than via dblclick: a phone does not reliably synthesise
    // one from two touches, and a tap that moved was a scroll
    if (e.pointerType === 'mouse' || !start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12) return
    const now = performance.now()
    if (now - lastTap.current < 320) { lastTap.current = 0; doubleTapAt(e.clientX, e.clientY) } else lastTap.current = now
  }
  const doubleTapAt = (clientX: number, clientY: number) => {
    const r = wrapRef.current?.getBoundingClientRect()
    zoomTo(toggleZoom(zoomRef.current), r ? { x: clientX - r.left, y: clientY - r.top } : undefined)
  }
  const onDoubleTap = (e: React.MouseEvent) => { if (e.detail !== 0) doubleTapAt(e.clientX, e.clientY) }

  return (
    <div ref={wrapRef} className={s.scroller} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onDoubleClick={onDoubleTap}>
      <div className={`wb-zoom wb-zoom-float ${s.zoom}`} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button onClick={() => zoomTo(stepZoom(zoom, 1 / ZOOM_STEP))} disabled={zoom <= ZOOM_MIN} title={appConfig.copy.nav.zoomOut} aria-label={appConfig.copy.nav.zoomOut}><Icon id="minus" /></button>
        <button onClick={() => zoomTo(stepZoom(zoom, ZOOM_STEP))} disabled={zoom >= ZOOM_MAX} title={appConfig.copy.nav.zoomIn} aria-label={appConfig.copy.nav.zoomIn}><Icon id="plus" /></button>
        <button className="wb-fit" onClick={() => zoomTo(1)} disabled={zoom === 1} title={appConfig.copy.nav.fit}>{appConfig.copy.whiteboard.fit}</button>
      </div>
      {status !== 'ready' && (
        <div className={s.hint}>
          <span>{status === 'error' ? appConfig.copy.pdf.failed : appConfig.copy.pdf.loading}</span>
          {fail && <PdfFailDetail fail={fail} reasonClass={s.reason} codeClass={s.code} />}
          {(status === 'error' || slow) && (
            <RetryButton label={appConfig.copy.pdf.retry} onClick={retry} />
          )}
        </div>
      )}
      <div ref={pagesRef} className={`${s.pages}${zoom > 1 ? ` ${s.zoomed}` : ''}`} />
    </div>
  )
}
