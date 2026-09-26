import { useMemo, useState, type ReactNode } from 'react'
import { appConfig } from '../../config/appConfig'
import { fillTemplate, formatTime } from '../../lib/format'
import { Icon } from '../../lib/icons'
import {
  BEREICH_STATUSES, personenViews, sucheGroups, sucheProgress, truppShort, truppsOnStorey, vermisstCount,
  type BereichView, type PersonView, type SucheGroup, type TruppHere,
} from '../../lib/suche'
import type { SucheActions } from '../../lib/useSucheActions'
import type { SucheBereichStatus, SucheDoc } from '../../types'
import { EmptyState } from '../EmptyState'
import { OnOff } from '../Segmented'
import { Stepper } from '../Stepper'
import s from './Suche.module.css'

export type SucheTab = 'personen' | 'bereiche'

/** What the panel shows: the list, or one record / one form in its place. Forms live INSIDE the
 *  panel (F5 «+ Vermisst · ohne das Panel zu verlassen»): the plan beside it stays usable, and
 *  there is never a second sheet over the first. */
type View =
  | { kind: 'list' }
  | { kind: 'vermisst'; found?: boolean; preset?: FundPreset }
  | { kind: 'person'; id: string }
  | { kind: 'gefunden'; id: string; preset?: FundPreset }
  | { kind: 'fund'; preset: FundPreset }
  | { kind: 'uebergeben'; id: string }
  | { kind: 'bereich'; id: string }
  | { kind: 'teilen'; floor: number }
  | { kind: 'rename'; id: string }
  | { kind: 'addBereich' }
  | { kind: 'korrigieren'; id: string }
  | { kind: 'entwarnen' | 'irrtuemlich'; id: string }

/** «Fund melden» on a Trupp (Tür 3): the Trupp and its storey, pre-filled into the find */
export interface FundPreset { truppId: string; floor?: number }

export interface SuchePanelProps {
  doc: SucheDoc
  /** the Gebäude stack's storeys (empty = no Gebäude) */
  floors: readonly number[]
  floorName: (floor: number) => string
  /** which Gebäude those storeys are (lib/suche · stackKeyOf) */
  stackKey: string
  /** the areas whose Trupp is out and nobody has said yet whether they are abgesucht
   *  (lib/suche · pendingAsks) — the question stands on the row itself */
  asks?: readonly string[]
  /** the Trupps on the board, as the Suche names them */
  trupps: readonly TruppHere[]
  /** which storey each placed Trupp marker stands on — «Gefunden…» pre-selects from it */
  placed: readonly { truppId: string; floor: number }[]
  canEdit: boolean
  actions: SucheActions
  tab: SucheTab
  onTab: (t: SucheTab) => void
  /** open one record straight away (a Verlauf row, the head chip) — keyed by `nonce` */
  focus?: { personId?: string; bereichId?: string; fund?: FundPreset; nonce: number } | null
  /** scroll the Gebäude to this storey (a row or a storey heading was tapped) */
  onFloor?: (floor: number) => void
  /** «weiter an» — the station's short list */
  uebergabe: readonly string[]
  /** The panel hosts ONE flow and hands back when it is done (the «Fund melden» sheet over the
   *  Atemschutz board, N17): every «done» and every ‹ calls this instead of showing the list. */
  onExit?: () => void
}

const hhmm = (iso?: string) => (iso && Number.isFinite(Date.parse(iso)) ? formatTime(new Date(iso)) : '')

