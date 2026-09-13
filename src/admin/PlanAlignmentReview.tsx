import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import { ApiError } from '../lib/api'
import { fillTemplate } from '../lib/format'
import { hasAutoPairs, type GeorefPair, type PlanPt } from '../lib/georef'
import { reviewableAlignment } from '../lib/planAlignmentReview'
import { Slider } from '../components/Slider'
import { Segmented } from '../components/Segmented'
import { fmtDate } from './ui'
import { alignmentPreview, approveAlignment, loadAlignmentDetail, loadAlignmentQueue, rejectAlignment, retryAlignment, undoAlignmentApproval, type AlignmentItem, type AlignmentQueue } from './planAlignmentApi'
import { AlignmentGrid, type CardDecision, type CardMark } from './AlignmentGrid'
import './planAlignment.css'

const Preview = lazy(() => import('./AlignmentPreview'))
type Filter = 'open' | 'approved' | 'all'
const terminal = new Set(['approved', 'rejected'])
const waiting = new Set(['pending', 'processing'])
const priority = (item: AlignmentItem) => item.status === 'ready' ? 0 : item.status === 'needs_review' ? 1 : 2
/** The wall's sections, in the order the eye should meet them: sure things first, then the
 *  doubtful, then what the worker gave up on; decided sheets only under their own filter. */
type Section = 'ready' | 'needs_review' | 'none' | 'waiting' | 'approved' | 'rejected'
const sectionOf = (item: AlignmentItem): Section =>
  item.status === 'ready' || item.status === 'needs_review' || item.status === 'approved' || item.status === 'rejected' ? item.status
    : waiting.has(item.status) ? 'waiting' : 'none'
const SECTIONS: Section[] = ['ready', 'needs_review', 'none', 'waiting', 'approved', 'rejected']

