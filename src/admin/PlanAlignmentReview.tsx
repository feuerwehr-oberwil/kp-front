import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { ApiError } from '../lib/api'
import { fillTemplate } from '../lib/format'
import { hasAutoPairs, nudgePairsOnMap, type GeorefPair, type PlanPt } from '../lib/georef'
import { reviewableAlignment } from '../lib/planAlignmentReview'
import { Slider } from '../components/Slider'
import { Stepper } from '../components/Stepper'
import { Segmented } from '../components/Segmented'
import { fmtDate } from './ui'
import { alignmentPreview, approveAlignment, loadAlignmentDetail, loadAlignmentQueue, retryAlignment, undoAlignmentApproval, type AlignmentItem, type AlignmentQueue } from './planAlignmentApi'
import './planAlignment.css'

const Preview = lazy(() => import('./AlignmentPreview'))
type Filter = 'open' | 'approved' | 'all'
const terminal = new Set(['approved', 'rejected'])
const waiting = new Set(['pending', 'processing'])
const priority = (item: AlignmentItem) => item.status === 'ready' ? 0 : item.status === 'needs_review' ? 1 : 2

/** Station preparation is explicit approval; fetching or selecting a proposal never publishes it. */
export function PlanAlignmentReview({ compact = false }: { compact?: boolean }) {
  const C = appConfig.copy.admin.alignment
  const M = C.columns
  const [queue, setQueue] = useState<AlignmentQueue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
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
        next.items.sort((a, b) => priority(a) - priority(b))
        setQueue(next); setError(null)
        setSelected(id => id != null && next.items.some(item => item.id === id) ? id : next.items.find(item => item.is_current && !terminal.has(item.status))?.id ?? next.items[0]?.id ?? null)
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
  const visible = items.filter(item => (filter === 'all' || (filter === 'approved' ? item.status === 'approved' : isOpen(item)))
    && `${item.object_name} ${item.module} ${item.title ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  // A filtered table must never display or approve a different, hidden selection.
  const current = compact ? visible.find(item => item.id === selected) ?? visible[0] : items.find(item => item.id === selected)
  const count = items.filter(isOpen).length

  return <section className={`adm-align${compact ? ' am-module-review' : ''}`} aria-label={C.title}>
    <div className="adm-align-heading"><div><h2>{C.title}</h2>{!compact && <p className="adm-hint">{C.intro}</p>}</div>
      <button type="button" className="btn" disabled={refreshing} onClick={async () => { setRefreshing(true); await refresh(); if (alive.current) setRefreshing(false) }}>{refreshing ? C.loading : C.refresh}</button>
    </div>
    {error && <p className="adm-state adm-state-err" role="alert">{error}</p>}
    {queue && !queue.capability.available && <p className="adm-align-notice" role="status">{C.unavailableHint}</p>}
    {approved && <div className="adm-align-confirmed" role="status"><span>{fillTemplate(C.approvedMessage, { name: approved.object_name })}</span><button className="btn" type="button" disabled={undoing} onClick={async () => {
      setUndoing(true)
      try { const next = await undoAlignmentApproval(approved); if (alive.current) { update(next); setApproved(null) } }
      catch (e) { if (alive.current) setError(e instanceof ApiError ? e.detail : C.saveFailed) }
      finally { if (alive.current) setUndoing(false) }
    }}>{C.undoApproval}</button></div>}
    <div className="adm-align-filters"><Segmented<Filter> value={filter} onChange={setFilter} ariaLabel={C.filterLabel} options={[
      { value: 'open', label: fillTemplate(C.openCount, { n: count }) }, { value: 'approved', label: C.approved }, { value: 'all', label: C.all },
    ]} /><input className="adm-input" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={C.search} aria-label={C.search} /></div>
    {!queue && !error && <p className="adm-state" role="status">{C.loading}</p>}
    {queue && <div className="adm-align-split"><div className="adm-align-queue" aria-label={C.queueLabel}>
      <h3>{fillTemplate(C.queueCount, { n: visible.length })}</h3>
      {visible.length === 0 && <p className="adm-hint adm-align-empty">{items.length === 0 ? C.empty : C.noResults}</p>}
      {compact ? <table className="am-table am-review-table"><thead><tr><th scope="col">{M.object}</th><th scope="col">{M.module}</th><th scope="col">{M.revision}</th><th scope="col">{M.status}</th></tr></thead>
        <tbody>{visible.map(item => <tr key={item.id} className={current?.id === item.id ? 'am-selected' : undefined}>
          <th scope="row"><button type="button" className="am-row-pick" aria-pressed={current?.id === item.id} onClick={() => setSelected(item.id)}>{item.object_name}</button></th>
          <td>{item.title || item.module}</td><td>{fillTemplate(C.revisionPage, { version: item.plan_version, page: item.page + 1 })}</td>
          <td><span className={`adm-align-status ${item.status}`}>{C.status[item.status]}</span></td>
        </tr>)}</tbody></table> : visible.map(item => <button type="button" key={item.id} className={`adm-align-item${selected === item.id ? ' on' : ''}`} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>
        <strong>{item.object_name}</strong><span>{item.title || item.module}</span><small>{fillTemplate(C.revisionPage, { version: item.plan_version, page: item.page + 1 })}</small>
        <span className={`adm-align-status ${item.status}`}>{C.status[item.status]}</span>
      </button>)}
    </div><div className="adm-align-detail">{current ? compact
      ? <ResolvedAlignmentDetail key={current.id} item={current} onChange={update} onApproved={setApproved} onConflict={refresh} />
      : <AlignmentDetail key={current.id} item={current} onChange={update} onApproved={setApproved} onConflict={refresh} />
      : <p className="adm-align-empty">{C.selectPlan}</p>}</div></div>}
  </section>
}

interface DetailProps {
  item: AlignmentItem
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

function AlignmentDetail({ item, onChange, onApproved, onConflict }: DetailProps) {
  const C = appConfig.copy.admin.alignment
  const [draft, setDraft] = useState<{ pairs: GeorefPair[]; editVersion: number } | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [imageFailed, setImageFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adjust, setAdjust] = useState(false)
  const [manual, setManual] = useState(false)
  const [point, setPoint] = useState<PlanPt | null>(null)
  const [opacity, setOpacity] = useState(60)
  const [offset, setOffset] = useState({ east: 0, north: 0, turn: 0 })
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
  const reset = () => { setDraft(null); setOffset({ east: 0, north: 0, turn: 0 }); setPoint(null); setManual(false); setError(null) }
  const nudge = (kind: keyof typeof offset, value: number) => {
    const delta = value - offset[kind]
    setPairs(nudgePairsOnMap(pairs, kind === 'east' ? { dxM: delta } : kind === 'north' ? { dyM: delta } : { rotDeg: delta }))
    setOffset(old => ({ ...old, [kind]: value }))
  }
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
    {adjust && editable && <div className="adm-align-adjust"><div className="adm-align-nudges">
      <label>{C.east}<Stepper value={offset.east} min={-500} max={500} onChange={v => nudge('east', v)} ariaLabel={C.east} format={n => `${n} m`} readOnly={!pairs.length || busy || manual} /></label>
      <label>{C.north}<Stepper value={offset.north} min={-500} max={500} onChange={v => nudge('north', v)} ariaLabel={C.north} format={n => `${n} m`} readOnly={!pairs.length || busy || manual} /></label>
      <label>{C.turn}<Stepper value={offset.turn} min={-180} max={180} onChange={v => nudge('turn', v)} ariaLabel={C.turn} format={n => `${n}°`} readOnly={!pairs.length || busy || manual} /></label>
    </div><div className="adm-align-actions"><button type="button" className="btn" disabled={busy} aria-pressed={manual} onClick={() => { setManual(v => !v); setPoint(null) }}>{manual ? C.showOverlay : C.setPoints}</button><button type="button" className="btn" disabled={busy || !draft} onClick={reset}>{C.discardAdjustment}</button>
      {manual && <button type="button" className="btn" disabled={busy || !pairs.some(p => p.kind !== 'auto')} onClick={() => { setPairs(pairs.filter(p => p.kind !== 'auto').slice(0, -1)); setPoint(null) }}>{C.undoPoint}</button>}
    </div>{manual && <p className="adm-hint">{point ? C.pickOnMap : C.pickOnPlan} {C.keyboardPoints}</p>}</div>}
    {stale && <p className="adm-align-notice" role="alert">{C.conflict} <button type="button" className="btn" onClick={reset}>{C.discardAdjustment}</button></p>}
    {error && <p className="adm-state adm-state-err" role="alert">{error}</p>}
    <footer><p>{C.scope}</p><div className="adm-align-actions">
      {item.status === 'approved' && <button type="button" className="btn" disabled={busy} onClick={() => void save('undo')}>{C.withdrawApproval}</button>}
      {editable && <button type="button" className="btn" disabled={busy} aria-expanded={adjust} onClick={() => setAdjust(v => !v)}>{C.adjust}</button>}
      {editable && ['no_match', 'failed', 'unavailable'].includes(item.status) && <button type="button" className="btn" disabled={busy || !!draft} onClick={() => void save('retry')}>{C.retry}</button>}
      {editable && <button type="button" className="btn primary" disabled={busy || stale || !image || imageFailed || !!point || !reviewableAlignment(pairs, item.aspect)} onClick={() => void save('approve')}>{busy ? C.saving : C.approve}</button>}
    </div></footer>
  </section>
}
