import { useMemo, useState, type ReactNode } from 'react'
import { appConfig } from '../../config/appConfig'
import { fillTemplate, formatTime } from '../../lib/format'
import { Icon } from '../../lib/icons'
import {
  BEREICH_STATUSES, foundWhere, personenViews, personPlace, personWhere, placeKey, sucheOrte, truppAt, truppShort,
  type BereichView, type OrtView, type PersonView, type TruppHere,
} from '../../lib/suche'
import type { SucheActions, SucheTakeBack } from '../../lib/useSucheActions'
import { undoToast } from '../../lib/ui'
import type { SucheBereichStatus, SucheDoc, SuchePoint } from '../../types'
import { Stepper } from '../Stepper'
import s from './Suche.module.css'

/** What the panel shows: the list, or one record / one form in its place. Forms live INSIDE the
 *  card (F5 «ohne das Panel zu verlassen»): there is never a second sheet over the first. */
type View =
  | { kind: 'list' }
  | { kind: 'vermisst'; found?: boolean; preset?: FundPreset }
  | { kind: 'person'; id: string }
  | { kind: 'gefunden'; id: string; preset?: FundPreset }
  | { kind: 'fund'; preset: FundPreset }
  | { kind: 'uebergeben'; id: string }
  | { kind: 'bereich'; id: string }
  | { kind: 'rename'; id: string }
  | { kind: 'addBereich' }
  | { kind: 'korrigieren'; id: string }
  | { kind: 'entwarnen' | 'irrtuemlich'; id: string }

/** «Fund melden» on a Trupp (Tür 3): the Trupp, and the place it is searching now if any */
export interface FundPreset { truppId: string; bereichId?: string }

/**
 * Putting a place on the surface you are on (26.09.2026): the card hands the surface over to a
 * pick — the workspace shows the instruction and its ✕, the card steps aside keeping every word
 * typed — and the tap comes back as a point. `surface` names where the tap will land.
 */
export interface SuchePick {
  surface: 'karte' | 'plan'
  start: (name: string, done: (point: SuchePoint) => void) => void
}

export interface SuchePanelProps {
  doc: SucheDoc
  /** how a step-1 record's storey is named («1. OG») */
  floorName: (floor: number) => string
  /** the places whose Trupp is out and nobody has said yet whether they are abgesucht
   *  (lib/suche · pendingAsks) — the question stands on the place's own row */
  asks?: readonly string[]
  /** the Trupps on the board, as the Suche names them */
  trupps: readonly TruppHere[]
  canEdit: boolean
  actions: SucheActions
  /** open one record straight away (a Verlauf row, a Meldeleiste question) — keyed by `nonce` */
  focus?: { personId?: string; bereichId?: string; fund?: FundPreset; nonce: number } | null
  /** «weiter an» — the station's short list */
  uebergabe: readonly string[]
  /** The panel hosts ONE flow and hands back when it is done (the «Fund melden» sheet over the
   *  Atemschutz board, N17): every «done» and every ‹ calls this instead of showing the list. */
  onExit?: () => void
  /** the confirm-with-undo toast (lib/ui · undoToast) — a prop so a test can hold it */
  onUndoable?: (text: string, takeBack: () => void) => void
  /** «📍 Auf Karte / Plan setzen» — absent where there is no surface to put anything on (the
   *  «Fund melden» sheet over the Tafel, a read-only device) */
  pick?: SuchePick
  /** «📍» on a row: bring a pin into view (the Karte, or its plan) */
  onShow?: (point: SuchePoint) => void
}

const hhmm = (iso?: string) => (iso && Number.isFinite(Date.parse(iso)) ? formatTime(new Date(iso)) : '')

/** The Suche's list and its flows — the same component in the card beside Ebenen and in the
 *  «Fund melden» sheet. */