/** Station preparation is explicit approval; fetching or selecting a proposal never publishes it. */
export function PlanAlignmentReview({ compact = false }: { compact?: boolean }) {
  const C = appConfig.copy.admin.alignment
  const M = C.columns
  const [queue, setQueue] = useState<AlignmentQueue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<{ id: number; byHand: boolean } | null>(null)
  const [busy, setBusy] = useState<Set<number>>(() => new Set())
  const [notice, setNotice] = useState<string | null>(null)
  // Staged marks: a ready proposal counts as «yes» until the reviewer says otherwise, a doubtful
  // one as undecided. Nothing is sent before «Übernehmen» — the wall is looked at, then applied.
  const [overrides, setOverrides] = useState<Map<number, CardMark | 'none'>>(() => new Map())
  const [filter, setFilter] = useState<Filter>('open')
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [approved, setApproved] = useState<AlignmentItem | null>(null)
  const [undoing, setUndoing] = useState(false)
  const alive = useRef(true)
  const loadSeq = useRef(0)
  const inFlight = useRef<Promise<void> | null>(null)

  const refresh = useCallback(() => {
    // Polling coalesces with a slow read instead of invalidating it every 15 seconds.
    if (inFlight.current) return inFlight.current
    const seq = ++loadSeq.current
    const request = (async () => {
      try {
        const next = await loadAlignmentQueue(compact)
        if (!alive.current || seq !== loadSeq.current) return
        // A stable order: by object, then module. The worker updating rows must not shuffle the
        // wall under the reviewer's eyes.
        next.items.sort((a, b) => priority(a) - priority(b) || a.object_name.localeCompare(b.object_name) || (a.module ?? '').localeCompare(b.module ?? ''))
        setQueue(next); setError(null)
        setOpen(o => o && next.items.some(item => item.id === o.id) ? o : null)
      } catch (e) {
        if (alive.current && seq === loadSeq.current) setError(e instanceof ApiError ? e.detail : appConfig.copy.admin.alignment.loadFailed)
      }
    })()
    inFlight.current = request
    void request.finally(() => { if (inFlight.current === request) inFlight.current = null })
    return request
  }, [compact])

  useEffect(() => {
    alive.current = true
    // The refresh changes React state only after its network request settles.
    void refresh()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 15000)
    // This is a request generation counter, deliberately invalidated at teardown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { alive.current = false; ++loadSeq.current; inFlight.current = null; window.clearInterval(timer) }
  }, [refresh])

  const update = (next: AlignmentItem) => {
    ++loadSeq.current // a list request from before the decision must not overwrite its response
    setQueue(q => q ? { ...q, items: q.items.map(item => item.id === next.id ? next : item) } : q)
  }
  const items = queue?.items ?? []
  const isOpen = (item: AlignmentItem) => item.is_current && !terminal.has(item.status) && (!compact || item.status !== 'unsupported')
  const visible = items.filter(item => (filter === 'all' || (filter === 'approved' ? terminal.has(item.status) : isOpen(item)))
    && `${item.object_name} ${item.module} ${item.title ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  // A filtered wall must never open or decide a hidden card.
  const current = open ? visible.find(item => item.id === open.id) ?? null : null
  const count = items.filter(isOpen).length
  const sections = SECTIONS.map(section => ({ section, items: visible.filter(item => sectionOf(item) === section) })).filter(s => s.items.length)

  const mark = (id: number, on: boolean) => setBusy(prev => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next })
  const markOf = (item: AlignmentItem): CardMark | null => {
    if (item.status !== 'ready' && item.status !== 'needs_review') return null
    const override = overrides.get(item.id)
    return override === 'none' ? null : override ?? (item.status === 'ready' ? 'yes' : null)
  }
  const setMark = (item: AlignmentItem, next: CardMark | null) => setOverrides(prev => { const m = new Map(prev); m.set(item.id, next ?? 'none'); return m })
  /** One sheet's decision. Approval re-reads the exact revision first: the summary row can never
   *  approve by itself (its page count is unknown), and the server gets the freshest token. */
  const decide = async (item: AlignmentItem, decision: CardDecision | 'approve' | 'reject', quiet = false): Promise<boolean> => {
    mark(item.id, true); setError(null)
    try {
      let next: AlignmentItem
      if (decision === 'approve') {
        const detail = await loadAlignmentDetail(item.id)
        if (!detail.can_approve || !reviewableAlignment(detail.pairs, detail.aspect)) throw new ApiError(422, C.saveFailed)
        next = await approveAlignment(detail, detail.pairs)
      } else next = decision === 'reject' ? await rejectAlignment(item) : decision === 'undo' ? await undoAlignmentApproval(item) : await retryAlignment(item)
      if (!alive.current) return false
      update(next)
      if (!quiet) { setApproved(null); setNotice(null) }
      return true
    } catch (e) {
      if (!alive.current) return false
      setError(e instanceof ApiError && e.status === 409 ? C.conflict : e instanceof ApiError ? e.detail : C.saveFailed)
      if (e instanceof ApiError && e.status === 409) await refresh()
      return false
    } finally { if (alive.current) mark(item.id, false) }
  }
  /** «Übernehmen»: every marked card of the visible wall, one after the other, stopping at the
   *  first refusal so nothing is skipped silently; the banner then says how far it got. */
  const staged = visible.filter(item => markOf(item) != null)
  const yesCount = staged.filter(item => markOf(item) === 'yes').length
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const apply = async () => {
    const list = staged.map(item => ({ item, mark: markOf(item) }))
    setBatch({ done: 0, total: list.length }); setApproved(null); setNotice(null)
    let yes = 0, no = 0
    for (const { item, mark: m } of list) {
      if (!alive.current) return
      if (!await decide(item, m === 'yes' ? 'approve' : 'reject', true)) break
      if (m === 'yes') yes += 1; else no += 1
      setBatch({ done: yes + no, total: list.length })
    }
    if (!alive.current) return
    setBatch(null); setOverrides(new Map())
    setNotice(fillTemplate(C.grid.applied, { yes, no, total: list.length }))
  }

  return <section className={`adm-align${compact ? ' am-module-review' : ''}`} aria-label={C.title}>
    <div className="adm-align-heading"><div><h2>{C.title}</h2>{!compact && <p className="adm-hint">{C.intro}</p>}</div>
      <div className="adm-align-actions">
        {staged.length > 0 && <span className="adm-hint adm-apply-summary">{batch ? fillTemplate(C.grid.applying, batch) : fillTemplate(C.grid.applySummary, { yes: yesCount, no: staged.length - yesCount })}</span>}
        {overrides.size > 0 && <button type="button" className="btn" disabled={!!batch} onClick={() => setOverrides(new Map())}>{C.grid.resetMarks}</button>}
        <button type="button" className="btn" disabled={refreshing || !!batch} onClick={async () => { setRefreshing(true); await refresh(); if (alive.current) setRefreshing(false) }}>{refreshing ? C.loading : C.refresh}</button>
        {staged.length > 0 && <button type="button" className="btn primary" disabled={!!batch || busy.size > 0} onClick={() => void apply()}>{fillTemplate(C.grid.apply, { n: staged.length })}</button>}
      </div>
    </div>
    {error && <p className="adm-state adm-state-err" role="alert">{error}</p>}
    {queue && !queue.capability.available && <p className="adm-align-notice" role="status">{C.unavailableHint}</p>}
    {approved && <div className="adm-align-confirmed" role="status"><span>{fillTemplate(C.approvedMessage, { name: approved.object_name })}</span><button className="btn" type="button" disabled={undoing} onClick={async () => {
      setUndoing(true)
      try { const next = await undoAlignmentApproval(approved); if (alive.current) { update(next); setApproved(null) } }
      catch (e) { if (alive.current) setError(e instanceof ApiError ? e.detail : C.saveFailed) }
      finally { if (alive.current) setUndoing(false) }
    }}>{C.undoApproval}</button></div>}
    {notice && !approved && <p className="adm-align-confirmed" role="status">{notice}</p>}
    <div className="adm-align-filters"><Segmented<Filter> value={filter} onChange={setFilter} ariaLabel={C.filterLabel} options={[
      { value: 'open', label: fillTemplate(C.openCount, { n: count }) }, { value: 'approved', label: C.grid.decided }, { value: 'all', label: C.all },
    ]} /><input className="adm-input" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={C.search} aria-label={C.search} /></div>
    {!queue && !error && <p className="adm-state" role="status">{C.loading}</p>}
    {queue && visible.length === 0 && <p className="adm-hint adm-align-empty">{items.length === 0 ? C.empty : C.noResults}</p>}
    {sections.map(({ section, items: list }) => <div key={section} className="adm-grid-section">
      <div className="adm-grid-head"><h3>{C.grid.sections[section]}</h3><span className="adm-hint">{fillTemplate(C.queueCount, { n: list.length })}</span></div>
      <AlignmentGrid items={list} busy={busy} markOf={markOf} onMark={setMark} onDecide={(item, decision) => void decide(item, decision)} onOpen={(item, byHand) => setOpen({ id: item.id, byHand: !!byHand })} />
    </div>)}
    {current && <AlignmentModal item={current} onClose={() => setOpen(null)}>
      <ResolvedAlignmentDetail key={current.id} item={current} byHand={open?.byHand} onChange={update} onApproved={next => { setApproved(next); if (next) setNotice(null) }} onConflict={refresh} />
    </AlignmentModal>}
  </section>
}

/** The full instrument (map, nudges, points) over the wall — a plain fixed layer, not the
 *  shared Popover, because the wall underneath must not react to the presses that close it. */
function AlignmentModal({ item, onClose, children }: { item: AlignmentItem; onClose: () => void; children: ReactNode }) {
  const C = appConfig.copy.admin.alignment
  const closeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    document.addEventListener('keydown', onKey)
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; previous?.focus() }
  }, [onClose])
  return <div className="adm-modal" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="adm-modal-box" role="dialog" aria-modal="true" aria-label={`${item.object_name} · ${item.title || item.module}`}>
      <div className="adm-modal-bar"><button ref={closeRef} type="button" className="btn" onClick={onClose}>{C.grid.close}</button></div>
      {children}
    </div>
  </div>
}

interface DetailProps {
  item: AlignmentItem
  /** open straight in reference-point pairing – the sheet is being aligned by hand */
  byHand?: boolean
  onChange: (next: AlignmentItem) => void
  onApproved: (next: AlignmentItem | null) => void
  onConflict: () => Promise<void>
}

// Only the selected PDF needs its exact page count. Summary rows can never enable approval.
function ResolvedAlignmentDetail(props: DetailProps) {
  const C = appConfig.copy.admin.alignment
  const [detail, setDetail] = useState<AlignmentItem | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const { id, edit_version } = props.item
  useEffect(() => {
    let alive = true
    void loadAlignmentDetail(id).then(next => {
      if (alive) { setDetail(next); setError(false) }
    }).catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [id, edit_version, attempt])
  const resolved = detail?.edit_version === edit_version ? detail : props.item
  return <>
    {error && <p className="am-error" role="alert">{C.loadFailed} <button className="btn" type="button" onClick={() => setAttempt(n => n + 1)}>{C.refresh}</button></p>}
    {!detail ? <p className="adm-align-empty" role="status">{C.loading}</p>
      : <AlignmentDetail {...props} item={resolved} onChange={next => { setDetail(next); props.onChange(next) }} />}
  </>
}

function AlignmentDetail({ item, byHand = false, onChange, onApproved, onConflict }: DetailProps) {
  const C = appConfig.copy.admin.alignment
  const [draft, setDraft] = useState<{ pairs: GeorefPair[]; editVersion: number } | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [imageFailed, setImageFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // By hand = the same reference-point pairing the field uses (plan point, then the same spot
  // on the map); two real pairs replace whatever the worker proposed. There is no other way to
  // change a fit here: a proposal is approved as it is, or aligned by hand.
  const [manual, setManual] = useState(byHand)
  const [point, setPoint] = useState<PlanPt | null>(null)
  const [opacity, setOpacity] = useState(60)
  const mounted = useRef(true)
  const pairs = draft?.pairs ?? item.pairs
  const stale = draft != null && draft.editVersion !== item.edit_version
  const editable = item.can_approve && !waiting.has(item.status)
  const reason = Object.entries(C.reasons).find(([key]) => key === item.reason)?.[1] ?? item.reason

  useEffect(() => {
    mounted.current = true
    const abort = new AbortController()
    let url: string | undefined
    void alignmentPreview(item.id, abort.signal).then(blob => {
      if (abort.signal.aborted) return
      url = URL.createObjectURL(blob); setImage(url)
    }).catch(() => { if (!abort.signal.aborted) setImageFailed(true) })
    return () => { mounted.current = false; abort.abort(); if (url) URL.revokeObjectURL(url) }
  }, [item.id])

  const setPairs = (next: GeorefPair[]) => setDraft(previous => ({ pairs: next, editVersion: previous?.editVersion ?? item.edit_version }))
  const reset = () => { setDraft(null); setPoint(null); setManual(byHand); setError(null) }
  const save = async (operation: 'approve' | 'retry' | 'undo') => {
    setBusy(true); setError(null)
    try {
      const next = operation === 'approve' ? await approveAlignment(item, pairs) : operation === 'undo' ? await undoAlignmentApproval(item) : await retryAlignment(item)
      if (!mounted.current) return
      onChange(next); reset(); if (operation === 'approve') onApproved(next); else if (operation === 'undo') onApproved(null)
    } catch (e) {
      if (!mounted.current) return
      setError(e instanceof ApiError && e.status === 409 ? C.conflict : e instanceof ApiError ? e.detail : C.saveFailed)
      if (e instanceof ApiError && e.status === 409) await onConflict()
    } finally { if (mounted.current) setBusy(false) }
  }

  return <section className="adm-align-review" aria-label={item.object_name}>
    <header><div><h3>{item.object_name} · {item.title || item.module}</h3><p>{fillTemplate(C.revisionPage, { version: item.plan_version, page: item.page + 1 })}</p></div><span className={`adm-align-status ${item.status}`}>{C.status[item.status]}</span></header>
    {!item.is_current && <p className="adm-align-notice">{C.superseded}</p>}
    {reason && <p className="adm-align-notice">{reason}</p>}
    {imageFailed ? <p className="adm-state adm-state-err" role="alert">{C.previewFailed}</p> : image ? <Suspense fallback={<p className="adm-state">{C.loading}</p>}><Preview item={item} pairs={pairs} imageUrl={image} opacity={opacity} manual={manual} pendingPoint={point} onPlanPoint={setPoint} onMapPoint={lngLat => {
      if (!point) return
      const real = pairs.filter(p => p.kind !== 'auto')
      setPairs([...real, { plan: point, lngLat, kind: 'gesetzt' }]); setPoint(null)
    }} /></Suspense> : <p className="adm-state" role="status">{C.previewLoading}</p>}
    <div className="adm-align-settings"><span>{C.opacity}</span><Slider value={opacity} onChange={setOpacity} ariaLabel={C.opacity} valueText={`${opacity} %`} /><span className="adm-align-number">{opacity} %</span></div>
    <div className="adm-align-facts"><div><p className="adm-align-provenance">{!pairs.length ? C.unaligned : hasAutoPairs(pairs) ? C.automatic : C.manual}</p><p className="adm-hint">{C.reviewHint}</p></div><dl><div><dt>{C.planDate}</dt><dd>{fmtDate(item.created_at)}</dd></div><div><dt>{C.reference}</dt><dd>{item.reference_source ?? C.referenceUnknown}{item.reference_at ? ` · ${fmtDate(item.reference_at)}` : ''}</dd></div><div><dt>{C.approvalDate}</dt><dd>{item.approved_at ? fmtDate(item.approved_at) : C.notApproved}</dd></div></dl></div>
    {manual && editable && <div className="adm-align-adjust"><p className="adm-hint">{point ? C.pickOnMap : C.pickOnPlan} {C.keyboardPoints}</p>
      <div className="adm-align-actions"><button type="button" className="btn" disabled={busy || !pairs.some(p => p.kind !== 'auto')} onClick={() => { setPairs(pairs.filter(p => p.kind !== 'auto').slice(0, -1)); setPoint(null) }}>{C.undoPoint}</button>
        <button type="button" className="btn" disabled={busy || !draft} onClick={reset}>{C.discardAdjustment}</button></div></div>}
    {stale && <p className="adm-align-notice" role="alert">{C.conflict} <button type="button" className="btn" onClick={reset}>{C.discardAdjustment}</button></p>}
    {error && <p className="adm-state adm-state-err" role="alert">{error}</p>}
    <footer><p>{C.scope}</p><div className="adm-align-actions">
      {item.status === 'approved' && <button type="button" className="btn" disabled={busy} onClick={() => void save('undo')}>{C.withdrawApproval}</button>}
      {editable && ['no_match', 'failed', 'unavailable'].includes(item.status) && <button type="button" className="btn" disabled={busy || !!draft} onClick={() => void save('retry')}>{C.retry}</button>}
      {editable && <button type="button" className="btn primary" disabled={busy || stale || !image || imageFailed || !!point || !reviewableAlignment(pairs, item.aspect)} onClick={() => void save('approve')}>{busy ? C.saving : C.approve}</button>}
    </div></footer>
  </section>
}
