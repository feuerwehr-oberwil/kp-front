import { useEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { loadDocTimed, pdfWorkerUrl, PdfFailDetail, usePdfLoad } from './PdfViewport'
import { diagnosePdfFailure } from '../lib/pdfDiagnosis'
import { anchorScroll, canvasScale, pageAnchorAt, pageCanvasBudget, pinchZoom, scrollAfterZoom, stepZoom, toggleZoom, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, type Box, type PageAnchor } from '../lib/pdfZoom'
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
//
// The fit (14.09.2026) is the column's CONTENT box – the scroller minus the lanes its padding
// reserves for the rails (PdfScroller.module.css · .pages) – not the scroller's whole width: a
// page as wide as the scroller was centred with half its overflow BEFORE the scroll origin,
// i.e. its left ~50px under the NavRail on an iPad, and no scroll reaches there.

const DPR = () => Math.min(window.devicePixelRatio || 1, 2)
const MAX_COL_W = 1100 // cap the page column so wide screens don't render huge canvases

/** The page boxes of the column, for the anchor maths in lib/pdfZoom. */
const pageBoxes = (host: HTMLElement | null): Box[] =>
  host ? Array.from(host.children).map((c) => c.getBoundingClientRect()) : []

export function PdfScroller({ url }: { url: string }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<HTMLDivElement>(null)
  const zoomClusterRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(1)
  zoomRef.current = zoom
  /** zoom to `next`, keeping the point at `focal` (viewport px inside the scroller) in place.
   *
   *  ⚠️ Anchored to the PAGE under the focal point, not to the scroll origin (15.09.2026). The
   *  column's padding (the rail lanes, the top bar's lane), the 12px gaps and the fit's centring
   *  do not scale with the pages – so «scroll × ratio» landed somewhere else on a phone, most
   *  visibly on the tall stitched Modul 6. What the fingers hold is a spot ON A PAGE: remember
   *  which page and where on it (as fractions), and once the pages are laid out at the new size,
   *  put that spot back under the same viewport point (`anchorScroll`). */
  const zoomTo = (next: number, focal?: { x: number; y: number }) => {
    const el = wrapRef.current
    const from = zoomRef.current
    if (next === from) return
    if (el) {
      const f = focal ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 }
      const r = el.getBoundingClientRect()
      const anchor = pageAnchorAt(pageBoxes(pagesRef.current), { x: r.left + f.x, y: r.top + f.y })
      pendingScroll.current = anchor
        ? { anchor, focal: f }
        : { fallback: scrollAfterZoom({ left: el.scrollLeft, top: el.scrollTop }, f, next / from) }
    }
    setZoom(next)
  }
  const pendingScroll = useRef<{ anchor: PageAnchor; focal: { x: number; y: number } } | { fallback: { left: number; top: number } } | null>(null)
  // status / «Erneut laden» / retry — the same machine the board's PdfViewport runs on
  const { status, setStatus, fail, setFail, attempt, slow, retry } = usePdfLoad(url)

  // track the fit width – the column's content box – so pages render crisp at the current size.
  // Observed on the column, not the scroller, so a rail that expands (its lane is the column's
  // padding, off --rail-w) re-fits the page too. ⚠️ Only while at the fit: a zoomed column is
  // `max-content`, as wide as its page – reading it back would feed the render its own output.
  useEffect(() => {
    const host = pagesRef.current
    if (!host) return
    const measure = () => {
      if (zoomRef.current !== 1) return
      const cs = getComputedStyle(host)
      setWidth(host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(host)
    return () => ro?.disconnect()
  }, [])

  useEffect(() => {
    const host = pagesRef.current
    if (!host || !width) return
    let cancelled = false
    setStatus('loading')
    setFail(null)
    const cssW = Math.round(Math.max(120, Math.min(width, MAX_COL_W)) * zoom)
    loadDocTimed(url)
      .then(async (pdf) => {
        const frag = document.createDocumentFragment()
        const budget = pageCanvasBudget(pdf.numPages)
        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) return
          const page = await pdf.getPage(i)
          const base = page.getViewport({ scale: 1 })
          const cssH = cssW * (base.height / base.width)
          // the backing store is bounded by what a canvas may hold, the CSS size is the zoom's
          const k = canvasScale(cssW, cssH, DPR(), budget)
          const vp = page.getViewport({ scale: (cssW / base.width) * k })
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.floor(vp.width))
          canvas.height = Math.max(1, Math.floor(vp.height))
          canvas.className = s.page
          canvas.style.width = `${cssW}px`
          canvas.style.height = `${Math.round(cssH)}px`
          const ctx = canvas.getContext('2d')
          if (ctx) await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise
          if (cancelled) return
          frag.appendChild(canvas)
        }
        if (cancelled) return
        host.replaceChildren(frag) // swap in atomically (also clears a prior render)
        host.style.transform = '' // a pinch preview, if one was up, is now the real thing
        const pending = pendingScroll.current
        if (pending && wrapRef.current) {
          pendingScroll.current = null
          const el = wrapRef.current
          let target: { left: number; top: number } | null = null
          if ('fallback' in pending) target = pending.fallback
          else {
            const page = host.children[pending.anchor.index]
            if (page) target = anchorScroll(el.getBoundingClientRect(), { left: el.scrollLeft, top: el.scrollTop }, page.getBoundingClientRect(), pending.anchor, pending.focal)
          }
          if (target) el.scrollTo(target)
        }
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

  const doubleTapAt = (clientX: number, clientY: number) => {
    const r = wrapRef.current?.getBoundingClientRect()
    zoomTo(toggleZoom(zoomRef.current), r ? { x: clientX - r.left, y: clientY - r.top } : undefined)
  }
  // when the reader itself last answered a double TAP – a browser that does synthesise dblclick
  // from two touches must not toggle the zoom a second time
  const touchTapAt = useRef(0)
  const onDoubleClick = (e: React.MouseEvent) => {
    if (e.detail !== 0 && performance.now() - touchTapAt.current > 700) doubleTapAt(e.clientX, e.clientY)
  }

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
  }, [])

  // Pinch + double tap, on TOUCH events (14.09.2026; pointer events until then). ⚠️ The scroller
  // pans natively (touch-action: pan-x pan-y), and the moment the browser claims a two-finger
  // move as a pan it fires pointercancel and the pinch is gone – on an iPad none was ever
  // registered. Pointer events have no way to keep that pan from starting; a NON-passive
  // touchmove has: preventDefault while two fingers are down and neither the pan nor Safari's
  // page zoom get the gesture, while one finger keeps scrolling natively. The preview is a
  // transform on the page column; the release commits (re-renders crisp). A tap is counted here
  // too – a phone does not reliably synthesise dblclick from two touches, and a tap that moved
  // was a scroll.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    type Pt = { x: number; y: number }
    const pt = (t: Touch): Pt => ({ x: t.clientX, y: t.clientY })
    const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
    const mid = (a: Pt, b: Pt): Pt => {
      const r = el.getBoundingClientRect()
      return { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }
    }
    let pinch: { zoom: number; dist: number; mid: Pt; live: number } | null = null
    let tap: Pt | null = null // the single touch that may still become a tap
    let lastTap = 0
    const onStart = (e: TouchEvent) => {
      if (zoomClusterRef.current?.contains(e.target as Node)) return // the ± buttons are theirs
      if (e.touches.length === 2) {
        e.preventDefault()
        const [a, b] = [pt(e.touches[0]), pt(e.touches[1])]
        pinch = { zoom: zoomRef.current, dist: dist(a, b), mid: mid(a, b), live: zoomRef.current }
        tap = null
      } else if (e.touches.length === 1) tap = pt(e.touches[0])
      else tap = null
    }
    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length >= 2) {
        e.preventDefault()
        const host = pagesRef.current
        pinch.live = pinchZoom(pinch.zoom, pinch.dist, dist(pt(e.touches[0]), pt(e.touches[1])))
        if (!host) return
        host.style.transformOrigin = `${pinch.mid.x + el.scrollLeft}px ${pinch.mid.y + el.scrollTop}px`
        host.style.transform = `scale(${pinch.live / pinch.zoom})`
      } else if (tap && e.touches[0] && dist(tap, pt(e.touches[0])) > 12) tap = null
    }
    const onEnd = (e: TouchEvent) => {
      if (pinch && e.touches.length < 2) {
        const g = pinch
        pinch = null
        tap = null
        lastTap = 0
        if (Math.abs(g.live - g.zoom) < 0.02) { if (pagesRef.current) pagesRef.current.style.transform = '' }
        else zoomTo(Math.round(g.live * 100) / 100, g.mid)
        return
      }
      if (e.touches.length !== 0) return // a finger is still down
      const t = tap && e.type === 'touchend' ? e.changedTouches[0] : undefined
      tap = null
      if (!t) return
      const now = performance.now()
      if (now - lastTap < 320) { lastTap = 0; touchTapAt.current = now; doubleTapAt(t.clientX, t.clientY) } else lastTap = now
    }
    const onGesture = (e: Event) => e.preventDefault() // Safari's own pinch/rotate of the page
    el.addEventListener('touchstart', onStart, { passive: false })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    el.addEventListener('gesturestart', onGesture)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
      el.removeEventListener('gesturestart', onGesture)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div ref={wrapRef} className={s.scroller} onDoubleClick={onDoubleClick}>
      <div ref={zoomClusterRef} className={`wb-zoom wb-zoom-float ${s.zoom}`} onDoubleClick={(e) => e.stopPropagation()}>
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
