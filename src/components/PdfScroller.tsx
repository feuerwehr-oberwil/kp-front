import { useEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { loadDocTimed, evictPlan, RETRY_AFTER_MS } from './PdfViewport'
import s from './PdfScroller.module.css'

// A plain, scrollable multi-page PDF viewer for viewer-only plans (e.g. PV / documentation
// sheets). Unlike the board's PdfViewport — which stitches all pages into ONE pan/zoom bitmap
// for annotation — this renders each page top→bottom as its own canvas in a natively-scrolling
// column, the "normal PDF viewer" experience. Reuses PdfViewport's pdf.js loader + doc cache.

const DPR = () => Math.min(window.devicePixelRatio || 1, 2)
const MAX_COL_W = 1100 // cap the page column so wide screens don't render huge canvases

export function PdfScroller({ url }: { url: string }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [slow, setSlow] = useState(false)

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

  // «Erneut laden» surfaces once a load has been pending for a while (same model as the
  // board's PdfViewport placeholder — the cached fast path never flashes the button)
  useEffect(() => {
    if (status !== 'loading') { setSlow(false); return }
    setSlow(false)
    const t = setTimeout(() => setSlow(true), RETRY_AFTER_MS)
    return () => clearTimeout(t)
  }, [status, url, attempt])

  // bust the doc cache and refetch — in-app recovery for a stuck or failed load
  const retry = () => {
    evictPlan(url)
    setStatus('loading')
    setAttempt((a) => a + 1)
  }

  useEffect(() => {
    const host = pagesRef.current
    if (!host || !width) return
    let cancelled = false
    setStatus('loading')
    const cssW = Math.max(120, Math.min(width - 24, MAX_COL_W)) // minus the column padding
    const dpr = DPR()
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
        setStatus('ready')
      })
      .catch(() => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
  }, [url, width, attempt])

  return (
    <div ref={wrapRef} className={s.scroller}>
      {status !== 'ready' && (
        <div className={s.hint}>
          <span>{status === 'error' ? appConfig.copy.pdf.failed : appConfig.copy.pdf.loading}</span>
          {(status === 'error' || slow) && (
            <button type="button" className={s.retry} onClick={retry}>{appConfig.copy.pdf.retry}</button>
          )}
        </div>
      )}
      <div ref={pagesRef} className={s.pages} />
    </div>
  )
}