export function SuchePanel(p: SuchePanelProps) {
  const C = appConfig.copy.suche
  // a jump from outside (a Verlauf row, a Meldeleiste question, «Fund melden») opens its record
  // straight away — the frame remounts the panel per jump (`key` = the focus nonce), so this is
  // its FIRST view rather than an effect that overwrites whatever was open
  const [view, setView] = useState<View>(() => {
    const f = p.focus
    if (f?.fund) return { kind: 'fund', preset: f.fund }
    if (f?.personId && p.doc.personen.some((x) => x.id === f.personId)) return { kind: 'person', id: f.personId }
    if (f?.bereichId && p.doc.bereiche.some((x) => x.id === f.bereichId)) return { kind: 'bereich', id: f.bereichId }
    return { kind: 'list' }
  })
  const orte = useMemo(() => sucheOrte(p.doc, p.floorName), [p.doc, p.floorName])
  const personen = useMemo(() => personenViews(p.doc), [p.doc])
  const bereiche = orte.orte.flatMap((o) => (o.bereich ? [o.bereich] : []))
  const undoable = (r: SucheTakeBack | null, text: string) => { if (r) (p.onUndoable ?? ((t, fn) => { undoToast(t, fn) }))(text, r.takeBack) }

  // hosted as one flow (the «Fund melden» sheet): done is done — the host closes, never the list
  const go = (next: View) => (p.onExit ? p.onExit() : setView(next))
  const back = () => go({ kind: 'list' })
  const person = (id: string) => personen.find((x) => x.id === id)
  const bereich = (id: string) => bereiche.find((u) => u.id === id)
  const placeOf = (v: PersonView) => orte.orte.find((o) => o.personen.some((x) => x.id === v.id))?.bereich

  /** «Gefunden» on a person's line (design «F»): ONE tap, with the Trupp searching that place and
   *  the place itself on the row — and the house toast to take it back. A group gets one («＋1»). */
  const foundNow = (v: PersonView) => {
    const b = placeOf(v)
    const t = truppAt(b)
    const r = p.actions.gefunden(v.id, { n: v.group ? 1 : undefined, bereichId: b?.id, trupp: t?.label, truppId: t?.id })
    undoable(r, v.group ? fillTemplate(C.toastGefundenGroup, { name: v.label }) : fillTemplate(C.toastGefunden, { name: v.label }))
  }
  /** the tick circle: abgesucht, and again back to offen — one row, one toast */
  const tick = (b: BereichView) => {
    const r = p.actions.toggleAbgesucht(b.id)
    undoable(r, fillTemplate(b.status === 'abgesucht' ? C.toastOffen : C.toastAbgesucht, { name: b.label }))
  }

  if (view.kind === 'vermisst') return <VermisstForm {...p} places={bereiche} found={view.found} preset={view.preset} onDone={back} />
  if (view.kind === 'addBereich') return <BereichForm {...p} onDone={back} />
  if ((view.kind === 'entwarnen' || view.kind === 'irrtuemlich') && person(view.id)) {
    return <WhyForm kind={view.kind} v={person(view.id)!} {...p} onCancel={() => setView({ kind: 'person', id: view.id })} onDone={back} />
  }
  if (view.kind === 'korrigieren' && person(view.id)) {
    return <KorrigierenForm v={person(view.id)!} {...p} places={bereiche} onDone={() => setView({ kind: 'person', id: view.id })} />
  }
  if (view.kind === 'gefunden' && person(view.id)) {
    return <GefundenForm v={person(view.id)!} {...p} places={bereiche} here={placeOf(person(view.id)!)} preset={view.preset} onDone={() => go({ kind: 'person', id: view.id })} />
  }
  if (view.kind === 'uebergeben' && person(view.id)) {
    return <UebergebenForm v={person(view.id)!} {...p} onDone={() => setView({ kind: 'person', id: view.id })} />
  }
  if (view.kind === 'rename' && bereich(view.id)) {
    return <RenameForm b={bereich(view.id)!} {...p} places={bereiche} onDone={() => setView({ kind: 'bereich', id: view.id })} />
  }

  let body: ReactNode
  let foot: ReactNode = null
  if (view.kind === 'fund') {
    body = <FundPicker preset={view.preset} personen={personen} {...p} places={bereiche} onBack={back}
      onPerson={(id) => setView({ kind: 'gefunden', id, preset: view.preset })}
      onOther={() => setView({ kind: 'vermisst', found: true, preset: view.preset })} />
  } else if (view.kind === 'person' && person(view.id)) {
    const v = person(view.id)!
    body = <PersonCard v={v} where={personWhere(p.doc, v, p.floorName)} {...p} onBack={back} onFound={() => setView({ kind: 'gefunden', id: view.id })}
      onHand={() => setView({ kind: 'uebergeben', id: view.id })} onFix={() => setView({ kind: 'korrigieren', id: view.id })}
      onWhy={(kind) => setView({ kind, id: view.id })} />
  } else if (view.kind === 'bereich' && bereich(view.id)) {
    body = <BereichCard b={bereich(view.id)!} {...p} onBack={back} onRename={() => setView({ kind: 'rename', id: view.id })} />
  } else {
    const empty = !orte.unbekannt && !orte.orte.length
    body = empty ? (
      <div className={s.empty}>
        <Icon id="search" />
        <strong>{C.emptyTitle}</strong>
        <span>{p.canEdit ? C.emptySub : C.emptySubReadOnly}</span>
      </div>
    ) : (
      <div className={s.list}>
        {orte.unbekannt && <OrtBlock o={orte.unbekannt} unknown {...p} onPerson={(id) => setView({ kind: 'person', id })} onFound={foundNow} />}
        {orte.orte.map((o) => (
          <OrtBlock key={o.key} o={o} {...p} ask={!!o.bereich && !!p.asks?.includes(o.bereich.id)}
            onOpen={o.bereich ? () => setView({ kind: 'bereich', id: o.bereich!.id }) : undefined}
            onTick={o.bereich ? () => tick(o.bereich!) : undefined}
            onPerson={(id) => setView({ kind: 'person', id })} onFound={foundNow} />
        ))}
      </div>
    )
    // ⚠️ Two EQUAL doors (owner, 26.09.2026): the Suche is just as much a sweep with nobody
    // missing as a search for somebody — «＋ Bereich» is never the lesser button.
    foot = p.canEdit ? (
      <>
        <button type="button" className={s.footBtn} onClick={() => setView({ kind: 'vermisst' })}><Icon id="plus" />{C.addVermisst}</button>
        <button type="button" className={s.footBtn} onClick={() => setView({ kind: 'addBereich' })}><Icon id="plus" />{C.addBereich}</button>
      </>
    ) : null
  }

  return (
    <div className={s.panel}>
      <div className={s.scroll}>{body}</div>
      {foot && <div className={s.foot}>{foot}</div>}
      {!p.canEdit && view.kind === 'list' && <div className={s.readOnly}>{C.readOnlyNote}</div>}
    </div>
  )
}

