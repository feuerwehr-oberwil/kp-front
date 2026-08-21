import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import type { ContentBlock, RefEntry } from '../lib/checklists'
import { checklistAssetUrl } from '../lib/checklists'
import { cx } from '../lib/cx'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { Overlay } from '../lib/overlays'
import s from './Checklists.module.css'

// Reading view for one EL tactical entry. The list + search live in the rail now
// (ChecklistsView) — this just renders the selected Stichwort's content. Diagram pages from the
// source PDF are served from the reference registry (checklists:<template>:p<N>, PWA-cached),
// resolved via the owning template id — never bundled in /public.

// Make phone numbers tappable (tel:) in reference text — the Telefonliste page and the contact
// numbers embedded in tactical entries. Conservative on purpose: a Swiss number is a leading-0
// group with ≥2 space-separated digit groups, plus the emergency short codes. This never matches
// the bare quantities that fill tactical text (distances/pressures/times/temperatures), because
// those don't start with 0 followed by grouped digits.
const PHONE_RE = /\b0\d{1,3}(?: \d{2,4}){2,}\b|\b(?:1414|112|117|118|143|144|145)\b/g

function withPhoneLinks(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  PHONE_RE.lastIndex = 0
  while ((m = PHONE_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      <a key={key++} className={s['cl-tel']} href={`tel:${m[0].replace(/\D/g, '')}`}>
        {m[0]}
      </a>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

const ZOOM_MIN = 1
const ZOOM_MAX = 6

/** Pinch / drag / double-tap zoom over one image.
 *
 *  ⚠️ We own the gestures rather than handing pinch to the browser. The first attempt set
 *  `touch-action: pinch-zoom` on a scrolling frame and relied on native zoom — inside a modal
 *  dialog that does nothing: the scroll lock and the dialog's own layer mean the visual-viewport
 *  gesture never reaches the picture, so the diagram opened and then refused to get bigger.
 *  Pointer events + a transform work the same on a tablet, a phone and a trackpad. */
function useImageZoom(reset: unknown) {
  const [z, setZ] = useState({ s: 1, x: 0, y: 0 })
  const frame = useRef<HTMLDivElement | null>(null)
  const pts = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; s: number } | null>(null)
  const moved = useRef(false)

  useEffect(() => { setZ({ s: 1, x: 0, y: 0 }); pts.current.clear(); pinch.current = null }, [reset])

  /** Keep the picture overlapping its frame: at scale 1 it stays centred, beyond that it may be
   *  panned only as far as its own overhang — so it can never be flicked off into the void. */
  const clamp = (n: { s: number; x: number; y: number }) => {
    const r = frame.current?.getBoundingClientRect()
    const mx = r ? (r.width * (n.s - 1)) / 2 : 0
    const my = r ? (r.height * (n.s - 1)) / 2 : 0
    return { s: n.s, x: Math.min(mx, Math.max(-mx, n.x)), y: Math.min(my, Math.max(-my, n.y)) }
  }

  /** Zoom about a point in frame coordinates, so what is under the fingers stays under them. */
  const zoomAt = (next: number, cx = 0, cy = 0) =>
    setZ((p) => {
      const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
      const k = s / p.s
      return clamp({ s, x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k })
    })

  const local = (e: { clientX: number; clientY: number }) => {
    const r = frame.current?.getBoundingClientRect()
    return r ? { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 } : { x: 0, y: 0 }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved.current = false
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()]
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: z.s }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pts.current.get(e.pointerId)
    if (!prev) return
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pts.current.size === 2 && pinch.current) {
      const [a, b] = [...pts.current.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const mid = local({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 })
      moved.current = true
      zoomAt(pinch.current.s * (d / pinch.current.dist), mid.x, mid.y)
      return
    }
    if (pts.current.size === 1 && z.s > 1) {
      const dx = e.clientX - prev.x
      const dy = e.clientY - prev.y
      if (Math.abs(dx) + Math.abs(dy) > 2) moved.current = true
      setZ((p) => clamp({ ...p, x: p.x + dx, y: p.y + dy }))
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    pts.current.delete(e.pointerId)
    if (pts.current.size < 2) pinch.current = null
  }

  /** Tap (not a drag) toggles between fit and a readable 2.5×, centred on where you tapped. */
  const onClick = (e: React.MouseEvent) => {
    if (moved.current) return
    const p = local(e)
    zoomAt(z.s > 1.05 ? 1 : 2.5, p.x, p.y)
  }

  const onWheel = (e: React.WheelEvent) => {
    const p = local(e)
    zoomAt(z.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), p.x, p.y)
  }

  return { z, frame, zoomAt, setZ, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onClick, onWheel } }
}

/** A source-PDF diagram: inline preview that opens full-screen and zoomable, because a
 *  Kommandoakten page scaled into a reading column is a picture OF a diagram rather than a
 *  readable one. */
