import { useEffect, useMemo, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { fitSimilarity, type GeoPt } from '../lib/georef'
import { alignmentThumbnail, loadAlignmentOutline, type AlignmentListItem } from './planAlignmentApi'
import { signedIndex } from './floorPack'

/** An immediate action from a card footer (the modal carries the slow path). */
export type CardDecision = 'undo'
/** A staged decision: nothing happens until «Übernehmen». */
export type CardMark = 'yes' | 'no'

/** The review wall: every sheet as a thumbnail with the building outlines drawn through the
 *  proposed fit, judged at a glance, decided from the card's footer. Cards come grouped by
 *  what the worker said; the parent owns the decisions and the modal. */
export function AlignmentGrid({ items, busy, markOf, onMark, onDecide, onOpen }: {
  items: AlignmentListItem[]
  /** ids with a decision in flight */
  busy: Set<number>
  /** the staged mark of a proposal card (ready sheets default to yes) */
  markOf: (item: AlignmentListItem) => CardMark | null
  onMark: (item: AlignmentListItem, mark: CardMark | null) => void
  onDecide: (item: AlignmentListItem, decision: CardDecision) => void
  /** open the full instrument – it starts in the reference-point pairing, whatever the status */
  onOpen: (item: AlignmentListItem) => void
}) {
  return <div className="adm-grid" role="list">
    {items.map(item => <AlignmentCard key={item.id} item={item} busy={busy.has(item.id)} mark={markOf(item)} onMark={onMark} onDecide={onDecide} onOpen={onOpen} />)}
  </div>
}

/** «1», «2/3», «6» — the module as the nav rail spells it; a name alone cannot tell the
 *  Übersicht from the Grundriss of the same object. */
const moduleCode = (module: string | null) => (module ?? '').replace(/^modul/, '').replace(/[-_]/g, '/') || '?'


const noProposal = new Set(['no_match', 'failed', 'unavailable', 'unsupported'])
const waiting = new Set(['pending', 'processing'])

/** The worker's `reason` key as the admin copy spells it – the raw key if a locale has none. */
export const reasonText = (reason: string | null): string | null =>
  reason ? (appConfig.copy.admin.alignment.reasons as Record<string, string>)[reason] ?? reason : null

function AlignmentCard({ item, busy, mark, onMark, onDecide, onOpen }: {
  item: AlignmentListItem; busy: boolean; mark: CardMark | null
  onMark: (item: AlignmentListItem, mark: CardMark | null) => void
  onDecide: (item: AlignmentListItem, decision: CardDecision) => void
  onOpen: (item: AlignmentListItem) => void
}) {
  const C = appConfig.copy.admin.alignment
  const G = C.grid
  const aspect = item.aspect && Number.isFinite(item.aspect) && item.aspect > 0 ? item.aspect : 1.414
  const card = useRef<HTMLElement | null>(null)
  const near = useNearViewport(card)
  const image = useThumbnail(item.id, near)
  // A sheet without a fit can have no outlines, so it asks for none.
  const rings = useOutlineRings(item.id, near && item.pairs.length >= 2)
  const outlines = useMemo(() => {
    const fit = rings.length ? fitSimilarity(item.pairs, aspect) : null
    if (!fit) return []
    // WGS84 rings → normalized sheet coordinates (x scaled by the aspect so the viewBox is the paper)
    return rings.filter(ring => ring.length >= 3).map(ring => ring.map(p => {
      const q = fit.toPlan(p)
      return `${(q.x * aspect).toFixed(4)},${q.y.toFixed(4)}`
    }).join(' '))
  }, [item.pairs, rings, aspect])
  const proposal = !noProposal.has(item.status) && !waiting.has(item.status)
  const coverage = item.coverage != null ? fillTemplate(G.coverage, { n: Math.round(item.coverage * 100) }) : null
  const reason = reasonText(item.reason)
  const label = `${item.object_name} · ${moduleCode(item.module)}`
  // a multi-page PDF says what it is: «4 Seiten» until its pages are floors, then «4 Geschosse · −1 bis +2»
  const indices = item.floors.map(f => f.index)
  const pack = item.floors.length ? fillTemplate(G.floorsSummary, { n: item.floors.length, from: signedIndex(Math.min(...indices)), to: signedIndex(Math.max(...indices)) })
    : (item.page_count ?? 0) > 1 ? fillTemplate(G.pages, { n: item.page_count ?? 0 }) : null
  return <article ref={card} className={`adm-card${busy ? ' busy' : ''}${mark ? ` ${mark}` : ''}`} role="listitem" aria-label={label} aria-busy={busy}>
    <button type="button" className="adm-card-pic" onClick={() => onOpen(item)} aria-label={fillTemplate(G.open, { name: label })} disabled={busy}>
      {image.url ? <img src={image.url} alt="" /> : <span className="adm-card-wait">{image.failed ? C.previewFailed : C.previewLoading}</span>}
      {image.url && outlines.length > 0 && <svg viewBox={`0 0 ${aspect} 1`} aria-hidden>
        <g fill="none" stroke="#d012d6" strokeWidth=".004" vectorEffect="non-scaling-stroke">{outlines.map((points, i) => <polygon key={i} points={points} />)}</g>
      </svg>}
    </button>
    <div className="adm-card-cap"><b className="adm-card-name">{item.object_name}</b>
      <span className="adm-card-meta"><span className="adm-card-code">{moduleCode(item.module)}</span>{coverage && proposal ? coverage : <span className={`adm-align-status ${item.status}`}>{C.status[item.status]}</span>}</span></div>
    {pack && <p className="adm-card-reason">{pack}</p>}
    {reason && !proposal && <p className="adm-card-reason">{reason}</p>}
    <div className="adm-card-foot">
      {(item.status === 'ready' || item.status === 'needs_review') && <>
        <button type="button" className="btn adm-card-yes" disabled={busy} aria-pressed={mark === 'yes'} aria-label={G.approve} title={G.approve} onClick={() => onMark(item, mark === 'yes' ? null : 'yes')}>✓</button>
        <button type="button" className="btn adm-card-no" disabled={busy} aria-pressed={mark === 'no'} aria-label={G.reject} title={G.reject} onClick={() => onMark(item, mark === 'no' ? null : 'no')}>✕</button>
      </>}
      {noProposal.has(item.status) && <button type="button" className="btn" disabled={busy} onClick={() => onOpen(item)}>{G.byHand}</button>}
      {(item.status === 'approved' || item.status === 'rejected') && <button type="button" className="btn" disabled={busy} onClick={() => onDecide(item, 'undo')}>{G.undo}</button>}
      {waiting.has(item.status) && <span className="adm-hint">{C.status[item.status]}</span>}
    </div>
  </article>
}

/** The card's one lazy gate: true once it has scrolled near the viewport. Both of a tile's
 *  per-sheet reads – its thumbnail and its outlines – hang off this, so a wall of 450 sheets
 *  costs two requests per card the reviewer actually looks at and nothing for the rest. */
function useNearViewport(card: { current: HTMLElement | null }) {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = card.current
    if (near || !el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setNear(true); io.disconnect() }
    }, { rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [card, near])
  return near
}

/** Thumbnails load when the card scrolls near the viewport, and are released with the card. */
function useThumbnail(id: number, wanted: boolean) {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false })
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

/** The building outlines of ONE sheet, fetched beside its thumbnail; the tile renders without
 *  them until they arrive, and a failed read simply leaves the thumbnail bare. */
function useOutlineRings(id: number, wanted: boolean) {
  const [rings, setRings] = useState<GeoPt[][]>([])
  useEffect(() => {
    if (!wanted) return
    const abort = new AbortController()
    void loadAlignmentOutline(id, abort.signal)
      .then(outline => { if (!abort.signal.aborted) setRings(outline.reference_rings) })
      .catch(() => { if (!abort.signal.aborted) setRings([]) })
    return () => abort.abort()
  }, [id, wanted])
  return rings
}