// ── the list ─────────────────────────────────────────────────────────────────────────────────

const PERSON_TONE: Record<PersonView['status'], string> = { vermisst: 'red', gefunden: 'green', uebergeben: 'green', entwarnt: 'grey', irrtuemlich: 'grey' }
// «teilweise» wears its own colour AND a half-filled circle (N14): never the grey of «offen», never
// the full green of «abgesucht»
const BEREICH_TONE: Record<SucheBereichStatus, string> = { offen: 'grey', inArbeit: 'blue', teilweise: 'part', abgesucht: 'green', nichtZugaenglich: 'amber' }

/** «T1 sucht» · «offen» · «abgesucht · T2 · 14:40» — what the place's row says beside its name */
function bereichLine(b: BereichView): string {
  const C = appConfig.copy.suche
  if (b.status === 'inArbeit') return b.trupp ? fillTemplate(C.sucht, { trupp: truppShort(b.trupp) }) : C.bereichStatus.inArbeit
  return [C.bereichStatus[b.status], b.trupp ? truppShort(b.trupp) : '', b.status === 'offen' ? '' : hhmm(b.statusAt)].filter(Boolean).join(' · ')
}

/** «vermisst seit 14:12 · Quelle Hauswart» · «gefunden 14:31 · T2 · an Rettungsdienst» */
function personLine(v: PersonView): string {
  const C = appConfig.copy.suche
  if (v.status === 'vermisst') {
    return [
      v.vermisstAt ? fillTemplate(C.vermisstSeit, { t: hhmm(v.vermisstAt) }) : C.status.vermisst,
      v.found > 0 ? fillTemplate(C.groupFoundShort, { n: v.found }) : '',
      v.quelle ? fillTemplate(C.quelleLine, { quelle: v.quelle }) : '',
    ].filter(Boolean).join(' · ')
  }
  if (v.status === 'entwarnt') return `${C.status.entwarnt} ${hhmm(v.entwarntAt)}`
  if (v.status === 'irrtuemlich') return `${C.status.irrtuemlich} ${hhmm(v.withdrawnAt)}`
  return [fillTemplate(C.gefundenAt, { t: hhmm(v.foundAt) }), v.foundTrupp ? truppShort(v.foundTrupp) : '', v.an ? `${C.an.toLowerCase()} ${v.an}` : ''].filter(Boolean).join(' · ')
}

function OrtBlock({ o, unknown, ask, canEdit, actions, doc, onShow, onOpen, onTick, onPerson, onFound }: SuchePanelProps & {
  o: OrtView; unknown?: boolean; ask?: boolean
  onOpen?: () => void; onTick?: () => void; onPerson: (id: string) => void; onFound: (v: PersonView) => void
}) {
  const C = appConfig.copy.suche
  const b = o.bereich
  const tone = b ? BEREICH_TONE[b.status] : 'grey'
  const head = (
    <>
      <span className={s.ortName}>{o.label}</span>
      {b && <span className={s.ortStatus} data-tone={tone}>{bereichLine(b)}</span>}
      {b?.fund && <span className={s.fund}>{C.fund}</span>}
    </>
  )
  return (
    <section className={s.ort} data-hot={o.hot || undefined} data-quiet={o.quiet || undefined} data-unknown={unknown || undefined} aria-label={o.label}>
      {unknown ? <div className={s.ortLabel}>{o.label}</div> : (
        <div className={s.ortHead}>
          {onOpen
            ? <button type="button" className={s.ortMain} onClick={onOpen}>{head}</button>
            : <div className={s.ortMain}>{head}</div>}
          {b?.point && onShow && <ShowButton name={o.label} onClick={() => onShow(b.point!)} />}
          {b && onTick && (
            // ⚠️ The circle IS the button (design «F»): it looked like one in step 1 and did nothing.
            // A read-only device sees the same circle, inert.
            <button type="button" className={s.tick} data-tone={tone} aria-pressed={b.status === 'abgesucht'} disabled={!canEdit}
              aria-label={fillTemplate(b.status === 'abgesucht' ? C.tickOffen : C.tickAbgesucht, { name: o.label })}
              title={fillTemplate(b.status === 'abgesucht' ? C.tickOffen : C.tickAbgesucht, { name: o.label })}
              onClick={onTick}>
              <span className={s.tickRing} aria-hidden>{b.status === 'abgesucht' && <Icon id="check" />}</span>
            </button>
          )}
        </div>
      )}
      {canEdit && ask && b && <AskRow u={b} actions={actions} />}
      {o.personen.map((v) => (
        <div key={v.id} className={s.person} data-tone={PERSON_TONE[v.status]} data-withdrawn={v.status === 'irrtuemlich' || undefined}>
          <button type="button" className={s.personMain} onClick={() => onPerson(v.id)}>
            <span className={s.personName}>
              {v.label}
              {v.group && <span className={s.count}>{fillTemplate(C.groupOf, { n: v.missing > 0 ? v.missing : v.found, count: v.count })}</span>}
              {(v.status === 'gefunden' || v.status === 'uebergeben') && <Icon id="check" />}
            </span>
            <span className={s.personSub}>{personLine(v)}</span>
          </button>
          {/* a person with a pin of their own (no place) shows it from the line, like a place */}
          {!b && onShow && pointOf(doc, v.id) && <ShowButton name={v.label} onClick={() => onShow(pointOf(doc, v.id)!)} />}
          {canEdit && v.status === 'vermisst' && v.missing > 0 && (
            v.group
              ? <button type="button" className={s.foundBtn} onClick={() => onFound(v)} aria-label={fillTemplate(C.plusOneLabel, { name: v.label })} title={fillTemplate(C.plusOneLabel, { name: v.label })}>{C.plusOne}</button>
              : <button type="button" className={s.foundBtn} onClick={() => onFound(v)} aria-label={fillTemplate(C.toastGefunden, { name: v.label })}>{C.gefundenList}</button>
          )}
        </div>
      ))}
    </section>
  )
}

