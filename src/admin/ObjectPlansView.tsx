import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { listObjects, type ObjectWithPlans } from '../lib/incidents'
import { referenceUrl, type ReferenceDataset } from '../lib/api/reference'
import { moduleAlignment, type DeploymentModule } from '../lib/deploymentConfig'
import { Icon } from '../lib/icons'
import { Segmented } from '../components/Segmented'
import { sortPlanModules, sortPlansByModule } from '../lib/planOrder'
import { ObjectEditor, PlanSourceBadge, fmtBytes, moduleShortForm, planSlots, usePlanUpload, type Slot } from './ObjectEditor'
import { PlanAlignmentEditor, PlanAlignmentReview } from './PlanAlignmentReview'
import { loadAlignmentQueue, type AlignmentListItem, type AlignmentQueue } from './planAlignmentApi'
import { ActionMenu, Card, EmptyState, StatusBadge, Table, fmtDate, type MenuAction } from './ui'
import { stackComplete, stackFromFloors } from './floorPack'
import { hasMarkerWarnings } from './markerNotes'
import './objectPlans.css'

const ObjectsMap = lazy(() => import('./ObjectsMap'))
type Filter = 'all' | 'attention' | 'approved'
type Tone = 'on' | 'off' | 'warn' | 'err'
/** Objekte · Vorschläge · Übersicht — the three ways to look at the same stock. */
type Tab = 'objects' | 'proposals' | 'overview'

/** A sheet the review wall can still decide: the worker proposed something for the CURRENT
 *  revision and nobody has approved or rejected it yet. The same test the wall's own «Offen»
 *  filter applies, so the tab's badge and the list behind it can never disagree. */
const isProposal = (item: AlignmentListItem) =>
  item.is_current && (item.status === 'ready' || item.status === 'needs_review')

/** Only the current byte revision can describe a plan's preparation. */
export function alignmentForPlan(plan: ReferenceDataset, items: AlignmentListItem[]) {
  return items.find(item => item.dataset_id === plan.id && item.plan_version === plan.current_version && item.is_current)
}

/**
 * What the page knows about preparation, derived once and read by both surfaces: the object
 * TABLE (one status per object) and the detail page's plan rows (one status per module).
 *
 * ⚠️ `alignmentError` is not «nothing to prepare». A queue that failed to load cannot say a fit
 * is approved, so every eligible plan falls back to Handlungsbedarf rather than quietly going
 * green — the page stays usable, it just stops claiming.
 */
function planFacts(modules: DeploymentModule[], items: AlignmentListItem[], alignmentError: boolean) {
  const C = appConfig.copy.admin.objectPlans
  const A = appConfig.copy.admin.alignment
  const itemFor = (plan: ReferenceDataset) => alignmentForPlan(plan, items)
  // Preparing a building's floors is independent of its module's map-alignment setting.
  const floorPlan = (plan: ReferenceDataset) => plan.module === 'modul6'
    || !!modules.find(module => module.id === plan.module)?.hideWhenGebaeude
    || !!itemFor(plan)?.floors.length
  const eligible = (plan: ReferenceDataset) => plan.kind === 'pdf'
    && (floorPlan(plan) || moduleAlignment(modules, plan.module ?? '') !== 'none')
  const floorsMissing = (plan: ReferenceDataset) => {
    const item = itemFor(plan)
    if (!floorPlan(plan)) return false
    const stack = item && stackFromFloors(item.floors, item.page)
    return !stack || !stackComplete(stack)
  }
  /** The plan's own `§` markers are broken – which is WHY it prepared nothing, and the one
   *  thing no amount of clicking in here can fix. It outranks every other amber state. */
  const markersBroken = (plan: ReferenceDataset) => eligible(plan) && hasMarkerWarnings(itemFor(plan))
  /** A plan's preparation, as the badge says it: only a fit that is actually approved is green. */
  const planStatus = (plan: ReferenceDataset): { tone: Tone; label: string } => {
    if (!eligible(plan)) return { tone: 'off', label: C.document }
    const item = itemFor(plan)
    if (alignmentError || !item) return { tone: 'warn', label: C.unknown }
    if (hasMarkerWarnings(item)) return { tone: 'warn', label: A.markerWarnings.incomplete }
    if (floorsMissing(plan)) return { tone: 'warn', label: C.floorsMissing }
    return { tone: item.status === 'approved' ? 'on' : item.status === 'failed' ? 'err' : 'warn', label: A.status[item.status] }
  }
  const pending = (obj: ObjectWithPlans) => obj.plans.some(plan =>
    eligible(plan) && (alignmentError || itemFor(plan)?.status !== 'approved' || floorsMissing(plan) || markersBroken(plan)))
  const approved = (obj: ObjectWithPlans) => !alignmentError && obj.plans.some(eligible) && !pending(obj)
  // «Handlungsbedarf» says there is something to do here; when the something is a broken export,
  // the badge says THAT instead – the work is in the PDF, not on this page.
  const objectStatus = (obj: ObjectWithPlans): { tone: Tone; label: string } =>
    obj.plans.some(markersBroken) ? { tone: 'warn', label: A.markerWarnings.incomplete }
      : pending(obj) ? { tone: 'warn', label: C.attention }
        : approved(obj) ? { tone: 'on', label: C.approved } : { tone: 'off', label: C.document }
  return { alignmentError, itemFor, eligible, planStatus, pending, approved, objectStatus }
}

