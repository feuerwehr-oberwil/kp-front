import { useEffect, useMemo, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { fitSimilarity } from '../lib/georef'
import { alignmentThumbnail, type AlignmentItem } from './planAlignmentApi'

/** A card's own decision, straight from its footer (the modal carries the slow path). */
export type CardDecision = 'approve' | 'reject' | 'undo' | 'retry'

/** The review wall: every sheet as a thumbnail with the building outlines drawn through the
 *  proposed fit, judged at a glance, decided from the card's footer. Cards come grouped by
 *  what the worker said; the parent owns the decisions and the modal. */
export function AlignmentGrid({ items, busy, onDecide, onOpen }: {
  items: AlignmentItem[]
  /** ids with a decision in flight */
  busy: Set<number>
  onDecide: (item: AlignmentItem, decision: CardDecision) => void
  onOpen: (item: AlignmentItem) => void
}) {
  const C = appConfig.copy.admin.alignment
  return <div className="adm-grid" role="list">
    {items.map(item => <AlignmentCard key={item.id} item={item} busy={busy.has(item.id)} onDecide={onDecide} onOpen={onOpen} />)}
  </div>
}

const noProposal = new Set(['no_match', 'failed', 'unavailable', 'unsupported'])
const waiting = new Set(['pending', 'processing'])

function AlignmentCard({ item, busy, onDecide, onOpen }: {
  item: AlignmentItem; busy: boolean; onDecide: (item: AlignmentItem, decision: CardDecision) => void; onOpen: (item: AlignmentItem) => void
}) {
  const C = appConfig.copy.admin.alignment
  const G = C.grid
  const aspect = item.aspect && Number.isFinite(item.aspect) && item.aspect > 0 ? item.aspect : 1.414
  const outlines = useMemo(() => {
    const fit = item.pairs.length >= 2 ? fitSimilarity(item.pairs, aspect) : null
    if (!fit) return []
    // WGS84 rings → normalized sheet coordinates (x scaled by the aspect so the viewBox is the paper)
    return item.reference_rings.filter(ring => ring.length >= 3).map(ring => ring.map(p => {
      const q = fit.toPlan(p)
      return `${(q.x * aspect).toFixed(4)},${q.y.toFixed(4)}`
    }).join(' '))
  }, [item.pairs, item.reference_rings, aspect])
  const card = useRef<HTMLElement | null>(null)
  const image = useThumbnail(item.id, card)
  const proposal = !noProposal.has(item.status) && !waiting.has(item.status)
  const coverage = item.coverage != null ? fillTemplate(G.coverage, { n: Math.round(item.coverage * 100) }) : null
  const reason = item.reason ? (Object.entries(C.reasons).find(([key]) => key === item.reason)?.[1] ?? item.reason) : null
  const label = `${item.object_name} · ${item.title || item.module}`
  return <article ref={card} className={`adm-card${busy ? ' busy' : ''}`} role="listitem" aria-label={label} aria-busy={busy}>
    <button type="button" className="adm-card-pic" onClick={() => onOpen(item)} aria-label={fillTemplate(G.open, { name: label })} disabled={busy}>
      {image.url ? <img src={image.url} alt="" /> : <span className="adm-card-wait">{image.failed ? C.previewFailed : C.previewLoading}</span>}
      {image.url && outlines.length > 0 && <svg viewBox={`0 0 ${aspect} 1`} aria-hidden>
        <g fill="none" stroke="#d012d6" strokeWidth=".004" vectorEffect="non-scaling-stroke">{outlines.map((points, i) => <polygon key={i} points={points} />)}</g>
      </svg>}
    </button>
    <div className="adm-card-cap"><div className="adm-card-name"><b>{item.object_name}</b><small>{item.title || item.module}</small></div>
      <span className={`adm-align-status ${item.status}`}>{coverage && proposal ? coverage : C.status[item.status]}</span></div>
    {reason && !proposal && <p className="adm-card-reason">{reason}</p>}
    <div className="adm-card-foot">
      {(item.status === 'ready' || item.status === 'needs_review') && <>
        <button type="button" className="btn adm-card-yes" disabled={busy} onClick={() => onDecide(item, 'approve')}>{G.approve}</button>
        <button type="button" className="btn adm-card-no" disabled={busy} onClick={() => onDecide(item, 'reject')}>{G.reject}</button>
      </>}
      {noProposal.has(item.status) && <>
        <button type="button" className="btn" disabled={busy} onClick={() => onOpen(item)}>{G.byHand}</button>
        {item.status !== 'unsupported' && <button type="button" className="btn" disabled={busy} onClick={() => onDecide(item, 'retry')}>{C.retry}</button>}
      </>}
      {(item.status === 'approved' || item.status === 'rejected') && <button type="button" className="btn" disabled={busy} onClick={() => onDecide(item, 'undo')}>{G.undo}</button>}
      {waiting.has(item.status) && <span className="adm-hint">{C.status[item.status]}</span>}
    </div>
  </article>
}

/** Thumbnails load when the card scrolls near the viewport, and are released with the card. */
function useThumbnail(id: number, card: { current: HTMLElement | null }) {
  const [wanted, setWanted] = useState(typeof IntersectionObserver === 'undefined')
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false })
  useEffect(() => {
    const el = card.current
    if (wanted || !el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setWanted(true); io.disconnect() }
    }, { rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [card, wanted])
  useEffect(() => {
    if (!wanted) return
    const abort = new AbortController()
    let url: string | undefined
    void alignmentThumbnail(id, abort.signal).then(blob => {
      if (abort.signal.aborted) return
      url = URL.createObjectURL(blob); setState({ url, failed: false })
    }).catch(() => { if (!abort.signal.aborted) setState({ url: null, failed: true }) })
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url) }
  }, [id, wanted])
  return state
}