const pointOf = (doc: SucheDoc, personId: string) => doc.personen.find((p) => p.id === personId)?.point

function ShowButton({ name, onClick }: { name: string; onClick: () => void }) {
  const label = fillTemplate(appConfig.copy.suche.pinShow, { name })
  return <button type="button" className={s.show} onClick={onClick} aria-label={label} title={label}><Icon id="pin" /></button>
}

/**
 * Where a record stands on the surface, on its own card: «Auf Karte setzen» while it stands
 * nowhere; «Zeigen», «Verschieben» (a pick on the surface you are on) and «Position entfernen»
 * once it does — each an ordinary step with its row and its ↶ (lib/suche · setPlacePoint).
 */
function PlaceActions({ kind, id, name, point, pick, onShow, actions }: { kind: 'bereiche' | 'personen'; id: string; name: string; point?: SuchePoint
  pick?: SuchePick; onShow?: (p: SuchePoint) => void; actions: SucheActions }) {
  const C = appConfig.copy.suche
  if (!pick && !point) return null
  const put = () => pick?.start(name, (p) => { actions.setPoint(kind, id, p) })
  return (
    <div className={s.cardActions}>
      {!point && pick && <button type="button" className={s.btn} onClick={put}><Icon id="pin" />{pick.surface === 'plan' ? C.pickPlan : C.pickKarte}</button>}
      {point && onShow && <button type="button" className={s.btn} onClick={() => onShow(point)}><Icon id="pin" />{fillTemplate(C.pinShow, { name })}</button>}
      {point && pick && <button type="button" className={s.btn} onClick={put}>{C.pickMove}</button>}
      {point && <button type="button" className={s.btn} onClick={() => actions.setPoint(kind, id, null)}>{C.pickRemove}</button>}
    </div>
  )
}

/**
 * «Trupp 4 raus – abgesucht? Ja / Teilweise / Nein» — on the place's own row, NOT a dialog: it waits
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

function PersonCard({ v, where, canEdit, doc, floorName, pick, onShow, actions, onBack, onFound, onHand, onFix, onWhy }: SuchePanelProps & { v: PersonView; where: string; onBack: () => void; onFound: () => void; onHand: () => void; onFix: () => void; onWhy: (kind: 'entwarnen' | 'irrtuemlich') => void }) {
  const C = appConfig.copy.suche
  return (
    <div className={s.rec}>
      <CardHead title={v.label} tone={PERSON_TONE[v.status]} onBack={onBack}
        pill={v.group ? fillTemplate(C.groupFound, { found: v.found, count: v.count }) : C.status[v.status]} />
      <p className={s.cardLine}>
        {[fillTemplate(C.zuletztLine, { wo: where || C.unbekannt }), v.quelle ? fillTemplate(C.quelleLine, { quelle: v.quelle }) : '', hhmm(v.vermisstAt)].filter(Boolean).join(' · ')}
      </p>
      {canEdit && (
        <div className={s.cardActions}>
          {v.status === 'vermisst' && <button type="button" className={s.btn} data-primary onClick={onFound}>{C.gefundenBtn}</button>}
          {v.found > v.handed && <button type="button" className={s.btn} onClick={onHand}>{C.uebergebenBtn}</button>}
          {/* ⚠️ «Entwarnen» ends a missing-person record: it asks why and who said so first (N7) */}
          {v.status === 'vermisst' && v.found === 0 && (
            <button type="button" className={s.btn} onClick={() => onWhy('entwarnen')}>{C.entwarnenBtn}</button>
          )}
          {/* a wrong name, count or place is a row (lib/suche · korrigiert), one ↶ away */}
          {v.status !== 'irrtuemlich' && <button type="button" className={s.btn} onClick={onFix}>{C.korrigierenBtn}</button>}
        </div>
      )}
      {/* a person with no place stands on the surface as a pin of their own (a place's pin
          already stands for everybody there) */}
      {canEdit && v.missing > 0 && !personPlace(doc, v, floorName) && (
        <PlaceActions kind="personen" id={v.id} name={v.label} point={pointOf(doc, v.id)} pick={pick} onShow={onShow} actions={actions} />
      )}
      <History rows={v.rows} />
      {/* ⚠️ «Irrtümlich erfasst» stands APART, at the foot of the card — it was the red button right
          beside «Korrigieren …» and withdrew a person in one tap (walk-through 25.09.2026, N7) */}
      {canEdit && v.status !== 'irrtuemlich' && (
        <div className={s.cardFoot}>
          <button type="button" className={s.btn} data-danger onClick={() => onWhy('irrtuemlich')}>{C.irrtuemlichBtn}</button>
        </div>
      )}
    </div>
  )
}

