import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import { ApiError } from '../lib/api'
import { fillTemplate } from '../lib/format'
import { Icon } from '../lib/icons'
import { hasAutoPairs, type GeorefPair } from '../lib/georef'
import { reviewableAlignment } from '../lib/planAlignmentReview'
import { Overlay } from '../lib/overlays/Overlay'
import { ConfirmCard } from '../lib/overlays/ConfirmCard'
import { Slider } from '../components/Slider'
import { Segmented } from '../components/Segmented'
import { fmtDate, StatusBadge } from './ui'
import { InfoTip } from './InfoTip'
import { alignmentPreview, approveAlignment, loadAlignmentDetail, loadAlignmentQueue, rejectAlignment, retryAlignment, undoAlignmentApproval, type AlignmentItem, type AlignmentListItem, type AlignmentQueue, type AlignmentStatus } from './planAlignmentApi'
import { AlignmentGrid, reasonText, type CardDecision, type CardMark } from './AlignmentGrid'
import { FloorPackEditor, type FloorDraft } from './FloorPackEditor'
import { moduleHiddenWithGebaeude } from '../lib/deploymentConfig'
import { savePlanFloors } from './planAlignmentApi'
import './planAlignment.css'

const Preview = lazy(() => import('./AlignmentPreview'))
const Pairing = lazy(() => import('./AlignmentPairing'))
type Filter = 'open' | 'approved' | 'all'
const terminal = new Set(['approved', 'rejected'])
const waiting = new Set(['pending', 'processing'])
const priority = (item: AlignmentListItem) => item.status === 'ready' ? 0 : item.status === 'needs_review' ? 1 : 2
/** The wall's sections, in the order the eye should meet them: sure things first, then the
 *  doubtful, then what the worker gave up on; decided sheets only under their own filter. */
type Section = 'ready' | 'needs_review' | 'none' | 'waiting' | 'approved' | 'rejected'
const sectionOf = (item: AlignmentListItem): Section =>
  item.status === 'ready' || item.status === 'needs_review' || item.status === 'approved' || item.status === 'rejected' ? item.status
    : waiting.has(item.status) ? 'waiting' : 'none'
const SECTIONS: Section[] = ['ready', 'needs_review', 'none', 'waiting', 'approved', 'rejected']
/** Reasons worth repeating inside the modal: the ones aligning by hand cannot answer, because
 *  they want an admin, a config or the server. `low_coverage`, `no_matching_geometry`,
 *  `invalid_match` and `manual_module` are exactly what this modal is for – the card already
 *  said «Kein Treffer», and saying it twice only shouts at someone already setting points. */
const BEYOND_PAIRING = new Set(['reference_unreachable', 'printed_scale_missing', 'object_coordinates_missing', 'pdf_unavailable', 'revision_missing', 'preparation_failed', 'georef_dependencies_missing', 'overpass_unconfigured', 'worker_retry_limit', 'multi_page_document', 'unsupported_module'])
/** …and of those, the ones a fresh run can still fix, which is when «Neu berechnen» is offered. */
const RETRYABLE = new Set(['reference_unreachable', 'worker_retry_limit', 'preparation_failed', 'invalid_match'])

/**
 * A page that ALREADY holds the queue hands it in, and the wall then fetches nothing of its own.
 * All three pieces together or none: a queue you cannot write back to would strand every
 * decision, and one you cannot re-read would strand every 409.
 */
export interface AlignmentQueueSource {
  /** null while the owner's first read is still running */
  queue: AlignmentQueue | null
  /** one decided sheet, back into the owner's copy */
  update: (next: AlignmentListItem) => void
  /** re-read everything – the answer to a conflict */
  reload: () => Promise<void>
}

/**
 * Station preparation is explicit approval; fetching or selecting a proposal never publishes it.
 *
 * `embedded` is the wall AS A TAB of the Objektpläne page (Objekte · Vorschläge · Übersicht):
 * the page already carries the heading, the ⓘ and the polling, so the wall drops its own h2,
 * its intro sentence, its Offen/Entschieden/Alle filter and its «Aktualisieren» — and keeps
 * exactly what the tab is for: the search, the staged ✓/✕ per tile, and «Übernehmen». Pinned to
 * the proposals, because that is what the tab counts in its badge.
 *
 * ⚠️ That tab also passes its own `source`: the Objektpläne page needs the queue for its object
 * table anyway, and two components polling the same list every 15 s downloaded it twice.
 */