/** The Suche's list and its flows — the same component in the tablet dock and the phone sheet. */
export function SuchePanel(p: SuchePanelProps) {
  const C = appConfig.copy.suche
  // a jump from outside (a Verlauf row, the head chip, «Fund melden») opens its record straight
  // away — the frame remounts the panel per jump (`key` = the focus nonce), so this is its FIRST
  // view rather than an effect that overwrites whatever was open
  const [view, setView] = useState<View>(() => {
    const f = p.focus
    if (f?.fund) return { kind: 'fund', preset: f.fund }
    if (f?.personId && p.doc.personen.some((x) => x.id === f.personId)) return { kind: 'person', id: f.personId }
    if (f?.bereichId) return { kind: 'bereich', id: f.bereichId }
    return { kind: 'list' }
  })
  const personen = useMemo(() => personenViews(p.doc), [p.doc])
  const groups = useMemo(() => sucheGroups(p.doc, { key: p.stackKey, floors: p.floors, floorName: p.floorName }), [p.doc, p.stackKey, p.floors, p.floorName])
  const progress = sucheProgress(groups)
  const missing = vermisstCount(p.doc)


  // hosted as one flow (the «Fund melden» sheet): done is done — the host closes, never the list
  const go = (next: View) => (p.onExit ? p.onExit() : setView(next))
  const back = () => go({ kind: 'list' })
  const person = (id: string) => personen.find((x) => x.id === id)
  const bereich = (id: string) => groups.flatMap((g) => [...g.units, ...(g.storeyRow ? [g.storeyRow] : [])]).find((u) => u.id === id)

  let body: ReactNode
  let foot: ReactNode = null
  // the tabs belong to the LIST; a record's card has its own ‹ back instead
  let inList = false
  if (view.kind === 'vermisst') {
    return <VermisstForm {...p} found={view.found} preset={view.preset} onDone={back} />
  } else if (view.kind === 'fund') {
    body = <FundPicker preset={view.preset} personen={personen} {...p} onBack={back}
      onPerson={(id) => setView({ kind: 'gefunden', id, preset: view.preset })}
      onOther={() => setView({ kind: 'vermisst', found: true, preset: view.preset })} />
  } else if (view.kind === 'person' && person(view.id)) {
    body = <PersonCard v={person(view.id)!} {...p} onBack={back} onFound={() => setView({ kind: 'gefunden', id: view.id })}
      onHand={() => setView({ kind: 'uebergeben', id: view.id })} onFix={() => setView({ kind: 'korrigieren', id: view.id })}
      onWhy={(kind) => setView({ kind, id: view.id })} />
  } else if ((view.kind === 'entwarnen' || view.kind === 'irrtuemlich') && person(view.id)) {
    return <WhyForm kind={view.kind} v={person(view.id)!} {...p} onCancel={() => setView({ kind: 'person', id: view.id })} onDone={back} />
  } else if (view.kind === 'korrigieren' && person(view.id)) {
    return <KorrigierenForm v={person(view.id)!} {...p} onDone={() => setView({ kind: 'person', id: view.id })} />
  } else if (view.kind === 'gefunden' && person(view.id)) {
    return <GefundenForm v={person(view.id)!} {...p} preset={view.preset} onDone={() => go({ kind: 'person', id: view.id })} />
  } else if (view.kind === 'uebergeben' && person(view.id)) {
    return <UebergebenForm v={person(view.id)!} {...p} onDone={() => setView({ kind: 'person', id: view.id })} />
  } else if (view.kind === 'bereich' && bereich(view.id)) {
    const b = bereich(view.id)!
    body = <BereichCard b={b} group={groups.find((g) => g.units.includes(b) || g.storeyRow === b)} {...p} onBack={back}
      onSplit={(f) => setView({ kind: 'teilen', floor: f })} onRename={() => setView({ kind: 'rename', id: b.id })} />
  } else if (view.kind === 'teilen') {
    return <TeilenForm floor={view.floor} group={groups.find((g) => g.floor === view.floor)} {...p} onDone={back} />
  } else if (view.kind === 'rename' && bereich(view.id)) {
    return <RenameForm b={bereich(view.id)!} {...p} onDone={() => setView({ kind: 'bereich', id: view.id })} />
  } else if (view.kind === 'addBereich') {
    return <BereichForm {...p} onDone={back} />
  } else {
    inList = true
    body = p.tab === 'personen'
      ? <PersonenList personen={personen} {...p} onOpen={(id) => setView({ kind: 'person', id })} />
      : <BereicheList groups={groups} {...p} onOpen={(b) => { if (b.floor != null) p.onFloor?.(b.floor); setView({ kind: 'bereich', id: b.id }) }} />
    foot = p.canEdit ? (
      p.tab === 'personen' ? (
        <>
          <button type="button" className="ip-btn" onClick={() => setView({ kind: 'vermisst' })}><Icon id="plus" />{C.addVermisst}</button>
          <button type="button" className="ip-btn" onClick={() => setView({ kind: 'vermisst', found: true })}><Icon id="plus" />{C.addGefunden}</button>
        </>
      ) : (
        <button type="button" className="ip-btn" onClick={() => setView({ kind: 'addBereich' })}><Icon id="plus" />{C.addBereich}</button>
      )
    ) : null
  }

  return (
    <div className={s.panel}>
      {inList && (
        <div className={s.tabs} role="tablist" aria-label={C.title}>
          <button type="button" role="tab" aria-selected={p.tab === 'personen'} className={`${s.tab}${p.tab === 'personen' ? ` ${s.on}` : ''}`} onClick={() => p.onTab('personen')}>
            {C.tabPersonen}
            {missing > 0 && <span className={s.tabBadge}>{missing}</span>}
          </button>
          <button type="button" role="tab" aria-selected={p.tab === 'bereiche'} className={`${s.tab}${p.tab === 'bereiche' ? ` ${s.on}` : ''}`} onClick={() => p.onTab('bereiche')}>
            {C.tabBereiche}
            {progress.total > 0 && <span className={s.tabCount}>{fillTemplate(C.progress, progress)}</span>}
            {/* the open «abgesucht?» questions, counted — the tab is where they are answered */}
            {(p.asks?.length ?? 0) > 0 && <span className={s.askBadge} aria-label={fillTemplate(C.asksOpen, { n: p.asks!.length })}>{p.asks!.length}?</span>}
          </button>
        </div>
      )}
      <div className={s.scroll}>{body}</div>
      {foot && <div className={s.foot}>{foot}</div>}
      {!p.canEdit && inList && <div className={s.readOnly}>{C.readOnlyNote}</div>}
    </div>
  )
}

// ── the lists ────────────────────────────────────────────────────────────────────────────────

const PERSON_TONE: Record<PersonView['status'], string> = { vermisst: 'red', gefunden: 'amber', uebergeben: 'green', entwarnt: 'grey', irrtuemlich: 'grey' }
// «teilweise» wears its own colour AND a half-filled dot (N14): never the grey of «offen», never
// the full green of «abgesucht»
const BEREICH_TONE: Record<SucheBereichStatus, string> = { offen: 'grey', inArbeit: 'blue', teilweise: 'part', abgesucht: 'green', nichtZugaenglich: 'amber' }