type PlanFacts = ReturnType<typeof planFacts>

/**
 * Verwaltung › Objektpläne – the object-first entry into the plan stock.
 *
 * Three surfaces under one tab switch: the object TABLE (search, Statusfilter, one row per
 * Einsatzobjekt), the VORSCHLÄGE wall (the staged ✓/✕ review of what the alignment worker
 * proposed, counted in the tab itself and off when there is nothing to decide), and the module
 * ÜBERSICHT its caller passes in. Picking an object — or adding one — replaces the list with
 * that object's own page, and THAT page is the editor: the object's name and address as its
 * head, its fields as settings rows (which write themselves — there is no «Speichern»), its
 * Modul-PDFs as one TABLE row per module carrying the plan, its preparation status and ONE
 * primary action with the rest in a kebab. There is no «bearbeiten» modal over a list any more.
 *
 * ⚠️ The object row IS the control — no «Öffnen» button beside it. The `<tr>` takes the finger,
 * the one button spanning the name cell takes a keyboard and a screen reader, and the chevron at
 * the right edge is the affordance. Two controls for one act is what this replaced.
 *
 * ⚠️ It reads the admin's shared grammar and adds none of its own: `.adm-table` for BOTH tables
 * — the object list (name, plans, status, one action) and one object's Modulpläne —
 * `SettingsSheet`/`SettingRow` for the object's fields, StatusBadge for every status,
 * EmptyState for empty/loading/failed, the dashed `.adm-formlink-add` row for «Objekt
 * hinzufügen» (ui.tsx). Nothing nests. A sub-slot itself (`modul5-pv`) is never created here —
 * it arrives from a pull (Planspeicher/SharePoint) or the `admin_objects` CLI; this page only
 * uploads or replaces the PDF sitting in a slot that already exists.
 * objectPlans.css only holds what no primitive owns — the tools line, the two tables' own
 * cells, the map's height, the section's rhythm.
 *
 * ⚠️ No standing «Aktualisieren»: the list re-reads itself every 15 s while no alignment editor
 * is open, so the only refresh left is the retry inside a failed load – where it is the one
 * thing to do. The detail page keeps its OWN copy of the object (ObjectEditor · `saved`), so a
 * poll can never overwrite what is being typed or a plan that was just uploaded.
 */