export function PlanAlignmentReview({ compact = false, embedded = false, source }: {
  compact?: boolean
  embedded?: boolean
  source?: AlignmentQueueSource
}) {
  const C = appConfig.copy.admin.alignment
  const [ownQueue, setOwnQueue] = useState<AlignmentQueue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [busy, setBusy] = useState<Set<number>>(() => new Set())
  const [notice, setNotice] = useState<string | null>(null)
  // Staged marks: a ready proposal counts as «yes» until the reviewer says otherwise, a doubtful
  // one as undecided. Nothing is sent before «Übernehmen» — the wall is looked at, then applied.
  const [overrides, setOverrides] = useState<Map<number, CardMark | 'none'>>(() => new Map())
  const [filter, setFilter] = useState<Filter>('open')
  // A tab shows only what it counted; the standalone wall keeps its own three-way filter.
  const effectiveFilter: Filter = embedded ? 'open' : filter
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const alive = useRef(true)
  const loadSeq = useRef(0)
  const inFlight = useRef<Promise<void> | null>(null)

  const owns = !source
  const reload = source?.reload
  const refresh = useCallback(() => {
    if (reload) return reload()
    // Polling coalesces with a slow read instead of invalidating it every 15 seconds.
    if (inFlight.current) return inFlight.current
    const seq = ++loadSeq.current
    const request = (async () => {
      try {
        const next = await loadAlignmentQueue()
        if (!alive.current || seq !== loadSeq.current) return
        setOwnQueue(next); setError(null)
        setOpen(o => o != null && next.items.some(item => item.id === o) ? o : null)
      } catch (e) {
        if (alive.current && seq === loadSeq.current) setError(e instanceof ApiError ? e.detail : appConfig.copy.admin.alignment.loadFailed)
      }
    })()
    inFlight.current = request
    void request.finally(() => { if (inFlight.current === request) inFlight.current = null })
    return request
  }, [reload])

  useEffect(() => {
    alive.current = true
    // The refresh changes React state only after its network request settles. A wall reading
    // someone else's queue never polls – its owner does.
    if (owns) void refresh()
    const timer = owns ? window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 15000) : 0
    // This is a request generation counter, deliberately invalidated at teardown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { alive.current = false; ++loadSeq.current; inFlight.current = null; window.clearInterval(timer) }
  }, [refresh, owns])

  const queue = source ? source.queue : ownQueue
  const write = source?.update
  const update = (next: AlignmentListItem) => {
    ++loadSeq.current // a list request from before the decision must not overwrite its response
    if (write) write(next)
    else setOwnQueue(q => q ? { ...q, items: q.items.map(item => item.id === next.id ? next : item) } : q)
  }
  // A stable order: by object, then module. The worker updating rows – or a poll landing
  // mid-review – must not shuffle the wall under the reviewer's eyes.
  const items = useMemo(() => [...(queue?.items ?? [])].sort((a, b) =>
    priority(a) - priority(b) || a.object_name.localeCompare(b.object_name) || (a.module ?? '').localeCompare(b.module ?? '')), [queue])
  const isOpen = (item: AlignmentListItem) => item.is_current && !terminal.has(item.status) && (!compact || item.status !== 'unsupported')
  const visible = items.filter(item => (effectiveFilter === 'all' || (effectiveFilter === 'approved' ? terminal.has(item.status) : isOpen(item)))
    && `${item.object_name} ${item.module} ${item.title ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  // A filtered wall must never open or decide a hidden card.
  const current = open != null ? visible.find(item => item.id === open) ?? null : null
  const count = items.filter(isOpen).length
  const sections = SECTIONS.map(section => ({ section, items: visible.filter(item => sectionOf(item) === section) })).filter(s => s.items.length)

  const mark = (id: number, on: boolean) => setBusy(prev => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next })
  const markOf = (item: AlignmentListItem): CardMark | null => {
    if (item.status !== 'ready' && item.status !== 'needs_review') return null
    const override = overrides.get(item.id)
    return override === 'none' ? null : override ?? (item.status === 'ready' ? 'yes' : null)
  }
  const setMark = (item: AlignmentListItem, next: CardMark | null) => setOverrides(prev => { const m = new Map(prev); m.set(item.id, next ?? 'none'); return m })
  /** One sheet's decision. Approval re-reads the exact revision first: the summary row can never
   *  approve by itself (its page count is unknown), and the server gets the freshest token. */
  const decide = async (item: AlignmentListItem, decision: CardDecision | 'approve' | 'reject', quiet = false): Promise<boolean> => {
    mark(item.id, true); setError(null)
    try {
      let next: AlignmentItem
      if (decision === 'approve') {
        const detail = await loadAlignmentDetail(item.id)
        if (!detail.can_approve || !reviewableAlignment(detail.pairs, detail.aspect)) throw new ApiError(422, C.saveFailed)
        next = await approveAlignment(detail, detail.pairs)
      } else next = decision === 'reject' ? await rejectAlignment(item) : await undoAlignmentApproval(item)
      if (!alive.current) return false
      update(next)
      if (!quiet) setNotice(null)
      return true
    } catch (e) {
      if (!alive.current) return false
      setError(e instanceof ApiError && e.status === 409 ? C.conflict : e instanceof ApiError ? e.detail : C.saveFailed)
      if (e instanceof ApiError && e.status === 409) await refresh()
      return false
    } finally { if (alive.current) mark(item.id, false) }
  }
  /** «Übernehmen»: every marked card of the visible wall, one after the other, stopping at the
   *  first refusal so nothing is skipped silently; the line by the filters says how far it got.
   *  Single decisions need no such line – the card itself moves and carries «Rückgängig». */
  const staged = visible.filter(item => markOf(item) != null)
  const yesCount = staged.filter(item => markOf(item) === 'yes').length
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const apply = async () => {
    const list = staged.map(item => ({ item, mark: markOf(item) }))
    setBatch({ done: 0, total: list.length }); setNotice(null)
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

  // The three pieces both layouts are built from. As a TAB they stand in one row — search left,
  // what is staged and «Übernehmen» right; the standalone wall keeps its two lines, the heading
  // with the actions and the Offen/Entschieden/Alle filter with the search.
  const actions = <div className="adm-align-actions">
    {staged.length > 0 && <span className="adm-hint adm-apply-summary">{batch ? fillTemplate(C.grid.applying, batch) : fillTemplate(C.grid.applySummary, { yes: yesCount, no: staged.length - yesCount })}</span>}
    {overrides.size > 0 && <button type="button" className="btn" disabled={!!batch} onClick={() => setOverrides(new Map())}>{C.grid.resetMarks}</button>}
    {!embedded && <button type="button" className="btn" disabled={refreshing || !!batch} onClick={async () => { setRefreshing(true); await refresh(); if (alive.current) setRefreshing(false) }}>{refreshing ? C.loading : C.refresh}</button>}
    {staged.length > 0 && <button type="button" className="btn primary" disabled={!!batch || busy.size > 0} onClick={() => void apply()}>{fillTemplate(C.grid.apply, { n: staged.length })}</button>}
  </div>
  const searchField = <input className="adm-input adm-align-search" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={C.search} aria-label={C.search} />
  const applied = notice ? <span className="adm-hint adm-align-applied" role="status">{notice}</span> : null

  return <section className={`adm-align${embedded ? ' embedded' : ''}`} aria-label={C.title}>
    {!embedded && <div className="adm-align-heading">
      <div><h2>{C.title}</h2>{!compact && <p className="adm-hint">{C.intro}</p>}</div>
      {actions}
    </div>}
    {error && <p className="adm-state adm-state-err" role="alert">{error}</p>}
    {queue && !queue.capability.available && <p className="adm-align-notice" role="status">{C.unavailableHint}</p>}
    {embedded
      ? <div className="adm-align-toolbar">{searchField}{applied}{(staged.length > 0 || overrides.size > 0) && actions}</div>
      : <div className="adm-align-filters"><Segmented<Filter> value={filter} onChange={setFilter} ariaLabel={C.filterLabel} options={[
        { value: 'open', label: fillTemplate(C.openCount, { n: count }) }, { value: 'approved', label: C.grid.decided }, { value: 'all', label: C.all },
      ]} />{applied}{searchField}</div>}
    {!queue && !error && <p className="adm-state" role="status">{C.loading}</p>}
    {queue && visible.length === 0 && <p className="adm-hint adm-align-empty">{items.length === 0 ? C.empty : C.noResults}</p>}
    {sections.map(({ section, items: list }) => <div key={section} className="adm-grid-section">
      <div className="adm-grid-head"><h3>{C.grid.sections[section]}</h3><span className="adm-hint">{fillTemplate(C.queueCount, { n: list.length })}</span></div>
      <AlignmentGrid items={list} busy={busy} markOf={markOf} onMark={setMark} onDecide={(item, decision) => void decide(item, decision)} onOpen={item => setOpen(item.id)} />
    </div>)}
    {current && <PlanAlignmentEditor item={current} onClose={() => setOpen(null)} onChange={update} onConflict={refresh} />}
  </section>
}

/** Reusable full-screen editor for an object's plan row or the preparation queue. It is SEEDED
 *  with a queue row – the sheet's reference geometry and its exact page count come from the
 *  detail it resolves itself (`ResolvedAlignmentDetail`), never from the list. */
export function PlanAlignmentEditor({ item, onClose, onChange, onConflict }: SeededDetailProps & { onClose: () => void }) {
  const C = appConfig.copy.admin.alignment
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState<'close' | 'reload' | null>(null)
  const [reloadAvailable, setReloadAvailable] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  // The detail's own save, so leaving with unsaved work has a THIRD answer beside verwerfen and
  // abbrechen: the two-button version made «Ungespeichert» a trap you had to back out of, walk
  // to the header for, and re-enter. Only a detail whose save would go through right now hands
  // one up (see `saveRef` on DetailProps), so the button is never offered where it cannot work.
  const saveRef = useRef<(() => Promise<boolean>) | null>(null)
  const [canSave, setCanSave] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const saving = useRef(false)
  const finish = (action: 'close' | 'reload') => {
    if (action === 'close') onClose()
    else { setReloadKey((n) => n + 1); setReloadAvailable(false); setDirty(false) }
  }
  const close = () => { setPending(null); setSaveError(null) }
  const request = (action: 'close' | 'reload') => { if (dirty) setPending(action); else finish(action) }
  const saveThen = async (action: 'close' | 'reload') => {
    if (saving.current) return
    saving.current = true; setSaveError(null)
    const ok = await saveRef.current?.().finally(() => { saving.current = false })
    if (ok) { close(); finish(action) } else setSaveError(C.saveFailed)
  }
  return <>
    <AlignmentModal item={item} onClose={() => request('close')}>
      <ResolvedAlignmentDetail key={`${item.id}:${reloadKey}`} item={item} onChange={onChange} onConflict={async () => { setReloadAvailable(true); await onConflict() }} onDirty={setDirty}
        saveRef={saveRef} onSaveState={setCanSave} />
      {reloadAvailable && <div className="adm-editor-reload"><span>{C.conflict}</span><button type="button" className="btn" onClick={() => request('reload')}>{C.refresh}</button></div>}
    </AlignmentModal>
    {/* «Speichern» (primär) · «Verwerfen» · «Abbrechen» – and where nothing can be saved, the old
        two buttons, with «Verwerfen» as the one that goes through. */}
    <ConfirmCard open={pending != null} title={C.editor.unsaved} message={C.editor.unsavedAsk} note={saveError ?? undefined}
      confirmLabel={canSave ? C.floors.saveAll : C.editor.discard} altLabel={canSave ? C.editor.discard : undefined}
      cancelLabel={appConfig.copy.cancel}
      onResolve={(confirmed) => {
        const action = pending
        if (confirmed === false) { close(); return }
        if (!action) return
        if (confirmed === 'alt' || !canSave) { close(); finish(action); return }
        void saveThen(action)
      }} />
  </>
}

/** The way out of the full-screen editor, handed to whichever detail draws the header row: the
 *  back action belongs IN that row (mock A, 15.09.2026) rather than floating over it. It is also
 *  the header's first focusable, which is where the overlay puts focus on open – no `initialFocus`
 *  needed, and the frame carries it from the first frame, including while the detail is loading. */
const EditorBack = createContext<(() => void) | null>(null)

/** Full-screen preparation uses the shared overlay for focus containment and restore. */
function AlignmentModal({ item, onClose, children }: { item: AlignmentListItem; onClose: () => void; children: ReactNode }) {
  return <Overlay open onClose={onClose} className="adm-plan-editor" backdropClassName="adm-editor-backdrop"
    ariaLabel={`${item.object_name} · ${item.title || item.module}`}>
    <EditorBack.Provider value={onClose}>{children}</EditorBack.Provider>
  </Overlay>
}

/** The wall's colour vocabulary in the badge's four tones: a decided fit reads green, anything
 *  waiting for a person amber, a failure red, and everything still moving grey. */
const STATUS_TONE: Record<AlignmentStatus, 'on' | 'off' | 'warn' | 'err'> = {
  approved: 'on', ready: 'on', needs_review: 'warn', no_match: 'warn', unavailable: 'warn',
  failed: 'err', pending: 'off', processing: 'off', unsupported: 'off', rejected: 'off',
}

/**
 * The ONE header row of the full-screen editor, worn by both details (mock A, 15.09.2026):
 * «Zum Objekt» · object and module · the fit's status as the admin badge · the actions of this
 * particular editor («Speichern» for a floor pack, «Ausrichtung freigeben» for a single sheet).
 * Nothing is positioned absolutely, so the title starts where the eye already is.
 *
 * ⚠️ It is also where the editor's PROSE went (15.09.2026, second pass). The meta line is the
 * module and nothing else – «Stand N» only from the second revision on, and never a page number,
 * which is the Geschosse tab's business. The fit's provenance is ONE word beside the badge
 * («Automatisch» / «Von Hand» / «Nicht ausgerichtet»); the plan revision, the reference and what
 * a Freigabe is worth sit in that badge's ⓘ. Neither detail has a footer any more, so
 * «Freigabe zurücknehmen» is a quiet button beside the badge – the status, and what may be
 * undone about it, in one place.
 */
function EditorHeader({ item, unsaved, origin, tip, aside, actions }: {
  item: AlignmentListItem
  unsaved?: boolean
  /** the fit's provenance in one word, beside the badge */
  origin?: string
  /** the facts and the scope sentence, behind the badge's ⓘ – nowhere visible by default */
  tip?: string
  /** what may be UNDONE about this status, quiet, beside the badge */
  aside?: ReactNode
  actions?: ReactNode
}) {
  const C = appConfig.copy.admin.alignment
  const back = useContext(EditorBack)
  // «Stand 1» is the normal sheet saying nothing – it appears once there is a second revision.
  const revision = item.plan_version > 1 ? fillTemplate(C.revision, { version: item.plan_version }) : null
  return <header className="adm-editor-head">
    {back && <button type="button" className="btn adm-editor-back" onClick={back}><Icon id="chevron-left" />{C.editor.back}</button>}
    <div className="adm-editor-titles">
      <h3>{item.object_name}</h3>
      <p className="adm-editor-meta"><span>{item.title || item.module}</span>{revision && <span>{revision}</span>}</p>
    </div>
    <div className="adm-editor-header-actions">
      {unsaved && <span className="adm-hint">{C.editor.unsaved}</span>}
      <span className="adm-editor-state">
        <StatusBadge tone={STATUS_TONE[item.status]} label={C.editor.status} state={C.status[item.status]} />
        {origin && <b className="adm-editor-origin">{origin}</b>}
        {tip && <InfoTip label={C.editor.status} text={tip} />}
      </span>
      {aside}
      {actions}
    </div>
  </header>
}

/** The fit's provenance in ONE word – what a whole sentence under the map used to say. */
const originWord = (pairs: GeorefPair[], C: typeof appConfig.copy.admin.alignment) =>
  !pairs.length ? C.unaligned : hasAutoPairs(pairs) ? C.automatic : C.manual

/** Everything the editor no longer says out loud, for the status badge's ⓘ: which revision,
 *  which reference, when it was approved – and what that approval is worth. The two are joined
 *  with a full stop because the tip is one running paragraph, not a list. */
const statusTip = (item: AlignmentListItem, C: typeof appConfig.copy.admin.alignment) =>
  `${fillTemplate(C.factsLine, { plan: fmtDate(item.created_at), reference: referenceLabel(item, C), approval: item.approved_at ? fmtDate(item.approved_at) : C.notApproved })}. ${C.scope}`

/** The worker's provenance string, as a sentence: which reference, and when it was observed. */
function referenceLabel(item: AlignmentListItem, C: typeof appConfig.copy.admin.alignment): string {
  const src = item.reference_source ?? ''
  const what = src.includes('station snapshot') ? C.refSnapshot : src.startsWith('OSM') ? C.refPerObject : src || C.referenceUnknown
  return item.reference_at ? `${what} · ${fmtDate(item.reference_at)}` : what
}

interface DetailProps {
  item: AlignmentItem
  onChange: (next: AlignmentItem) => void
  onConflict: () => Promise<void>
  onDirty?: (dirty: boolean) => void
  /** the detail's own save, so the leaving-dirty question can offer it (shape borrowed from the
   *  floor editor's `historyRef`: the ref carries the current closure, the callback the state) */
  saveRef?: React.RefObject<(() => Promise<boolean>) | null>
  onSaveState?: (canSave: boolean) => void
}

/** Everything a detail needs, but opened FROM a queue row: no rings, no page count yet. */
interface SeededDetailProps extends Omit<DetailProps, 'item'> {
  item: AlignmentListItem
}

// Only the selected PDF needs its exact page count and its reference geometry; a queue row has
// neither, and can never enable approval on its own.
function ResolvedAlignmentDetail(props: SeededDetailProps) {
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
  // A decision bumps the queue row before the re-read lands: the newer row's fields go over the
  // rings the last detail brought, rather than dropping the editor back to its loading frame.
  const resolved: AlignmentItem | null = !detail ? null
    : detail.edit_version >= edit_version ? detail : { ...detail, ...props.item }
  const retry = <p className="am-error" role="alert">{C.loadFailed} <button className="btn" type="button" onClick={() => setAttempt(n => n + 1)}>{C.refresh}</button></p>
  // The frame – header, back action and all – stands from the first frame: a slow or failed read
  // must not leave the full-screen editor without a way out.
  if (!resolved) return <section className="adm-align-review adm-editor-detail" aria-label={props.item.object_name}>
    <EditorHeader item={props.item} />
    <div className="adm-editor-pane">{error ? retry : <p className="adm-align-empty" role="status">{C.loading}</p>}</div>
  </section>
  return <>
    {error && retry}
    <AlignmentDetail {...props} item={resolved} onChange={next => { setDetail(next); props.onChange(next) }} />
  </>
}

/** A Modul-6 sheet (or anything already carrying floors) is a floor pack: floors first, map second, one save. */
const isFloorPack = (item: AlignmentItem) => item.floors.length > 0 || item.module === 'modul6' || moduleHiddenWithGebaeude(item.module ?? '')

function AlignmentDetail(props: DetailProps) {
  return isFloorPack(props.item) ? <FloorPackDetail {...props} /> : <SheetDetail {...props} />
}

/**
 * The floors-first modal (decided 15.09.2026): the sheet with its storeys on top, then «Karte
 * verknüpfen» on the fit page, then ONE «Speichern» that writes the floors and – when two real
 * points stand – approves the fit. Moving the fit page re-queues the worker, so the approval may
 * have to wait one round trip; the notice says so instead of failing.
 */
function FloorPackDetail({ item, onChange, onConflict, onDirty, saveRef, onSaveState }: DetailProps) {
  const C = appConfig.copy.admin.alignment
  const F = C.floors
  const [tab, setTab] = useState<'floors' | 'map' | 'preview'>('floors')
  const historyRef = useRef<{ undo: () => void } | null>(null)
  const [canUndo, setCanUndo] = useState(false)
  const [draft, setDraft] = useState<FloorDraft | null>(null)
  const [pairsDraft, setPairsDraft] = useState<{ pairs: GeorefPair[]; editVersion: number } | null>(null)
  const imageKey = `${item.id}:${item.page}`
  const [imageResult, setImageResult] = useState<{ key: string; url: string | null; failed: boolean } | null>(null)
  const image = imageResult?.key === imageKey ? imageResult.url : null
  const imageFailed = imageResult?.key === imageKey && imageResult.failed
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const mounted = useRef(true)
  const pairs = pairsDraft?.pairs ?? item.pairs
  const pairsDirty = pairsDraft != null && JSON.stringify(pairsDraft.pairs) !== JSON.stringify(item.pairs)
  const stale = pairsDraft != null && pairsDraft.editVersion !== item.edit_version
  const editable = item.is_current && !waiting.has(item.status)
  useEffect(() => {
    mounted.current = true
    const abort = new AbortController()
    let url: string | undefined
    void alignmentPreview(item.id, abort.signal).then(blob => {
      if (abort.signal.aborted) return
      url = URL.createObjectURL(blob); setImageResult({ key: imageKey, url, failed: false })
    }).catch(() => { if (!abort.signal.aborted) setImageResult({ key: imageKey, url: null, failed: true }) })
    return () => { mounted.current = false; abort.abort(); if (url) URL.revokeObjectURL(url) }
  }, [item.id, item.page, imageKey])
  const canApprove = pairs.length >= 2 && reviewableAlignment(pairs, item.aspect)
  const dirty = (draft?.dirty ?? false) || pairsDirty
  useEffect(() => { onDirty?.(dirty) }, [dirty, onDirty])
  /** true when everything that had to be written was written – the leaving-dirty question reads
   *  it to know whether it may close behind the save */
  const save = async (): Promise<boolean> => {
    setBusy(true); setError(null); setNotice(null)
    try {
      let next = item
      if (draft?.dirty) next = await savePlanFloors(item, draft.floors, draft.fitPage)
      if (!mounted.current) return false
      const fitMoved = next.page !== item.page
      if (canApprove && (pairsDirty || next.status !== 'approved') && !fitMoved) {
        next = await approveAlignment(next, pairs)
        if (!mounted.current) return false
        setNotice(F.savedAll)
      } else setNotice(fitMoved ? F.savedFloorsOnly : canApprove ? F.savedAll : F.noPairsYet)
      onChange(next); setPairsDraft(null)
      return true
    } catch (e) {
      if (!mounted.current) return false
      setError(e instanceof ApiError && e.status === 409 ? C.conflict : e instanceof ApiError ? e.detail : C.saveFailed)
      if (e instanceof ApiError && e.status === 409) await onConflict()
      return false
    } finally { if (mounted.current) setBusy(false) }
  }
  const saveable = !busy && !stale && dirty && item.is_current && (draft?.complete ?? true)
  // no dep array on purpose: the ref must hold THIS render's closure, over this render's draft
  useEffect(() => {
    if (saveRef) saveRef.current = saveable ? save : null
    onSaveState?.(saveable)
    return () => { if (saveRef) saveRef.current = null }
  })
  const withdraw = async () => {
    setBusy(true)
    try { onChange(await undoAlignmentApproval(item)) } catch (e) { setError(e instanceof ApiError ? e.detail : C.saveFailed) } finally { if (mounted.current) setBusy(false) }
  }
  return <section className="adm-align-review adm-editor-detail" aria-label={item.object_name}>
    <EditorHeader item={item} unsaved={dirty} origin={originWord(pairs, C)} tip={statusTip(item, C)}
      aside={item.status === 'approved'
        ? <button type="button" className="btn adm-editor-quiet" disabled={busy} onClick={() => void withdraw()}>{C.withdrawApproval}</button>
        : undefined}
      actions={<>
      <span className="adm-editor-rule" aria-hidden />
      <button type="button" className="btn" disabled={busy || !canUndo} onClick={() => historyRef.current?.undo()}><Icon id="undo" />{appConfig.copy.undo}</button>
      <button type="button" className="btn primary" disabled={!saveable} onClick={() => void save()}>{busy ? C.saving : F.saveAll}</button>
    </>} />
    {!item.is_current && <p className="adm-align-notice">{C.superseded}</p>}
    {/* ONE row, not two: the tabs go INTO the editor's bar, beside the sheet's zoom and over the
        floors column's head (FloorPackEditor · .adm-floors-bar). That is why the editor is mounted
        on the Karte tab too – there it is the bar alone, and the map pane below is this one.
        The Vorschau's map tile is built HERE as well: this is where the fit page's image and the
        pairs live. No fit yet ⇒ no tile and no sentence about it, because the Karte tab's own
        badge already reads «Nicht ausgerichtet». */}
    <FloorPackEditor key={item.edit_version} item={item} onDraft={setDraft} view={tab === 'floors' ? 'edit' : tab} historyRef={historyRef} onUndoState={setCanUndo}
      tabs={<Segmented<'floors' | 'map' | 'preview'> value={tab} onChange={setTab} ariaLabel={C.title} options={[
        { value: 'floors', label: F.title }, { value: 'map', label: C.editor.map }, { value: 'preview', label: C.editor.preview },
      ]} />}
      mapPreview={image && pairs.length >= 2
        ? <Suspense fallback={<p className="adm-state">{C.loading}</p>}><Preview item={item} pairs={pairs} imageUrl={image} opacity={60} /></Suspense>
        : undefined} />
    <div className="adm-pack-map adm-editor-pane" hidden={tab !== 'map'}>
      {tab === 'map' && (imageFailed ? <p className="adm-state adm-state-err" role="alert">{C.previewFailed}</p> : !image ? <p className="adm-state" role="status">{C.previewLoading}</p>
        : editable && tab === 'map' ? <Suspense fallback={<p className="adm-state">{C.loading}</p>}><Pairing item={item} pairs={pairs} onPairs={(p) => setPairsDraft({ pairs: p, editVersion: item.edit_version })} onDone={() => {}} onReset={() => setPairsDraft(null)} previewUrl={image} /></Suspense>
        : <Suspense fallback={<p className="adm-state">{C.loading}</p>}><Preview item={item} pairs={pairs} imageUrl={image} opacity={60} /></Suspense>)}
    </div>
    {/* a draft measured against a revision that has since moved cannot be saved – the way out of
        that one stays inline, where the notice is */}
    {stale && <p className="adm-align-notice" role="alert">{C.conflict} <button type="button" className="btn" onClick={() => setPairsDraft(null)}>{C.editor.discard}</button></p>}
    {error && <p className="adm-state adm-state-err" role="alert">{error}</p>}
    {notice && !dirty && <p className="adm-hint adm-align-reason" role="status">{notice}</p>}
  </section>
}

function SheetDetail({ item, onChange, onConflict, onDirty }: DetailProps) {
  const C = appConfig.copy.admin.alignment
  const [draft, setDraft] = useState<{ pairs: GeorefPair[]; editVersion: number } | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [imageFailed, setImageFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // By hand = the FIELD's «Karte verknüpfen» (AlignmentPairing mounts its layers and store);
  // two real pairs replace whatever the worker proposed. A proposal is approved as it is, or
  // aligned by hand – there is no third way to change a fit here. Zooming in on a sheet means
  // checking or correcting its points, so the modal always opens in the pairing; «Fertig» hands
  // over to the overlay view, «Punkte bearbeiten» comes back.
  const [manual, setManual] = useState(true)
  const [opacity, setOpacity] = useState(60)
  const mounted = useRef(true)
  const pairs = draft?.pairs ?? item.pairs
  const dirty = draft != null && JSON.stringify(draft.pairs) !== JSON.stringify(item.pairs)
  useEffect(() => { onDirty?.(dirty) }, [dirty, onDirty])
  const stale = draft != null && draft.editVersion !== item.edit_version
  const editable = (item.can_approve || item.status === 'approved') && !waiting.has(item.status)
  // A sheet nobody may touch (still computing, or not this station's to approve) can only be
  // looked at, so it lands in the overlay view however the modal was opened.
  const pairing = manual && editable
  const reason = BEYOND_PAIRING.has(item.reason ?? '') ? reasonText(item.reason) : null

  useEffect(() => {
    mounted.current = true
    const abort = new AbortController()
    let url: string | undefined
    void alignmentPreview(item.id, abort.signal).then(blob => {
      if (abort.signal.aborted) return
      url = URL.createObjectURL(blob); setImage(url)
    }).catch(() => { if (!abort.signal.aborted) setImageFailed(true) })
    return () => { mounted.current = false; abort.abort(); if (url) URL.revokeObjectURL(url) }
  }, [item.id, item.page]) // the fit page moves when floors are saved – show the page the fit is measured on

  const setPairs = (next: GeorefPair[]) => setDraft(previous => ({ pairs: next, editVersion: previous?.editVersion ?? item.edit_version }))
  const reset = () => { setDraft(null); setError(null) }
  const save = async (operation: 'approve' | 'retry' | 'undo') => {
    setBusy(true); setError(null)
    try {
      const next = operation === 'approve' ? await approveAlignment(item, pairs) : operation === 'undo' ? await undoAlignmentApproval(item) : await retryAlignment(item)
      if (!mounted.current) return
      onChange(next); reset()
    } catch (e) {
      if (!mounted.current) return
      setError(e instanceof ApiError && e.status === 409 ? C.conflict : e instanceof ApiError ? e.detail : C.saveFailed)
      if (e instanceof ApiError && e.status === 409) await onConflict()
    } finally { if (mounted.current) setBusy(false) }
  }

  return <section className="adm-align-review adm-editor-detail" aria-label={item.object_name}>
    <EditorHeader item={item} unsaved={dirty} origin={originWord(pairs, C)} tip={statusTip(item, C)}
      aside={item.status === 'approved'
        ? <button type="button" className="btn adm-editor-quiet" disabled={busy} onClick={() => void save('undo')}>{C.withdrawApproval}</button>
        : undefined}
      actions={editable ? <>
      <span className="adm-editor-rule" aria-hidden />
      {/* a fresh worker run is the only thing this editor can do that aligning by hand cannot,
          so it stands with the actions – the footer that used to hold it is gone */}
      {['no_match', 'failed', 'unavailable'].includes(item.status) && RETRYABLE.has(item.reason ?? '')
        && <button type="button" className="btn" disabled={busy || !!draft} onClick={() => void save('retry')}>{C.retry}</button>}
      <button type="button" className="btn primary" disabled={busy || stale || !image || imageFailed || !reviewableAlignment(pairs, item.aspect)} onClick={() => void save('approve')}>{busy ? C.saving : C.approve}</button>
    </> : undefined} />
    <nav className="adm-editor-tabs">
      <Segmented<boolean> value={manual} onChange={setManual} ariaLabel={C.title} options={[
        { value: true, label: C.editor.map }, { value: false, label: C.editor.preview },
      ]} />
    </nav>
    {!item.is_current && <p className="adm-align-notice">{C.superseded}</p>}
    {reason && <p className="adm-hint adm-align-reason">{reason}</p>}
    <div className="adm-editor-pane adm-editor-map-pane">
    {imageFailed ? <p className="adm-state adm-state-err" role="alert">{C.previewFailed}</p> : !image ? <p className="adm-state" role="status">{C.previewLoading}</p>
      : pairing ? <Suspense fallback={<p className="adm-state">{C.loading}</p>}><Pairing item={item} pairs={pairs} onPairs={setPairs} onDone={() => setManual(false)} onReset={reset} previewUrl={image} /></Suspense>
      : <Suspense fallback={<p className="adm-state">{C.loading}</p>}><Preview item={item} pairs={pairs} imageUrl={image} opacity={opacity} /></Suspense>}
    </div>
    {/* the slider moves the overlay, so it only exists while there IS one */}
    {image && !imageFailed && !pairing && <div className="adm-align-settings"><span>{C.opacity}</span><Slider value={opacity} onChange={setOpacity} ariaLabel={C.opacity} valueText={`${opacity} %`} /><span className="adm-align-number">{opacity} %</span></div>}
    {/* a draft measured against a revision that has since moved cannot be approved – the way out
        of that one stays inline, where the notice is; every other discard is the pairing bar's
        «Zurücksetzen», and the way back INTO the points is the «Karte ausrichten» tab */}
    {stale && <p className="adm-align-notice" role="alert">{C.conflict} <button type="button" className="btn" onClick={reset}>{C.editor.discard}</button></p>}
    {error && <p className="adm-state adm-state-err" role="alert">{error}</p>}
  </section>
}