function DiagramFigure({ url, caption, alt }: { url: string; caption?: string; alt: string }) {
  const CL = appConfig.copy.checklists
  const [open, setOpen] = useState(false)
  const { z, frame, zoomAt, setZ, handlers } = useImageZoom(open)
  return (
    <>
      <figure className={s['cl-ref-fig']}>
        <button type="button" className={s['cl-ref-figbtn']} onClick={() => setOpen(true)} title={CL.diagramOpen}>
          <img src={url} alt={alt} loading="lazy" />
          <span className={s['cl-ref-zoomhint']} aria-hidden="true"><Icon id="search" /></span>
        </button>
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
      {open && (
        <Overlay open onClose={() => setOpen(false)} className={cx(s['cl-zoom'], 'ui-dialog')} ariaLabel={caption ?? alt}>
          <div className={s['cl-zoom-head']}>
            <span className={s['cl-zoom-cap']}>{caption ?? alt}</span>
            <div className={s['cl-zoom-tools']}>
              <button type="button" onClick={() => zoomAt(z.s / 1.5)} disabled={z.s <= ZOOM_MIN} aria-label={CL.diagramOut}>
                <Icon id="zoom-out" />
              </button>
              <button type="button" className={s['cl-zoom-pct']} onClick={() => setZ({ s: 1, x: 0, y: 0 })}>
                {Math.round(z.s * 100)}%
              </button>
              <button type="button" onClick={() => zoomAt(z.s * 1.5)} disabled={z.s >= ZOOM_MAX} aria-label={CL.diagramIn}>
                <Icon id="zoom-in" />
              </button>
            </div>
            <button type="button" className={s['cl-zoom-x']} onClick={() => setOpen(false)} aria-label={CL.diagramClose}>
              <Icon id="close" />
            </button>
          </div>
          <div ref={frame} className={cx(s['cl-zoom-body'], z.s > 1.05 && s['is-zoomed'])} {...handlers}>
            <img src={url} alt={alt} draggable={false} style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.s})` }} />
          </div>
          <p className={s['cl-zoom-hint']}>{CL.diagramHint}</p>
        </Overlay>
      )}
    </>
  )
}

function ContentBlockView({ block, templateId }: { block: ContentBlock; templateId: string | null }) {
  const CL = appConfig.copy.checklists
  if (block.type === 'heading') return <h4 className={s['cl-ref-h']}>{block.text}</h4>
  if (block.type === 'note') return <p className={s['cl-ref-note']}><Icon id="info" />{withPhoneLinks(block.text)}</p>
  if (block.type === 'image') {
    // an image block can only resolve when we know which template it belongs to
    if (!templateId) return null
    return (
      <DiagramFigure
        url={checklistAssetUrl(templateId, block.page)}
        caption={block.caption}
        alt={block.caption ?? fillTemplate(CL.diagramAlt, { page: block.page })}
      />
    )
  }
  if (block.type === 'table') {
    return (
      <figure className={s['cl-ref-tablewrap']}>
        <table className={s['cl-ref-table']}>
          {block.head && (
            <thead>
              <tr>{block.head.map((h, i) => <th key={i}>{h}</th>)}</tr>
            </thead>
          )}
          <tbody>
            {block.rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci}>{withPhoneLinks(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>
        {block.caption && <figcaption>{block.caption}</figcaption>}
      </figure>
    )
  }
  // depth drives the CSS, not an inline margin: a level-0 line is a STEP and a level-1 line is a
  // detail of it, and they have to look different or the list reads as one flat wall
  return (
    <div className={cx(s['cl-ref-bullet'], block.emphasis && s[`em-${block.emphasis}`])} data-level={Math.min(block.level ?? 0, 2)}>
      <span className={s['cl-ref-dot']} />
      <span>{withPhoneLinks(block.text)}</span>
    </div>
  )
}

export function ChecklistEntryReader({ entry, templateId }: { entry: RefEntry | null; templateId: string | null }) {
  const CL = appConfig.copy.checklists
  if (!entry) {
    return (
      <div className={cx(s['cl-placeholder'], s['cl-placeholder-full'])}>
        <Icon id="search" />
        <p>{CL.pickEntry}</p>
      </div>
    )
  }
  return (
    <article className={cx(s['cl-ref-doc'], entry.hazardColor && s[`hz-${entry.hazardColor}`])}>
      <header className={s['cl-ref-doc-head']}>
        {entry.hazardColor && <span className={cx(s['cl-ref-badge'], s[`hz-${entry.hazardColor}`])}>{CL.hazardLabels[entry.hazardColor]}</span>}
        <h2>{entry.title}</h2>
      </header>
      <div className={s['cl-ref-blocks']}>
        {entry.content.map((b, i) => (
          <ContentBlockView key={i} block={b} templateId={templateId} />
        ))}
      </div>
    </article>
  )
}