export function ObjectPlansView({ modules, overview }: {
  modules: DeploymentModule[]
  overview: (objects: ObjectWithPlans[]) => ReactNode
}) {
  const C = appConfig.copy.admin.objectPlans
  const A = appConfig.copy.admin.alignment
  const O = appConfig.copy.admin.objects
  const D = appConfig.copy.admin.data
  const [objects, setObjects] = useState<ObjectWithPlans[] | null>(null)
  // ⚠️ ONE copy of the preparation queue for the whole page: the object table reads it, the tab
  // badge counts it, and the Vorschläge wall is handed it (`source`) instead of fetching its own.
  const [queue, setQueue] = useState<AlignmentQueue | null>(null)
  const [objectsError, setObjectsError] = useState(false)
  const [alignmentError, setAlignmentError] = useState(false)
  const [tab, setTab] = useState<Tab>('objects')
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  // null = the list. 'new' = the detail page in create mode; anything else = that object's page.
  const [selected, setSelected] = useState<string | null>(null)
  const [opened, setOpened] = useState<AlignmentListItem | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const request = useRef(0)
  const refresh = useCallback(async () => {
    const seq = ++request.current
    setBusy(true)
    const current = () => alive.current && request.current === seq
    // The object list is useful before the separate preparation queue finishes.
    await Promise.all([
      listObjects().then(next => {
        if (current()) { setObjects(next); setObjectsError(false) }
      }).catch(() => { if (current()) setObjectsError(true) }),
      loadAlignmentQueue().then(next => {
        if (current()) { setQueue(next); setAlignmentError(false) }
      }).catch(() => { if (current()) setAlignmentError(true) }),
    ])
    if (current()) setBusy(false)
  }, [])
  useEffect(() => {
    alive.current = true
    void refresh()
    return () => { alive.current = false; ++request.current }
  }, [refresh])
  // A worker may finish while the page is open. Never replace an alignment editor's working
  // revision — the object page is safe, it reads its own copy.
  useEffect(() => {
    if (opened || busy) return
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 15000)
    return () => window.clearInterval(timer)
  }, [opened, busy, refresh])
  const rows = objects ?? []
  const items = useMemo(() => queue?.items ?? [], [queue])
  const proposals = items.filter(isProposal).length
  // A tab that has nothing to decide is disabled, so leaving the last proposal behind must not
  // strand the page on an unreachable tab.
  const shown: Tab = tab === 'proposals' && !proposals ? 'objects' : tab
  const current = rows.find(obj => obj.id === selected) ?? null
  const facts = useMemo(() => planFacts(modules, items, alignmentError), [modules, items, alignmentError])
  const visible = rows.filter(obj => `${obj.name} ${obj.address ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    && (filter === 'all' || (filter === 'attention' ? facts.pending(obj) : facts.approved(obj))))
  const mapObjects = useMemo(() => (objects ?? []).flatMap(obj => obj.lat != null && obj.lng != null
    ? [{ id: obj.id, name: obj.name, lat: obj.lat, lng: obj.lng }] : []), [objects])
  /** One decided sheet back into the page's copy – whoever decided it, the wall or the editor. */
  const merge = useCallback((next: AlignmentListItem) => {
    ++request.current // a list request from before the decision must not overwrite its response
    setQueue(q => q ? { ...q, items: q.items.map(item => item.id === next.id ? next : item) } : q)
  }, [])
  const update = (next: AlignmentListItem) => { merge(next); setOpened(next) }
  const source = useMemo(() => ({ queue, update: merge, reload: refresh }), [queue, merge, refresh])
  const choose = (id: string) => { setSelected(id); setTab('objects') }
  // Whatever the editor writes — the first save of a new object, a corrected field, a PDF —
  // goes straight into the list behind it, so returning shows the truth without a round trip.
  const changed = (obj: ObjectWithPlans) => {
    setObjects(prev => [...(prev ?? []).filter(row => row.id !== obj.id), obj].sort((a, b) => a.name.localeCompare(b.name)))
    void refresh()
  }
  const retry = <button className="btn adm-int-btn" type="button" onClick={() => void refresh()} disabled={busy}>{C.refresh}</button>

  return <section className="adm-object-plans">
    {selected !== null ? <>
      <div className="adm-actions">
        <button className="btn adm-int-btn" type="button" onClick={() => setSelected(null)}><Icon id="chevron-left" />{C.back}</button>
      </div>
      {alignmentError && <div role="alert"><EmptyState tone="err" message={A.loadFailed} action={retry} /></div>}
      <ObjectEditor
        object={current}
        onChanged={changed}
        plans={(saved, onStored) => <ObjectPlanRows
          object={saved}
          modules={modules}
          facts={facts}
          onStored={onStored}
          onPrepare={setOpened}
        />}
      />
    </> : <>
      <Segmented<Tab> value={shown} onChange={setTab} ariaLabel={appConfig.copy.admin.modules.objectsTitle}
        options={[
          { value: 'objects', label: C.objects },
          // the wall of staged ✓/✕ lives here now — the badge says how much is waiting, and a
          // tab with nothing to decide is off rather than an empty page to walk into
          { value: 'proposals', label: fillTemplate(C.proposals, { n: proposals }), disabled: proposals === 0 },
          { value: 'overview', label: C.overview },
        ]} />
      {shown === 'objects' ? <Card>
        <div className="aop-tools">
          <input className="adm-input" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={C.search} aria-label={C.search} />
          <Segmented<Filter> value={filter} onChange={setFilter} ariaLabel={C.status}
            options={[{ value: 'all', label: C.all }, { value: 'attention', label: C.attention }, { value: 'approved', label: C.approved }]} />
        </div>
        {objectsError && <div role="alert"><EmptyState tone="err" message={D.objectsError} action={retry} /></div>}
        {!objects && !objectsError && <div role="status"><EmptyState message={D.objectsLoading} /></div>}
        {alignmentError && <div role="alert"><EmptyState tone="err" message={A.loadFailed} action={retry} /></div>}
        {visible.length > 0 && <Table className="adm-vtable aop-table" columns={[
          { key: 'object', label: C.colObject },
          { key: 'plans', label: C.plans },
          { key: 'status', label: C.status },
          // no «Aktionen»: the row is the action, and the chevron says so
          { key: 'go', label: '' },
        ]}>
          {visible.map(obj => {
            const state = facts.objectStatus(obj)
            return <tr key={obj.id} className="aop-row" onClick={() => choose(obj.id)}>
              {/* ⚠️ ONE control, not two: the whole row opens the object for the finger, and the
                  button spanning the name cell is the SAME destination for a keyboard and a
                  screen reader. A separate «Öffnen» button beside it was a second target for an
                  act the row already performs. */}
              <td>
                <button type="button" className="aop-open"
                  onClick={e => { e.stopPropagation(); choose(obj.id) }}>
                  <span className="aop-name">{obj.name}</span>
                  {obj.address && <span className="aop-addr">{obj.address}</span>}
                </button>
              </td>
              {/* Which modules this object HAS, in their short form — the same «M1 · M5 PV · M6»
                  that is on the paper plan, in the order the plans are bound in (lib/planOrder).
                  Never the storage key: `modul5-pv` is a path. */}
              <td className="aop-plans">{obj.plans.length
                ? <span className="aop-codes">{sortPlansByModule(modules, obj.plans).map(plan =>
                  <span className="aop-code" key={plan.id}>{plan.module
                    ? moduleShortForm(modules, plan.module) : plan.kind}</span>)}</span>
                : <span className="adm-fleet-freeval">{D.noPlans}</span>}</td>
              <td><StatusBadge tone={state.tone} label="" state={state.label} /></td>
              <td className="aop-go" aria-hidden><Icon id="chevron" /></td>
            </tr>
          })}
        </Table>}
        {objects && !visible.length && <EmptyState message={rows.length ? C.empty : C.none} />}
        <button type="button" className="adm-formlink-add" onClick={() => setSelected('new')}><Icon id="plus" />{O.add}</button>
      </Card> : shown === 'proposals' ? <>
        {alignmentError && <div role="alert"><EmptyState tone="err" message={A.loadFailed} action={retry} /></div>}
        <PlanAlignmentReview compact embedded source={source} />
      </> : <>
        {overview(rows)}
        {mapObjects.length > 0 && <Card title={C.map}>
          <div className="aop-map">
            <Suspense fallback={<EmptyState message={D.mapLoading} />}>
              <ObjectsMap objects={mapObjects} selectedId={null} onSelect={choose} hoveredId={null} onHover={() => {}} />
            </Suspense>
          </div>
        </Card>}
      </>}
    </>}
    {opened && <PlanAlignmentEditor key={opened.id} item={opened} onClose={() => { setOpened(null); void refresh() }} onChange={update} onConflict={refresh} />}
  </section>
}

/**
 * One object's Modul-PDFs — ONE TABLE row per catalogue module: the module (identified by its
 * short form, «M6 · Gebäudepläne»), what PDF sits in it, how far its preparation got. A catalogue
 * module with no PDF is the same row, and a plan whose module the catalogue dropped is still
 * shown rather than becoming a file the crew opens and nobody can replace. The rows follow
 * `lib/planOrder` — M4 before M5, ZUS and M6, as the plans are bound.
 *
 * No card title and no caption: the page is already one object's Objektpläne page and the first
 * column names every module, so a heading here only repeated the sidebar.
 *
 * ⚠️ The SAME `.adm-table`/`.adm-vtable` chrome as the object list above it, not record cards:
 * a card per module turned twelve short rows into a wall, and nothing here nests. A family
 * module (Modul 5) only ever shows the sub-slots it already has — there is no add row: a new
 * sub-slot comes from a pull or the `admin_objects` CLI, never from this table.
 */
function ObjectPlanRows({ object, modules, facts, onStored, onPrepare }: {
  object: ObjectWithPlans
  modules: DeploymentModule[]
  facts: PlanFacts
  onStored: (ds: ReferenceDataset) => void
  onPrepare: (item: AlignmentListItem) => void
}) {
  const C = appConfig.copy.admin.objectPlans
  const D = appConfig.copy.admin.data
  const catalogue = useMemo(() => sortPlanModules(modules), [modules])
  const slots = useMemo(() => planSlots(catalogue, object.plans), [catalogue, object.plans])
  const { busySlot, err, upload } = usePlanUpload(object.id, onStored)

  // No card title and no caption: the page is already one object's Objektpläne page, and the
  // table's own first column names every module. A heading here only repeated the sidebar.
  return <Card>
    {slots.length > 0 && <Table className="adm-vtable aop-plantable" columns={[
      { key: 'module', label: C.colModule },
      { key: 'plan', label: C.colPlan },
      { key: 'status', label: C.status },
      // no «Aktionen»: the row IS the action, and the chevron – or the upload arrow – says so
      { key: 'go', label: '' },
    ]}>
      {slots.map(slot => <PlanRow
        key={slot.id}
        slot={slot}
        facts={facts}
        busy={busySlot === slot.id}
        error={err?.slot === slot.id ? err.detail : null}
        onUpload={file => void upload(slot.id, file)}
        onPrepare={onPrepare}
      />)}
    </Table>}
    {!slots.length && <EmptyState message={D.noPlans} />}
  </Card>
}

/**
 * ONE module's row — and the ROW is the control, the same grammar as the object list above it
 * (15.09.2026). What the press does follows what the row IS:
 *
 * - a PDF whose module can be prepared → the full-screen editor, affordance: the chevron
 * - a PDF in a document-only module (or one the queue cannot describe) → the PDF itself in a new
 *   tab, same chevron
 * - no PDF yet → the file picker, affordance: an upload arrow, and the Plan cell says «PDF wählen»
 *
 * ⚠️ No primary buttons any more. «Vorbereiten», «PDF wählen» and «PDF ersetzen» were three
 * labels of three widths starting at three different places down one column, which is what this
 * replaced. The kebab is the only real control left, it exists ONLY on rows that HAVE a PDF, and
 * its 34px slot is held open on the others so nothing shifts between rows.
 *
 * ⚠️ ONE destination, never two targets for one act: the `<tr>` takes the finger, the button
 * spanning the Modul cell takes a keyboard and a screen reader, and a press that landed on the
 * kebab or on that button belongs to it — the row does not fire a second time.
 */
function PlanRow({ slot, facts, busy, error, onUpload, onPrepare }: {
  slot: Slot
  facts: PlanFacts
  /** this slot's upload is running */
  busy: boolean
  /** this slot's own upload failure, shown under the row */
  error: string | null
  onUpload: (file: File) => void
  onPrepare: (item: AlignmentListItem) => void
}) {
  const C = appConfig.copy.admin.objectPlans
  const O = appConfig.copy.admin.objects
  // A callback ref into state, not a `useRef`: the menu item is built during render, and a
  // handler that reaches into a ref there is exactly what «Cannot access refs during render»
  // means. The element itself is all this needs.
  const [picker, setPicker] = useState<HTMLInputElement | null>(null)
  const plan = slot.plan
  const item = plan ? facts.itemFor(plan) : undefined
  const state = plan ? facts.planStatus(plan) : null
  const prepare = plan && item && facts.eligible(plan) && !facts.alignmentError ? item : null
  const openPdf = () => plan && window.open(referenceUrl(plan.id, plan.current_version), '_blank', 'noopener')
  // what this row IS, read once: the press, the kebab and the affordance all follow it
  const go = () => {
    if (busy) return
    if (prepare) onPrepare(prepare)
    else if (plan) openPdf()
    else picker?.click()
  }
  // The kebab's «PDF ersetzen» drives the same hidden picker the empty row's press does — one
  // upload path, whichever control started it.
  const actions: MenuAction[] = plan
    ? [{ label: C.pdf, onClick: openPdf }, { label: O.replacePdf, onClick: () => picker?.click() }]
    : []

  return <Fragment>
    <tr
      className="aop-planrow"
      aria-busy={busy || undefined}
      onClick={e => { if (!(e.target as HTMLElement).closest('button, a')) go() }}
    >
      <td>
        <button type="button" className="aop-open" onClick={go} disabled={busy}>
          <span className="aop-plan-name">
            <span className="adm-view-code">{slot.short}</span>
            {slot.title}
          </span>
        </button>
        {slot.offCatalogue && <span className="adm-view-badge adm-view-badge-warn">{O.offCatalogue}</span>}
      </td>
      <td>{busy
        ? <span className="adm-fleet-freeval" role="status">{O.uploading}</span>
        : plan
          ? <span className="aop-source">
            <span className="adm-view-key">{fillTemplate(O.planVersion, { n: plan.current_version, date: fmtDate(plan.updated_at) })}</span>
            <PlanSourceBadge sourceType={plan.source_type} />
            <span className="adm-ref-note">{fmtBytes(plan.size_bytes)}</span>
          </span>
          // the row's press opens the picker, so the empty cell says what it would pick
          : <span className="adm-fleet-freeval">{O.choosePdf}</span>}</td>
      <td>{state && <StatusBadge tone={state.tone} label="" state={state.label} />}</td>
      <td className="aop-planact">
        {actions.length > 0
          ? <ActionMenu actions={actions} ariaLabel={fillTemplate(C.moreActions, { module: slot.short })} disabled={busy} />
          : <span className="aop-act-gap" aria-hidden />}
        {/* it points where the press goes, it is not a second button – the whole row already is one */}
        <span className="aop-go" aria-hidden><Icon id={plan ? 'chevron' : 'upload'} /></span>
        <input
          ref={setPicker}
          type="file"
          accept="application/pdf,.pdf"
          style={{ display: 'none' }}
          onChange={e => {
            const f = e.target.files?.[0]
            e.target.value = '' // so picking the SAME corrected file twice still fires
            if (f) onUpload(f)
          }}
        />
      </td>
    </tr>
    {/* the row's own failure, under it and across the full width, so it reads as one sentence
        about THAT module rather than a page-level alarm */}
    {error && <tr className="aop-planerr">
      <td colSpan={4}><span className="adm-state adm-state-err" role="alert">{error}</span></td>
    </tr>}
  </Fragment>
}