function personLine(v: PersonView, floorName: (f: number) => string, trupps: readonly TruppHere[], doc: SucheDoc): string {
  const C = appConfig.copy.suche
  const where = [v.floor != null ? floorName(v.floor) : '', v.wo ?? ''].filter(Boolean).join(' ')
  if (v.status === 'vermisst' && !v.found) {
    const searching = v.floor != null ? truppsOnStorey(doc, v.floor, trupps, [])[0] : undefined
    return [where || C.storeyUnknown, fillTemplate(C.since, { t: hhmm(v.vermisstAt) }), searching ? fillTemplate(C.sucht, { trupp: truppShort(searching.label) }) : ''].filter(Boolean).join(' · ')
  }
  if (v.status === 'entwarnt') return [where, `${C.status.entwarnt} ${hhmm(v.entwarntAt)}`].filter(Boolean).join(' · ')
  if (v.status === 'irrtuemlich') return `${C.status.irrtuemlich} ${hhmm(v.withdrawnAt)}`
  const foundWhere = [v.foundFloor != null ? floorName(v.foundFloor) : '', v.foundWo ?? ''].filter(Boolean).join(' ')
  return [foundWhere, v.foundTrupp ? truppShort(v.foundTrupp) : '', hhmm(v.foundAt), v.an ? `${C.an.toLowerCase()} ${v.an}` : ''].filter(Boolean).join(' · ')
}

