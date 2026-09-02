import { useEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { loadDocTimed, pdfWorkerUrl, PdfFailDetail, usePdfLoad } from './PdfViewport'
import { diagnosePdfFailure } from '../lib/pdfDiagnosis'
import { RetryButton } from './RetryButton'
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
      .catch((err: unknown) => {
        if (cancelled) return
        setStatus('error')
        void diagnosePdfFailure(err, pdfWorkerUrl()).then((f) => { if (!cancelled) setFail(f) })
      })
    return () => { cancelled = true }
    // setStatus/setFail are `useState` setters handed through usePdfLoad, so their identity is
    // stable and they never re-run this — they are listed only because the lint rule cannot see
    // through the hook's return object to know that.
  }, [url, width, attempt, setStatus, setFail])

  return (
    <div ref={wrapRef} className={s.scroller}>
      {status !== 'ready' && (
        <div className={s.hint}>
          <span>{status === 'error' ? appConfig.copy.pdf.failed : appConfig.copy.pdf.loading}</span>
          {fail && <PdfFailDetail fail={fail} reasonClass={s.reason} codeClass={s.code} />}
          {(status === 'error' || slow) && (
            <RetryButton label={appConfig.copy.pdf.retry} onClick={retry} />
          )}
        </div>
      )}
      <div ref={pagesRef} className={s.pages} />
    </div>
  )
}