/** A place's own card: its status choices (the list's circle only says «abgesucht»), who searches
 *  it, «Fund», its name, and what happened to it. */
function BereichCard({ b, trupps, canEdit, actions, pick, onShow, onBack, onRename }: SuchePanelProps & { b: BereichView; onBack: () => void; onRename: () => void }) {
  const C = appConfig.copy.suche
  const [pickTrupp, setPickTrupp] = useState(false)
  const set = (st: SucheBereichStatus, t?: TruppHere | null) => {
    actions.setStatus(b.id, st, t ? { label: t.label, id: t.id } : t === null ? { label: undefined } : undefined)
    setPickTrupp(false)
  }
  const pickable = trupps.filter((t) => t.status !== 'raus')
  return (
    <div className={s.rec}>
      <CardHead title={b.label} tone={BEREICH_TONE[b.status]} pill={b.status === 'inArbeit' && b.trupp ? fillTemplate(C.statusInArbeit, { trupp: truppShort(b.trupp) }) : C.bereichStatus[b.status]} onBack={onBack} />
      {canEdit && (
        <>
          <div className={s.label}>{C.statusTitle}</div>
          <div className={s.chips} role="group" aria-label={C.statusTitle}>
            {BEREICH_STATUSES.map((st) => (
              <button key={st} type="button" className={s.chip} data-tone={BEREICH_TONE[st]} aria-pressed={b.status === st}
                onClick={() => (st === 'inArbeit' && pickable.length ? setPickTrupp(true) : set(st))}>
                {st === 'inArbeit' && b.status === 'inArbeit' && b.trupp ? fillTemplate(C.statusInArbeit, { trupp: truppShort(b.trupp) }) : C.bereichStatus[st]}
              </button>
            ))}
            <button type="button" className={s.chip} data-tone="red" aria-pressed={b.fund} disabled={b.fund} onClick={() => actions.fund(b.id)}>{C.fund}</button>
          </div>
          {pickTrupp && (
            <>
              <div className={s.label}>{C.truppPick}</div>
              <div className={s.chips}>
                {pickable.map((t) => <button key={t.id} type="button" className={s.chip} onClick={() => set('inArbeit', t)}>{t.short}</button>)}
                <button type="button" className={s.chip} onClick={() => set('inArbeit', null)}>{C.truppNone}</button>
              </div>
            </>
          )}
          <PlaceActions kind="bereiche" id={b.id} name={b.label} point={b.point} pick={pick} onShow={onShow} actions={actions} />
          {/* a step-1 storey row has no name of its own to change */}
          {b.name && b.floor == null && (
            <div className={s.cardActions}>
              <button type="button" className={s.btn} onClick={onRename}>{C.umbenennen}</button>
            </div>
          )}
        </>
      )}
      {!canEdit && b.point && onShow && (
        <div className={s.cardActions}><button type="button" className={s.btn} onClick={() => onShow(b.point!)}><Icon id="pin" />{fillTemplate(C.pinShow, { name: b.label })}</button></div>
      )}
      {b.rows.length ? <History rows={b.rows} /> : <p className={s.cardLine}>{fillTemplate(C.erfasstAt, { t: hhmm(b.createdAt) })}</p>}
    </div>
  )
}