function PersonenList({ personen, floorName, trupps, doc, onOpen, canEdit }: SuchePanelProps & { personen: PersonView[]; onOpen: (id: string) => void }) {
  const C = appConfig.copy.suche
  if (!personen.length) {
    return <EmptyState icon="people" title={C.emptyPersonen} sub={canEdit ? C.emptyPersonenSub : undefined} className={s.empty} />
  }
  return (
    <ul className={s.list}>
      {personen.map((v) => (
        <li key={v.id}>
          <button type="button" className={s.row} onClick={() => onOpen(v.id)} data-tone={PERSON_TONE[v.status]} data-withdrawn={v.status === 'irrtuemlich' || undefined}>
            <span className={s.rowMain}>
              <span className={s.rowTitle}>{v.label}</span>
              {/* a group's count leads its sub-line («0 / 22 gefunden · …») — beside the name it
                  was cut off first, on the one line that has to be readable */}
              <span className={s.rowSub}>
                {v.group && <span className={s.count}>{fillTemplate(C.groupFound, { found: v.found, count: v.count })} · </span>}
                {personLine(v, floorName, trupps, doc)}
              </span>
            </span>
            <span className={s.pill} data-tone={PERSON_TONE[v.status]}>
              {v.group && v.missing > 0 ? fillTemplate(C.groupMissing, { n: v.missing }) : C.status[v.status]}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function bereichLine(b: BereichView): string {
  const C = appConfig.copy.suche
  if (b.status === 'inArbeit') return b.trupp ? fillTemplate(C.sucht, { trupp: truppShort(b.trupp) }) : C.bereichStatus.inArbeit
  return [C.bereichStatus[b.status], b.trupp ? truppShort(b.trupp) : '', b.status === 'offen' ? '' : hhmm(b.statusAt)].filter(Boolean).join(' · ')
}

function BereicheList({ groups, onOpen, onFloor, canEdit, asks, actions }: SuchePanelProps & { groups: SucheGroup[]; onOpen: (b: BereichView) => void }) {
  const C = appConfig.copy.suche
  if (!groups.length) {
    return <EmptyState icon="floors" title={C.emptyBereiche} sub={canEdit ? C.emptyBereicheSub : undefined} className={s.empty} />
  }
  return (
    <div className={s.groups}>
      {groups.map((g) => (
        <section key={g.key} className={s.group}>
          <button type="button" className={s.groupHead} disabled={g.floor == null || !onFloor} onClick={() => g.floor != null && onFloor?.(g.floor)}
            data-complete={g.complete || undefined}>
            <span className={s.groupName}>{g.label}</span>
            <span className={s.groupProg}>{fillTemplate(C.progress, { done: g.done, total: g.total })}{g.complete && <Icon id="check" />}</span>
          </button>
          <ul className={s.list}>
            {g.units.map((u) => (
              <li key={u.id}>
                <button type="button" className={`${s.row} ${s.rowTight}`} onClick={() => onOpen(u)} data-tone={BEREICH_TONE[u.status]}>
                  <span className={s.rowMain}>
                    <span className={s.rowTitle}>{u.short}</span>
                    <span className={s.rowSub}>{bereichLine(u)}</span>
                  </span>
                  {u.fund && <span className={s.fund}>{C.fund}</span>}
                  <span className={s.dot} data-tone={BEREICH_TONE[u.status]} aria-hidden>{u.status === 'abgesucht' && <Icon id="check" />}</span>
                </button>
                {canEdit && asks?.includes(u.id) && <AskRow u={u} actions={actions} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/**
 * «Trupp 4 raus – abgesucht? Ja / Teilweise / Nein» — on the area's own row, NOT a dialog: it waits
 * there for whoever runs the list, on every editor device (the Raus may have come from a
 * handed-over board), and a question nobody answers writes nothing.
 */
function AskRow({ u, actions }: { u: BereichView; actions: SucheActions }) {
  const C = appConfig.copy.suche
  const trupp = { label: u.trupp, id: u.truppId }
  return (
    <div className={s.ask} role="group" aria-label={fillTemplate(C.askInline, { trupp: u.trupp ?? '' })}>
      <span className={s.askText}>{fillTemplate(C.askInline, { trupp: truppShort(u.trupp ?? '') })}</span>
      <button type="button" className={s.askBtn} onClick={() => actions.setStatus(u.id, 'abgesucht', trupp)}>{C.rausJa}</button>
      {/* «Teilweise» is its own status (N14) and keeps the Trupp: «teilweise abgesucht · T1 · 14:19» */}
      <button type="button" className={s.askBtn} onClick={() => actions.setStatus(u.id, 'teilweise', trupp)}>{C.rausTeilweise}</button>
      <button type="button" className={s.askBtn} onClick={() => actions.setStatus(u.id, 'offen')}>{C.rausNein}</button>
    </div>
  )
}

// ── one record ───────────────────────────────────────────────────────────────────────────────

function History({ rows }: { rows: { id: string; at: string; text: string }[] }) {
  if (!rows.length) return null
  return (
    <ol className={s.history}>
      {rows.map((r) => (
        <li key={r.id}><span className={s.histT}>{hhmm(r.at)}</span><span>{r.text}</span></li>
      ))}
    </ol>
  )
}

function CardHead({ title, tone, pill, onBack }: { title: string; tone: string; pill: string; onBack: () => void }) {
  return (
    <div className={s.cardHead}>
      <button type="button" className={s.back} onClick={onBack} aria-label={appConfig.copy.suche.back}><Icon id="chevron-left" /></button>
      <h3 className={s.cardTitle}>{title}</h3>
      <span className={s.pill} data-tone={tone}>{pill}</span>
    </div>
  )
}

function PersonCard({ v, floorName, canEdit, onBack, onFound, onHand, onFix, onWhy }: SuchePanelProps & { v: PersonView; onBack: () => void; onFound: () => void; onHand: () => void; onFix: () => void; onWhy: (kind: 'entwarnen' | 'irrtuemlich') => void }) {
  const C = appConfig.copy.suche
  const where = [v.floor != null ? floorName(v.floor) : '', v.wo ?? ''].filter(Boolean).join(' ')
  return (
    <div className={s.card}>
      <CardHead title={v.label} tone={PERSON_TONE[v.status]} onBack={onBack}
        pill={v.group ? fillTemplate(C.groupFound, { found: v.found, count: v.count }) : C.status[v.status]} />
      <p className={s.cardLine}>
        {[fillTemplate(C.zuletztLine, { wo: where || C.unbekannt }), v.quelle ? fillTemplate(C.quelleLine, { quelle: v.quelle }) : '', hhmm(v.vermisstAt)].filter(Boolean).join(' · ')}
      </p>
      {canEdit && (
        <div className={s.cardActions}>
          {(v.status === 'vermisst') && <button type="button" className="ip-btn primary" onClick={onFound}>{C.gefundenBtn}</button>}
          {(v.found > v.handed) && <button type="button" className="ip-btn" onClick={onHand}>{C.uebergebenBtn}</button>}
          {/* ⚠️ «Entwarnen» ends a missing-person record: it asks why and who said so first (N7) */}
          {v.status === 'vermisst' && v.found === 0 && (
            <button type="button" className="ip-btn" onClick={() => onWhy('entwarnen')}>{C.entwarnenBtn}</button>
          )}
          {/* a wrong name, count or place is a row (lib/suche · korrigiert), one ↶ away */}
          {v.status !== 'irrtuemlich' && <button type="button" className="ip-btn" onClick={onFix}>{C.korrigierenBtn}</button>}
        </div>
      )}
      <History rows={v.rows} />
      {/* ⚠️ «Irrtümlich erfasst» stands APART, at the foot of the card — it was the red button right
          beside «Korrigieren …» and withdrew a person in one tap (walk-through 25.09.2026, N7) */}
      {canEdit && v.status !== 'irrtuemlich' && (
        <div className={s.cardFoot}>
          <button type="button" className="ip-btn ip-btn-danger" onClick={() => onWhy('irrtuemlich')}>{C.irrtuemlichBtn}</button>
        </div>
      )}
    </div>
  )
}

function BereichCard({ b, group, trupps, canEdit, actions, onBack, onSplit, onRename }: SuchePanelProps & { b: BereichView; group?: SucheGroup; onBack: () => void; onSplit: (floor: number) => void; onRename: () => void }) {
  const C = appConfig.copy.suche
  const [pickTrupp, setPickTrupp] = useState(false)
  const set = (st: SucheBereichStatus, t?: TruppHere | null) => {
    actions.setStatus(b.id, st, t ? { label: t.label, id: t.id } : t === null ? { label: undefined } : undefined)
    setPickTrupp(false)
  }
  const statuses = BEREICH_STATUSES
  const restRow = b.storey && !!group?.hasParts
  return (
    <div className={s.card}>
      <CardHead title={b.full} tone={BEREICH_TONE[b.status]} pill={b.status === 'inArbeit' && b.trupp ? fillTemplate(C.statusInArbeit, { trupp: truppShort(b.trupp) }) : C.bereichStatus[b.status]} onBack={onBack} />
      {canEdit && (
        <>
          <div className={s.label}>{C.statusTitle}</div>
          <div className={s.chips} role="group" aria-label={C.statusTitle}>
            {statuses.map((st) => (
              <button key={st} type="button" className={s.chip} data-tone={BEREICH_TONE[st]} aria-pressed={b.status === st}
                onClick={() => (st === 'inArbeit' && trupps.length ? setPickTrupp(true) : set(st))}>
                {st === 'inArbeit' && b.status === 'inArbeit' && b.trupp ? fillTemplate(C.statusInArbeit, { trupp: truppShort(b.trupp) }) : C.bereichStatus[st]}
              </button>
            ))}
            <button type="button" className={s.chip} data-tone="red" aria-pressed={b.fund} disabled={b.fund} onClick={() => actions.fund(b.id)}>{C.fund}</button>
          </div>
          {pickTrupp && (
            <>
              <div className={s.label}>{C.truppPick}</div>
              <div className={s.chips}>
                {trupps.map((t) => <button key={t.id} type="button" className={s.chip} onClick={() => set('inArbeit', t)}>{t.short}</button>)}
                <button type="button" className={s.chip} onClick={() => set('inArbeit', null)}>{C.truppNone}</button>
              </div>
            </>
          )}
          <div className={s.cardActions}>
            {b.storey && b.floor != null && <button type="button" className="ip-btn" onClick={() => onSplit(b.floor!)}>{C.teilen}</button>}
            {!b.storey && b.name && <button type="button" className="ip-btn" onClick={onRename}>{C.umbenennen}</button>}
            {restRow && b.floor != null && <button type="button" className="ip-btn" onClick={() => { actions.setOhneRest(b.floor!, true); onBack() }}>{C.restEntfernen}</button>}
          </div>
        </>
      )}
      <History rows={b.rows} />
    </div>
  )
}

/** «Fund melden» from a Trupp: who was found — one of the missing, or somebody not on the list */
function FundPicker({ preset, personen, trupps, floorName, onBack, onPerson, onOther }: SuchePanelProps & { preset: FundPreset; personen: PersonView[]; onBack: () => void; onPerson: (id: string) => void; onOther: () => void }) {
  const C = appConfig.copy.suche
  const t = trupps.find((x) => x.id === preset.truppId)
  const title = fillTemplate(C.fundTitle, { trupp: t?.label ?? '' }) + (preset.floor != null ? ` · ${floorName(preset.floor)}` : '')
  const missing = personen.filter((x) => x.status === 'vermisst')
  return (
    <div className={s.card}>
      <CardHead title={title} tone="red" pill={C.fund} onBack={onBack} />
      <div className={s.label}>{C.fundWer}</div>
      <div className={s.chips}>
        {missing.map((x) => (
          <button key={x.id} type="button" className={s.chip} onClick={() => onPerson(x.id)}>
            {x.label}{x.group ? ` · ${fillTemplate(C.groupMissing, { n: x.missing })}` : ` (${C.status.vermisst})`}
          </button>
        ))}
        <button type="button" className={s.chip} onClick={onOther}>{C.fundAndere}</button>
      </div>
    </div>
  )
}

// ── forms ────────────────────────────────────────────────────────────────────────────────────

function Form({ title, children, submit, submitLabel, disabled, onCancel, focusCancel, danger }: { title: string; children: ReactNode; submit: () => void; submitLabel: string; disabled?: boolean; onCancel: () => void
  /** «Abbrechen» takes the focus — for a form that ENDS something (N7): Enter must not */
  focusCancel?: boolean
  danger?: boolean }) {
  return (
    // ⚠️ NOT a <form>: the shared Stepper renders plain <button>s, and inside a form every one of
    // them is a submit — «+» on «Anzahl» reported the group missing at 3 (found in the visual pass)
    <div className={s.panel} role="group" aria-label={title}>
      <div className={s.scroll}>
        <div className={s.form}>
          <h3 className={s.formTitle}>{title}</h3>
          {children}
        </div>
      </div>
      <div className={s.foot}>
        <button type="button" className="ip-btn" onClick={onCancel} autoFocus={focusCancel}>{appConfig.copy.suche.cancel}</button>
        <button type="button" className={`ip-btn ${danger ? 'ip-btn-danger' : 'primary'}`} disabled={disabled} onClick={() => { if (!disabled) submit() }}>{submitLabel}</button>
      </div>
    </div>
  )
}

/** Storey chips top to bottom, plus «unbekannt» — the one way a storey is picked in the Suche. */
function StoreyChips({ floors, floorName, value, onChange, unknown = true, label }: { floors: readonly number[]; floorName: (f: number) => string; value: number | undefined; onChange: (f: number | undefined) => void; unknown?: boolean; label: string }) {
  const C = appConfig.copy.suche
  if (!floors.length) return null
  return (
    <div className={s.chips} role="group" aria-label={label}>
      {[...floors].sort((a, b) => b - a).map((f) => (
        <button key={f} type="button" className={s.chip} aria-pressed={value === f} onClick={() => onChange(value === f ? undefined : f)}>{floorName(f)}</button>
      ))}
      {unknown && <button type="button" className={s.chip} aria-pressed={value == null} onClick={() => onChange(undefined)}>{C.unbekannt}</button>}
    </div>
  )
}

function TruppChips({ trupps, value, onChange, other, onOther }: { trupps: readonly TruppHere[]; value: string | null; onChange: (id: string | null) => void; other: string; onOther: (v: string) => void }) {
  const C = appConfig.copy.suche
  return (
    <>
      <div className={s.chips} role="group" aria-label={C.von}>
        {trupps.map((t) => <button key={t.id} type="button" className={s.chip} aria-pressed={value === t.id} onClick={() => onChange(value === t.id ? null : t.id)}>{t.short}</button>)}
        <button type="button" className={s.chip} aria-pressed={value === '' } onClick={() => onChange(value === '' ? null : '')}>{C.andere}</button>
      </div>
      {value === '' && <input className="ip-input" value={other} onChange={(e) => onOther(e.target.value)} aria-label={C.von} autoFocus />}
    </>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className={s.field}><span className={s.label}>{label}</span>{children}</div>
}

function VermisstForm({ floors, floorName, trupps, placed, doc, actions, uebergabe, found, preset, onDone }: SuchePanelProps & { found?: boolean; preset?: FundPreset; onDone: () => void }) {
  const C = appConfig.copy.suche
  const [name, setName] = useState('')
  const [group, setGroup] = useState(false)
  const [count, setCount] = useState(2)
  const [floor, setFloor] = useState<number | undefined>(preset?.floor)
  const [wo, setWo] = useState('')
  const [quelle, setQuelle] = useState('')
  // «+ Gefunden» (somebody found who was never reported): the same form, with Von + weiter an
  const here = truppsOnStorey(doc, floor, trupps, placed)
  const [truppId, setTruppId] = useState<string | null | undefined>(preset?.truppId)
  const chosen = truppId === undefined ? (here[0]?.id ?? null) : truppId
  const [other, setOther] = useState('')
  const [an, setAn] = useState<string | undefined>(undefined)
  const submit = () => {
    const input = { name, count: group ? count : undefined, floor, wo, quelle }
    if (!found) { actions.addPerson(input); onDone(); return }
    const t = chosen ? trupps.find((x) => x.id === chosen) : undefined
    actions.addFound(input, { trupp: t?.label ?? (chosen === '' ? other.trim() || undefined : undefined), truppId: t?.id, floor, wo, an })
    onDone()
  }
  return (
    <Form title={found ? C.addGefunden : C.formVermisst} submit={submit} submitLabel={found ? C.submitGefunden : C.submitVermisst} onCancel={onDone}>
      <Field label={C.wer}>
        <input className="ip-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={C.werPlaceholder} aria-label={C.wer} autoFocus />
        <div className={s.row2}>
          <OnOffWords value={group} onChange={setGroup} off={C.einePerson} on={C.gruppe} label={`${C.einePerson} / ${C.gruppe}`} />
          {group && <Stepper value={count} min={2} max={999} onChange={setCount} ariaLabel={C.anzahl} />}
        </div>
      </Field>
      <Field label={found ? C.wo : C.zuletzt}>
        <StoreyChips floors={floors} floorName={floorName} value={floor} onChange={setFloor} label={found ? C.wo : C.zuletzt} />
        <input className="ip-input" value={wo} onChange={(e) => setWo(e.target.value)} placeholder={C.woPlaceholder} aria-label={C.woGenau} />
      </Field>
      {found ? (
        <>
          <Field label={C.von}>
            <TruppChips trupps={[...here, ...trupps.filter((t) => !here.includes(t))]} value={chosen} onChange={setTruppId} other={other} onOther={setOther} />
          </Field>
          <Field label={C.weiterAn}>
            <AnChips uebergabe={uebergabe} value={an} onChange={setAn} optional />
          </Field>
        </>
      ) : (
        <Field label={C.quelle}>
          <input className="ip-input" value={quelle} onChange={(e) => setQuelle(e.target.value)} placeholder={C.quellePlaceholder} aria-label={C.quelle} />
        </Field>
      )}
    </Form>
  )
}

/** A two-answer choice worded by its answers («Eine Person · Gruppe») — the OnOff pair's control
 *  with words that say what each side IS. */
function OnOffWords({ value, onChange, off, on, label }: { value: boolean; onChange: (v: boolean) => void; off: string; on: string; label: string }) {
  return (
    <div className="useg" role="group" aria-label={label}>
      <button type="button" className={`useg-btn${!value ? ' on' : ''}`} aria-pressed={!value} onClick={() => onChange(false)}>{off}</button>
      <button type="button" className={`useg-btn${value ? ' on' : ''}`} aria-pressed={value} onClick={() => onChange(true)}>{on}</button>
    </div>
  )
}

function AnChips({ uebergabe, value, onChange, optional }: { uebergabe: readonly string[]; value: string | undefined; onChange: (v: string | undefined) => void; optional?: boolean }) {
  const C = appConfig.copy.suche
  return (
    <div className={s.chips} role="group" aria-label={C.an}>
      {uebergabe.map((u) => <button key={u} type="button" className={s.chip} aria-pressed={value === u} onClick={() => onChange(value === u ? undefined : u)}>{u}</button>)}
      {optional && <button type="button" className={s.chip} aria-pressed={value == null} onClick={() => onChange(undefined)}>{C.bleibtVorOrt}</button>}
    </div>
  )
}

function GefundenForm({ v, floors, floorName, trupps, placed, doc, actions, uebergabe, preset, onDone }: SuchePanelProps & { v: PersonView; preset?: FundPreset; onDone: () => void }) {
  const C = appConfig.copy.suche
  // ⚠️ from a Trupp's «Fund melden» the place is the TRUPP's (F7): its storey, or «unbekannt» —
  // never the group's «zuletzt gesehen», which put a find on the wrong floor in two taps
  const [floor, setFloor] = useState<number | undefined>(preset ? preset.floor : v.floor)
  const [wo, setWo] = useState(preset && preset.floor !== v.floor ? '' : (v.wo ?? ''))
  // the Trupp on that storey is pre-selected — the radio report came from somebody who is there
  const here = truppsOnStorey(doc, floor, trupps, placed)
  const [truppId, setTruppId] = useState<string | null | undefined>(preset?.truppId)
  const chosen = truppId === undefined ? (here[0]?.id ?? null) : truppId
  const [other, setOther] = useState('')
  const [an, setAn] = useState<string | undefined>(undefined)
  // …and a Trupp reports what it has in front of it: the count starts at ONE, not at everybody
  const [n, setN] = useState(preset ? 1 : v.count - v.found)
  const submit = () => {
    const t = chosen ? trupps.find((x) => x.id === chosen) : undefined
    actions.gefunden(v.id, { n: v.group ? n : undefined, trupp: t?.label ?? (chosen === '' ? other.trim() || undefined : undefined), truppId: t?.id, floor, wo, an })
    onDone()
  }
  const ordered = [...here, ...trupps.filter((t) => !here.includes(t))]
  return (
    <Form title={fillTemplate(C.formGefunden, { name: v.label })} submit={submit} submitLabel={C.submitGefunden} onCancel={onDone}>
      {v.group && (
        <Field label={C.wieViele}>
          <Stepper value={n} min={1} max={v.count - v.found} onChange={setN} ariaLabel={C.wieViele} />
        </Field>
      )}
      <Field label={C.von}>
        <TruppChips trupps={ordered} value={chosen} onChange={setTruppId} other={other} onOther={setOther} />
      </Field>
      <Field label={`${C.wo}${floor === v.floor && wo === (v.wo ?? '') && (v.floor != null || v.wo) ? ` ${C.woTaken}` : ''}`}>
        <StoreyChips floors={floors} floorName={floorName} value={floor} onChange={setFloor} label={C.wo} />
        <input className="ip-input" value={wo} onChange={(e) => setWo(e.target.value)} placeholder={C.woPlaceholder} aria-label={C.woGenau} />
      </Field>
      <Field label={C.weiterAn}>
        <AnChips uebergabe={uebergabe} value={an} onChange={setAn} optional />
      </Field>
    </Form>
  )
}

function UebergebenForm({ v, actions, uebergabe, onDone }: SuchePanelProps & { v: PersonView; onDone: () => void }) {
  const C = appConfig.copy.suche
  const [an, setAn] = useState<string | undefined>(undefined)
  const [free, setFree] = useState('')
  const [n, setN] = useState(Math.max(1, v.found - v.handed))
  const target = an ?? free.trim()
  return (
    <Form title={fillTemplate(C.formUebergeben, { name: v.label })} submit={() => { actions.uebergeben(v.id, target, v.group ? n : undefined); onDone() }}
      submitLabel={C.submitUebergeben} disabled={!target} onCancel={onDone}>
      {v.group && (
        <Field label={C.wieViele}>
          <Stepper value={n} min={1} max={Math.max(1, v.found - v.handed)} onChange={setN} ariaLabel={C.wieViele} />
        </Field>
      )}
      <Field label={C.an}>
        <AnChips uebergabe={uebergabe} value={an} onChange={(x) => { setAn(x); if (x) setFree('') }} />
        <input className="ip-input" value={free} onChange={(e) => { setFree(e.target.value); setAn(undefined) }} aria-label={C.an} />
      </Field>
    </Form>
  )
}

function TeilenForm({ floor, group, floorName, actions, onDone }: SuchePanelProps & { floor: number; group?: SucheGroup; onDone: () => void }) {
  const C = appConfig.copy.suche
  const have = new Set((group?.units ?? []).filter((u) => !u.storey).map((u) => u.short.toLowerCase()))
  const [picked, setPicked] = useState<string[]>([])
  const [extra, setExtra] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  // the storey's current answer: its own row still counts unless the parts were said to cover it
  const [keepRest, setKeepRest] = useState(() => !group?.hasParts || group.units.some((u) => u.storey))
  const toggle = (n: string) => setPicked((l) => (l.includes(n) ? l.filter((x) => x !== n) : [...l, n]))
  const addDraft = () => {
    const n = draft.trim()
    if (!n) return
    if (!extra.includes(n) && !C.teilenChips.includes(n)) setExtra((l) => [...l, n])
    if (!picked.includes(n)) setPicked((l) => [...l, n])
    setDraft('')
  }
  const all = [...C.teilenChips, ...extra]
  const names = [...picked, ...(draft.trim() && !picked.includes(draft.trim()) ? [draft.trim()] : [])]
  return (
    <Form title={fillTemplate(C.teilenTitle, { floor: floorName(floor) })}
      submit={() => { actions.split(floor, names, keepRest); onDone() }}
      submitLabel={names.length === 1 ? C.teilenSubmitOne : fillTemplate(C.teilenSubmit, { n: names.length })}
      disabled={!names.length} onCancel={onDone}>
      <div className={s.chips}>
        {[...(group?.units ?? []).filter((u) => !u.storey)].map((u) => (
          <span key={u.id} className={`${s.chip} ${s.chipDone}`}>{u.short}<Icon id="check" /></span>
        ))}
        {all.filter((n) => !have.has(n.toLowerCase())).map((n) => (
          <button key={n} type="button" className={s.chip} aria-pressed={picked.includes(n)} onClick={() => toggle(n)}>{n}</button>
        ))}
      </div>
      <div className={s.row2}>
        <input className="ip-input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={C.teilenPlaceholder} aria-label={C.teilenAdd}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDraft() } }} />
        <button type="button" className="ip-btn" onClick={addDraft} disabled={!draft.trim()}><Icon id="plus" />{C.teilenAdd}</button>
      </div>
      <Field label={C.teilenRest}>
        <OnOff value={keepRest} onChange={setKeepRest} ariaLabel={C.teilenRest} />
      </Field>
    </Form>
  )
}

function KorrigierenForm({ v, floors, floorName, actions, onDone }: SuchePanelProps & { v: PersonView; onDone: () => void }) {
  const C = appConfig.copy.suche
  const [name, setName] = useState(v.name ?? '')
  const [group, setGroup] = useState(v.group)
  const [count, setCount] = useState(v.group ? v.count : 2)
  const [floor, setFloor] = useState<number | undefined>(v.floor)
  const [wo, setWo] = useState(v.wo ?? '')
  // where the person was FOUND can be wrong too (walk-through 25.09.2026) — once somebody was found
  const found = v.found > 0
  const [foundFloor, setFoundFloor] = useState<number | undefined>(v.foundFloor)
  const [foundWo, setFoundWo] = useState(v.foundWo ?? '')
  return (
    <Form title={fillTemplate(C.formKorrigieren, { name: v.label })} submitLabel={C.submitKorrigieren} onCancel={onDone}
      submit={() => { actions.korrigieren(v.id, { name, count: group ? count : undefined, floor, wo, ...(found ? { foundFloor, foundWo } : {}) }); onDone() }}>
      <Field label={C.wer}>
        <input className="ip-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={C.werPlaceholder} aria-label={C.wer} />
        <div className={s.row2}>
          <OnOffWords value={group} onChange={setGroup} off={C.einePerson} on={C.gruppe} label={`${C.einePerson} / ${C.gruppe}`} />
          {group && <Stepper value={count} min={2} max={999} onChange={setCount} ariaLabel={C.anzahl} />}
        </div>
      </Field>
      <Field label={C.zuletzt}>
        <StoreyChips floors={floors} floorName={floorName} value={floor} onChange={setFloor} label={C.zuletzt} />
        <input className="ip-input" value={wo} onChange={(e) => setWo(e.target.value)} placeholder={C.woPlaceholder} aria-label={C.woGenau} />
      </Field>
      {found && (
        <Field label={C.korrigierenGefunden}>
          <StoreyChips floors={floors} floorName={floorName} value={foundFloor} onChange={setFoundFloor} label={C.korrigierenGefunden} />
          <input className="ip-input" value={foundWo} onChange={(e) => setFoundWo(e.target.value)} placeholder={C.woPlaceholder} aria-label={`${C.korrigierenGefunden} – ${C.woGenau}`} />
        </Field>
      )}
    </Form>
  )
}

/**
 * «Entwarnen» and «Irrtümlich erfasst» (N7): both END a missing-person record, so neither is one
 * tap any more. A short form asks why and who said so — both optional, chips for the usual
 * answers, free text for the rest — and «Abbrechen» holds the focus, so a stray Enter keeps the
 * person on the list. Both words go into the row (lib/suche · personEntwarnt / personIrrtuemlich).
 */
function WhyForm({ kind, v, actions, onCancel, onDone }: SuchePanelProps & { kind: 'entwarnen' | 'irrtuemlich'; v: PersonView; onCancel: () => void; onDone: () => void }) {
  const C = appConfig.copy.suche
  const [grund, setGrund] = useState('')
  const [quelle, setQuelle] = useState('')
  const gruende = kind === 'entwarnen' ? C.entwarnenGruende : C.irrtuemlichGruende
  const submit = () => {
    const why = { grund, quelle }
    if (kind === 'entwarnen') actions.entwarnen(v.id, why)
    else actions.irrtuemlich(v.id, why)
    onDone()
  }
  return (
    <Form title={fillTemplate(kind === 'entwarnen' ? C.formEntwarnen : C.formIrrtuemlich, { name: v.label })} submit={submit}
      submitLabel={kind === 'entwarnen' ? C.submitEntwarnen : C.submitIrrtuemlich} onCancel={onCancel} focusCancel danger={kind === 'irrtuemlich'}>
      <Field label={C.grund}>
        <div className={s.chips} role="group" aria-label={C.grund}>
          {gruende.map((g) => <button key={g} type="button" className={s.chip} aria-pressed={grund === g} onClick={() => setGrund(grund === g ? '' : g)}>{g}</button>)}
        </div>
        <input className="ip-input" value={grund} onChange={(e) => setGrund(e.target.value)} placeholder={C.grundPlaceholder} aria-label={C.grund} />
      </Field>
      <Field label={C.werSagt}>
        <div className={s.chips} role="group" aria-label={C.werSagt}>
          {C.whyQuellen.map((q) => <button key={q} type="button" className={s.chip} aria-pressed={quelle === q} onClick={() => setQuelle(quelle === q ? '' : q)}>{q}</button>)}
        </div>
        <input className="ip-input" value={quelle} onChange={(e) => setQuelle(e.target.value)} placeholder={C.werSagtPlaceholder} aria-label={C.werSagt} />
      </Field>
    </Form>
  )
}

function RenameForm({ b, actions, onDone }: SuchePanelProps & { b: BereichView; onDone: () => void }) {
  const C = appConfig.copy.suche
  const [name, setName] = useState(b.name ?? '')
  return (
    <Form title={C.umbenennen} submit={() => { actions.rename(b.id, name); onDone() }} submitLabel={C.umbenennenSubmit}
      disabled={!name.trim() || name.trim() === b.name} onCancel={onDone}>
      <Field label={C.bereichName}>
        <input className="ip-input" value={name} onChange={(e) => setName(e.target.value)} aria-label={C.bereichName} autoFocus />
      </Field>
    </Form>
  )
}

function BereichForm({ floors, floorName, actions, onDone }: SuchePanelProps & { onDone: () => void }) {
  const C = appConfig.copy.suche
  const [name, setName] = useState('')
  const [floor, setFloor] = useState<number | undefined>(undefined)
  return (
    <Form title={C.formBereich} submit={() => { actions.addBereich({ name, floor }); onDone() }} submitLabel={C.submitBereich}
      disabled={!name.trim()} onCancel={onDone}>
      <Field label={C.bereichName}>
        <input className="ip-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={C.bereichNamePlaceholder} aria-label={C.bereichName} autoFocus />
      </Field>
      {floors.length > 0 && (
        <Field label={C.geschoss}>
          <StoreyChips floors={floors} floorName={floorName} value={floor} onChange={setFloor} unknown={false} label={C.geschoss} />
        </Field>
      )}
    </Form>
  )
}