/** «Fund melden» from a Trupp: who was found — one of the missing, or somebody not on the list */
function FundPicker({ preset, personen, trupps, places, onBack, onPerson, onOther }: SuchePanelProps & { preset: FundPreset; personen: PersonView[]; places: BereichView[]; onBack: () => void; onPerson: (id: string) => void; onOther: () => void }) {
  const C = appConfig.copy.suche
  const t = trupps.find((x) => x.id === preset.truppId)
  const at = places.find((b) => b.id === preset.bereichId)
  const title = fillTemplate(C.fundTitle, { trupp: t?.label ?? '' }) + (at ? ` · ${at.label}` : '')
  const missing = personen.filter((x) => x.status === 'vermisst')
  return (
    <div className={s.rec}>
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
        <button type="button" className={s.footBtn} onClick={onCancel} autoFocus={focusCancel}>{appConfig.copy.suche.cancel}</button>
        <button type="button" className={s.footBtn} data-primary={!danger || undefined} data-danger={danger || undefined} disabled={disabled}
          onClick={() => { if (!disabled) submit() }}>{submitLabel}</button>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className={s.field}><span className={s.label}>{label}{hint && <span className={s.hint}> {hint}</span>}</span>{children}</div>
}

/**
 * The place, as words plus the places already on the list as chips (design «F»): a chip fills the
 * words, so a person and a place — or a find — point at the SAME place instead of two spellings of
 * it. Typing something new makes a new place when the form is sent (lib/suche · ensurePlace).
 */
function PlaceField({ label, hint, value, onChange, places, autoFocus }: { label: string; hint?: string; value: string; onChange: (v: string) => void; places: readonly BereichView[]; autoFocus?: boolean }) {
  const C = appConfig.copy.suche
  const k = placeKey(value)
  return (
    <Field label={label} hint={hint}>
      <input className={s.input} value={value} onChange={(e) => onChange(e.target.value)} placeholder={C.woPlaceholder} aria-label={label} autoFocus={autoFocus} />
      {places.length > 0 && (
        <>
          <span className={s.sublabel}>{C.schonErfasst}</span>
          <div className={s.chips} role="group" aria-label={C.schonErfasst}>
            {places.map((b) => (
              <button key={b.id} type="button" className={s.chip} aria-pressed={k !== '' && placeKey(b.label) === k}
                onClick={() => onChange(placeKey(b.label) === k ? '' : b.label)}>{b.label}</button>
            ))}
          </div>
        </>
      )}
    </Field>
  )
}

/**
 * «📍 Auf Karte / Plan setzen» in a form — optional, and never the only way: a place without a
 * position lives in the list all the same. The form hands the surface over and gets the tap back
 * (`SuchePick`); nothing is written until the form is sent, so its one ↶ takes the pin too.
 */
function PickField({ pick, name, point, onPoint, already }: { pick?: SuchePick; name: string; point?: SuchePoint; onPoint: (p: SuchePoint | undefined) => void
  /** the place chosen already stands somewhere — no second pin is offered */
  already?: boolean }) {
  const C = appConfig.copy.suche
  if (!pick) return null
  if (already) return <div className={s.pickRow}><Icon id="pin" /><span className={s.pickNote}>{C.pickAlready}</span></div>
  return (
    <div className={s.pickRow}>
      {point ? (
        <>
          <button type="button" className={s.chip} aria-pressed onClick={() => pick.start(name, onPoint)}><Icon id="pin" />{C.pickSet}</button>
          <button type="button" className={`${s.chip} ${s.quietChip}`} onClick={() => onPoint(undefined)}>{C.pickClear}</button>
        </>
      ) : (
        <button type="button" className={`${s.chip} ${s.quietChip}`} onClick={() => pick.start(name, onPoint)}><Icon id="pin" />{pick.surface === 'plan' ? C.pickPlan : C.pickKarte}</button>
      )}
    </div>
  )
}

/** «Anzahl» stays OPTIONAL (owner, F-b): one person is the default and asks nothing; «mehrere?»
 *  opens the stepper for a group. */
function CountField({ count, onChange }: { count: number | null; onChange: (n: number | null) => void }) {
  const C = appConfig.copy.suche
  if (count == null) {
    return <button type="button" className={`${s.chip} ${s.quietChip}`} onClick={() => onChange(2)}><Icon id="people" />{C.mehrere}</button>
  }
  return (
    <Field label={C.anzahl}>
      <div className={s.row2}>
        <Stepper value={count} min={2} max={999} onChange={onChange} ariaLabel={C.anzahl} />
        <button type="button" className={`${s.chip} ${s.quietChip}`} onClick={() => onChange(null)}>{C.einePerson}</button>
      </div>
    </Field>
  )
}

function TruppChips({ trupps, value, onChange, other, onOther }: { trupps: readonly TruppHere[]; value: string | null; onChange: (id: string | null) => void; other: string; onOther: (v: string) => void }) {
  const C = appConfig.copy.suche
  return (
    <>
      <div className={s.chips} role="group" aria-label={C.von}>
        {trupps.map((t) => <button key={t.id} type="button" className={s.chip} aria-pressed={value === t.id} onClick={() => onChange(value === t.id ? null : t.id)}>{t.short}</button>)}
        <button type="button" className={s.chip} aria-pressed={value === ''} onClick={() => onChange(value === '' ? null : '')}>{C.andere}</button>
      </div>
      {value === '' && <input className={s.input} value={other} onChange={(e) => onOther(e.target.value)} aria-label={C.von} autoFocus />}
    </>
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

/** «＋ Vermisst» — Wer?, Wo zuletzt gesehen?, and (only when asked for) how many. «Gefunden» for
 *  somebody not on the list (from «Fund melden») is the same form with Von and «weiter an». */
function VermisstForm({ trupps, actions, uebergabe, places, found, preset, pick, onDone }: SuchePanelProps & { places: BereichView[]; found?: boolean; preset?: FundPreset; onDone: () => void }) {
  const C = appConfig.copy.suche
  const [name, setName] = useState('')
  const [count, setCount] = useState<number | null>(null)
  const [wo, setWo] = useState(() => places.find((b) => b.id === preset?.bereichId)?.label ?? '')
  const [quelle, setQuelle] = useState('')
  const [truppId, setTruppId] = useState<string | null>(preset?.truppId ?? null)
  const [other, setOther] = useState('')
  const [an, setAn] = useState<string | undefined>(undefined)
  const [point, setPoint] = useState<SuchePoint | undefined>(undefined)
  const chosen = places.find((b) => placeKey(b.label) === placeKey(wo))
  const submit = () => {
    const input = { name, count: count ?? undefined, wo, quelle, point: chosen?.point ? undefined : point }
    if (!found) { actions.addPerson(input); onDone(); return }
    const t = truppId ? trupps.find((x) => x.id === truppId) : undefined
    actions.addFound(input, { trupp: t?.label ?? (truppId === '' ? other.trim() || undefined : undefined), truppId: t?.id, wo, an })
    onDone()
  }
  return (
    <Form title={found ? C.formGefundenAndere : C.formVermisst} submit={submit} submitLabel={found ? C.submitGefunden : C.submitVermisst} onCancel={onDone}>
      <Field label={C.wer}>
        <input className={s.input} value={name} onChange={(e) => setName(e.target.value)} placeholder={C.werPlaceholder} aria-label={C.wer} autoFocus />
      </Field>
      <PlaceField label={found ? C.wo : C.woZuletzt} hint={found ? undefined : C.woZuletztHint} value={wo} onChange={setWo} places={places} />
      {!found && <PickField pick={pick} name={wo.trim() || name.trim()} point={point} onPoint={setPoint} already={!!chosen?.point} />}
      <CountField count={count} onChange={setCount} />
      {found ? (
        <>
          <Field label={C.von}>
            <TruppChips trupps={trupps} value={truppId} onChange={setTruppId} other={other} onOther={setOther} />
          </Field>
          <Field label={C.weiterAn}>
            <AnChips uebergabe={uebergabe} value={an} onChange={setAn} optional />
          </Field>
        </>
      ) : (
        <Field label={C.quelle}>
          <input className={s.input} value={quelle} onChange={(e) => setQuelle(e.target.value)} placeholder={C.quellePlaceholder} aria-label={C.quelle} />
        </Field>
      )}
    </Form>
  )
}

/** «＋ Bereich» — Wo?, and optionally who searches it, from the Trupps on the board. «noch
 *  niemand» is the default: a place entered is not yet a place anybody was sent to. */
function BereichForm({ trupps, actions, pick, onDone }: SuchePanelProps & { onDone: () => void }) {
  const C = appConfig.copy.suche
  const [name, setName] = useState('')
  const [point, setPoint] = useState<SuchePoint | undefined>(undefined)
  const [truppId, setTruppId] = useState<string | null>(null)
  // a Trupp already out cannot be the one searching now — it would stand there as «raus –
  // abgesucht?» the moment it was picked
  const pickable = trupps.filter((t) => t.status !== 'raus')
  const submit = () => {
    const t = truppId ? pickable.find((x) => x.id === truppId) : undefined
    actions.addBereich({ name, trupp: t ? { label: t.label, id: t.id } : undefined, point })
    onDone()
  }
  return (
    <Form title={C.formBereich} submit={submit} submitLabel={C.submitBereich} disabled={!name.trim()} onCancel={onDone}>
      <Field label={C.bereichWo}>
        <input className={s.input} value={name} onChange={(e) => setName(e.target.value)} placeholder={C.bereichWoPlaceholder} aria-label={C.bereichWo} autoFocus />
      </Field>
      <PickField pick={pick} name={name.trim()} point={point} onPoint={setPoint} />
      <Field label={C.werSucht}>
        <div className={s.chips} role="group" aria-label={C.werSucht}>
          {pickable.map((t) => <button key={t.id} type="button" className={s.chip} aria-pressed={truppId === t.id} onClick={() => setTruppId(truppId === t.id ? null : t.id)}>{t.short}</button>)}
          <button type="button" className={s.chip} aria-pressed={truppId == null} onClick={() => setTruppId(null)}>{C.nochNiemand}</button>
        </div>
      </Field>
    </Form>
  )
}

function GefundenForm({ v, trupps, actions, uebergabe, places, here, preset, onDone }: SuchePanelProps & { v: PersonView; places: BereichView[]; here?: BereichView; preset?: FundPreset; onDone: () => void }) {
  const C = appConfig.copy.suche
  // ⚠️ from a Trupp's «Fund melden» the place is the TRUPP's (F7) — or open, never the person's
  // «zuletzt gesehen», which put a find in the wrong place in two taps
  const start = preset ? places.find((b) => b.id === preset.bereichId) : here
  const [wo, setWo] = useState(start?.label ?? '')
  // the Trupp searching that place is pre-selected — the radio report came from somebody there
  const at = places.find((b) => placeKey(b.label) === placeKey(wo))
  const [truppId, setTruppId] = useState<string | null | undefined>(preset?.truppId)
  const chosen = truppId === undefined ? (truppAt(at)?.id ?? null) : truppId
  const [other, setOther] = useState('')
  const [an, setAn] = useState<string | undefined>(undefined)
  // …and a Trupp reports what it has in front of it: the count starts at ONE, not at everybody
  const [n, setN] = useState(preset ? 1 : v.count - v.found)
  const submit = () => {
    const t = chosen ? trupps.find((x) => x.id === chosen) : undefined
    const hit = at && placeKey(at.label) === placeKey(wo) ? at.id : undefined
    actions.gefunden(v.id, { n: v.group ? n : undefined, trupp: t?.label ?? (chosen === '' ? other.trim() || undefined : undefined), truppId: t?.id, bereichId: hit, wo: hit ? undefined : wo, an })
    onDone()
  }
  return (
    <Form title={fillTemplate(C.formGefunden, { name: v.label })} submit={submit} submitLabel={C.submitGefunden} onCancel={onDone}>
      {v.group && (
        <Field label={C.wieViele}>
          <Stepper value={n} min={1} max={v.count - v.found} onChange={setN} ariaLabel={C.wieViele} />
        </Field>
      )}
      <Field label={C.von}>
        <TruppChips trupps={trupps} value={chosen} onChange={setTruppId} other={other} onOther={setOther} />
      </Field>
      <PlaceField label={C.wo} value={wo} onChange={setWo} places={places} />
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
        <input className={s.input} value={free} onChange={(e) => { setFree(e.target.value); setAn(undefined) }} aria-label={C.an} />
      </Field>
    </Form>
  )
}

function KorrigierenForm({ v, doc, floorName, actions, places, onDone }: SuchePanelProps & { v: PersonView; places: BereichView[]; onDone: () => void }) {
  const C = appConfig.copy.suche
  const [name, setName] = useState(v.name ?? '')
  const [count, setCount] = useState<number | null>(v.group ? v.count : null)
  const [wo, setWo] = useState(() => personWhere(doc, v, floorName))
  // where the person was FOUND can be wrong too (walk-through 25.09.2026) — once somebody was found
  const found = v.found > 0
  const rec = doc.personen.find((x) => x.id === v.id)
  const [foundWo, setFoundWo] = useState(() => (rec ? foundWhere(doc, rec, v, floorName) : ''))
  return (
    <Form title={fillTemplate(C.formKorrigieren, { name: v.label })} submitLabel={C.submitKorrigieren} onCancel={onDone}
      submit={() => { actions.korrigieren(v.id, { name, count: count ?? undefined, wo, ...(found ? { foundWo } : {}) }); onDone() }}>
      <Field label={C.wer}>
        <input className={s.input} value={name} onChange={(e) => setName(e.target.value)} placeholder={C.werPlaceholder} aria-label={C.wer} />
      </Field>
      <CountField count={count} onChange={setCount} />
      <PlaceField label={C.woZuletzt} hint={C.woZuletztHint} value={wo} onChange={setWo} places={places} />
      {found && <PlaceField label={C.korrigierenGefunden} value={foundWo} onChange={setFoundWo} places={places} />}
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
        <input className={s.input} value={grund} onChange={(e) => setGrund(e.target.value)} placeholder={C.grundPlaceholder} aria-label={C.grund} />
      </Field>
      <Field label={C.werSagt}>
        <div className={s.chips} role="group" aria-label={C.werSagt}>
          {C.whyQuellen.map((q) => <button key={q} type="button" className={s.chip} aria-pressed={quelle === q} onClick={() => setQuelle(quelle === q ? '' : q)}>{q}</button>)}
        </div>
        <input className={s.input} value={quelle} onChange={(e) => setQuelle(e.target.value)} placeholder={C.werSagtPlaceholder} aria-label={C.werSagt} />
      </Field>
    </Form>
  )
}

function RenameForm({ b, actions, places, onDone }: SuchePanelProps & { b: BereichView; places: BereichView[]; onDone: () => void }) {
  const C = appConfig.copy.suche
  const [name, setName] = useState(b.name ?? '')
  // two places that read the same would be one place to everybody reading the list
  const clash = places.some((x) => x.id !== b.id && placeKey(x.label) === placeKey(name))
  return (
    <Form title={C.umbenennen} submit={() => { actions.rename(b.id, name); onDone() }} submitLabel={C.umbenennenSubmit}
      disabled={!name.trim() || name.trim() === b.name || clash} onCancel={onDone}>
      <Field label={C.bereichWo} hint={clash ? C.nameTaken : undefined}>
        <input className={s.input} value={name} onChange={(e) => setName(e.target.value)} aria-label={C.bereichWo} autoFocus />
      </Field>
    </Form>
  )
}
