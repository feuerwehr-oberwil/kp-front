// «Karte & Objekte» — the ONE panel: whatever is known about the selected place, in one order
// for an object, a building and a dropped pin (docs/karte-objekte.md · The panel):
//
//   quick actions (Messen ab hier · Objektbesuch / Meldung erfassen — capture roles only)
//   → the station's own word (Sofortmassnahmen, Bemerkungen, with their source)
//   → Pläne & Module (+ «Objektplan auf der Karte» for an aligned plan, + Gebäude)
//   → Gebäude laut Register («Register-Hinweis», source and Stand on every line)
//   → In der Nähe (distance only, and a sentence saying so)
//   → Objektbesuche (rows open the existing read view; a read-only line for other roles)
//   → «Keine Gefahrenangaben … heisst nicht …»
//
// Missing data is SAID, never silently left out, and never as «no hazard». Presentational only:
// the surface (KarteApp) owns the loads and passes their states in.
//
// On a PHONE it is one slide-up sheet with two heights (owner, 17.10.2026 · R1): a PEEK — the
// head and the quick actions, nothing else — and FULL, with the object's plans right under the
// actions as menu rows (the bar has no «Pläne» tab any more, so this list IS the way to a plan).
// Drag the grab bar or the head up (or tap either) for full, down for the peek, down again or ✕
// to close: the `.ctx` editors' gesture (components/SheetGrip · useSheetDrag), with the height
// held here as state instead of their DOM class. The tablet keeps its left panel and its order.
//
// A head whose address is still being looked up is a SKELETON, never «Gebäude» / «…» standing in
// for a name (owner-5): the kicker already says what it is.

import type { ReactNode } from 'react'
import { useSheetDrag } from '../SheetGrip'
import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import { cx } from '../../lib/cx'
import { fillTemplate } from '../../lib/format'
import { fmtDistance, fmtLV95, fmtWGS } from '../../lib/geo'
import { buildingChips, buildingSources, fmtDay, noteLines } from '../../lib/buildingCard'
import type { BuildingInfo } from '../../lib/api/building'
import type { StationObject } from '../../lib/api/stationReference'
import type { Near, NamedPoint } from '../../lib/karte/places'
import { splitAddress, streetKey } from '../../lib/karte/places'
import type { ViewerPlanDoc } from '../../lib/karte/plans'
import { planKey, type ObjectAvailability } from '../../lib/karte/availability'
import { floorLabel } from '../../lib/whiteboard'
import type { VisitSummary } from '../../objectVisits/types'
import type { LngLat } from '../../types'
import { Button, IconButton } from '../Button'
import { PlanGlyph } from '../PlanGlyph'
import { KeyBoxGlyph } from './KeyBoxGlyph'
import { LampDot } from './KarteDevice'
import s from './Karte.module.css'

export type PanelSel =
  | { kind: 'object'; obj: StationObject }
  | { kind: 'building'; at: LngLat; address: string | null }
  | { kind: 'pin'; at: LngLat; near: { label: string; distanceM: number | null } | null; nearState: 'loading' | 'ok' | 'none' | 'offline'; onBuilding: boolean }

export interface RegisterState {
  state: 'loading' | 'ok' | 'offline' | 'error'
  info: BuildingInfo | null
  /** the answer is the device's copy (offline / the server could not be asked) */
  cached: boolean
}

export interface VisitsState { state: 'loading' | 'ok' | 'error' | 'off'; list: VisitSummary[] }

export function KartePanel(p: {
  sel: PanelSel
  register: RegisterState
  nearby: Near<StationObject>[]
  hydrants: Near<NamedPoint>[]
  visits: VisitsState
  canCapture: boolean
  docs: ViewerPlanDoc[]
  georefOn: boolean
  georefAvailable: boolean
  /** no network: the plan rows say what this device holds (● / ○, docs/karte-objekte.md · Offline) */
  offline?: boolean
  /** what this device holds of the selected object's plans; null = not asked yet */
  avail?: ObjectAvailability | null
  sheet: boolean
  full: boolean
  withRail: boolean
  /** the phone sheet asks for its full height (true) or its peek (false) */
  onFull: (full: boolean) => void
  onClose: () => void
  onMeasureHere: () => void
  onStartVisit: () => void
  onOpenDoc: (docId: string) => void
  onToggleGeoref: () => void
  onSelectObject: (id: string) => void
  onRetryRegister: () => void
  onOpenVisit: (visitId: string) => void
  onPinBuilding: () => void
  onCopyCoords: () => void
}) {
  const C = appConfig.copy.karte
  const { sel } = p
  // the phone sheet's gesture: the grab bar toggles on a tap, the head opens a peek on a tap
  const grabDrag = useSheetDrag({ onClose: p.onClose, tapToggles: true, sheet: SHEET_SEL, full: p.full, onFull: p.onFull, closeBelow: CLOSE_BELOW })
  const headDrag = useSheetDrag({
    onClose: p.onClose, tapToggles: false, sheet: SHEET_SEL, full: p.full, onFull: p.onFull, closeBelow: CLOSE_BELOW,
    onTap: () => { if (!p.full) p.onFull(true) },
  })
  let head: ReactNode
  let actions: ReactNode
  let body: ReactNode
  if (sel.kind === 'object') {
    const o = sel.obj
    head = (
      <>
        <span className={cx(s.glyph, o.kind === 'einsatzobjekt' && s.ein)}>{o.kind === 'depot' ? <KeyBoxGlyph /> : <Icon id={o.kind === 'einsatzobjekt' ? 'footprint' : 'station'} />}</span>
        <div>
          <div className={s.eyebrow}>{C.kind[o.kind]}</div>
          <h2 className={s.title}>{o.name}</h2>
          {o.address && <div className={s.sub}>{o.address}</div>}
        </div>
      </>
    )
    actions = <Quick canCapture={p.canCapture} word={C.startVisit} primary={false} onMeasure={p.onMeasureHere} onVisit={p.onStartVisit} />
    const plans = (
      <Plans obj={o} docs={p.docs} georefOn={p.georefOn} georefAvailable={p.georefAvailable} onOpenDoc={p.onOpenDoc} onToggleGeoref={p.onToggleGeoref}
        avail={p.offline ? p.avail ?? null : undefined} />
    )
    body = (
      <>
        {(o.lat == null || o.lng == null) && (
          <div className={cx(s.note, s.amber)}><Icon id="warn" /><span><b>{C.approxHead}</b> {C.approxBody}</span></div>
        )}
        {/* the phone sheet: the plans right under the actions — they are its menu (no Pläne tab) */}
        {p.sheet && plans}
        <StationWord obj={o} />
        {!p.sheet && plans}
        {o.kind === 'depot' && !o.plans.length && <div className={s.note}><Icon id="info" /><span>{C.depotNote}</span></div>}
        {o.kind !== 'depot' && <Register reg={p.register} address={o.address} onRetry={p.onRetryRegister} />}
        <Nearby nearby={p.nearby} hydrants={p.hydrants} onSelectObject={p.onSelectObject} />
        <Visits visits={p.visits} canCapture={p.canCapture} empty={C.visitsNever} onOpenVisit={p.onOpenVisit} offline={p.offline} last={o.lastVisit} />
        {!noteLines(o.measures).length && !noteLines(o.remarks).length && <div className={s.src}>{C.missing}</div>}
      </>
    )
  } else if (sel.kind === 'building') {
    const info = p.register.info
    const [street, place] = splitAddress(info?.address ?? sel.address)
    // a tapped building has no address until the register answers: skeleton bars, not a word
    const resolving = !street && p.register.state === 'loading'
    head = (
      <>
        <span className={s.glyph}><Icon id="footprint" /></span>
        <div aria-busy={resolving || undefined}>
          <div className={s.eyebrow}>{C.building}</div>
          {resolving ? <HeadSkeleton sub /> : (
            <>
              <h2 className={s.title}>{street || C.buildingNoAddress}</h2>
              <div className={s.sub}>{place || C.buildingNoObject}</div>
            </>
          )}
        </div>
      </>
    )
    actions = <Quick canCapture={p.canCapture} word={C.startReport} primary onMeasure={p.onMeasureHere} onVisit={p.onStartVisit} />
    // no «Kein Stationsobjekt …» box (owner-4): the kicker says «Gebäude», the line under the head
    // says «Kein Stationsobjekt» once it is known, and the closing sentence still says missing ≠ safe
    body = (
      <>
        <Register reg={p.register} address={null} onRetry={p.onRetryRegister} />
        <Nearby nearby={p.nearby} hydrants={p.hydrants} onSelectObject={p.onSelectObject} />
        <Visits visits={{ state: 'ok', list: [] }} canCapture={p.canCapture} empty={C.visitsNoneHere} onOpenVisit={p.onOpenVisit} />
        <div className={s.src}>{C.missing}</div>
      </>
    )
  } else {
    const title = sel.nearState === 'loading' ? null
      : sel.near ? (sel.near.distanceM != null ? fillTemplate(C.pinNear, { a: sel.near.label, m: Math.round(sel.near.distanceM) }) : fillTemplate(C.pinLabelNear, { a: sel.near.label }))
        : sel.nearState === 'offline' ? C.pinOffline : C.pinNoAddress
    const empty = sel.nearState === 'none' && !sel.onBuilding && !p.nearby.length
    head = (
      <>
        <span className={cx(s.glyph, s.pin)}><Icon id="pin" /></span>
        <div aria-busy={title == null || undefined}>
          <div className={s.eyebrow}>{C.pin}</div>
          {title == null ? <HeadSkeleton /> : <h2 className={s.title}>{title}</h2>}
          <div className={s.coords}>LV95 {fmtLV95(sel.at[0], sel.at[1])}<br />WGS84 {fmtWGS(sel.at[0], sel.at[1])}</div>
        </div>
      </>
    )
    actions = <Quick canCapture={p.canCapture} word={C.startReport} primary onMeasure={p.onMeasureHere} onVisit={p.onStartVisit} />
    body = (
      <>
        <div className={s.note}><Icon id="info" /><span>{empty ? C.pinEmpty : C.pinNote}</span></div>
        {sel.onBuilding && (
          <div className={s.list}>
            <button type="button" className={s.row} onClick={p.onPinBuilding}>
              <span className={s.rowLead}><Icon id="footprint" /></span>
              <span className={s.rowText}><b>{C.pinBuilding}</b><span>{C.pinBuildingSub}</span></span>
              <Icon id="chevron" className={s.chev} />
            </button>
          </div>
        )}
        <Nearby nearby={p.nearby} hydrants={p.hydrants} onSelectObject={p.onSelectObject} />
        <div className={cx(s.quick, s.one)}>
          <Button variant="quiet" icon={<Icon id="copy" />} onClick={p.onCopyCoords}>{C.copyCoords}</Button>
        </div>
      </>
    )
  }
  return (
    <section className={cx(s.panel, p.sheet && s.sheet, p.full && s.full, p.withRail && !p.sheet && s.withRail)} aria-label={appConfig.copy.karte.title}
      data-karte-sheet={p.sheet ? '' : undefined}>
      {p.sheet && <button type="button" className={s.grab} aria-label={appConfig.copy.sheetGrip} aria-expanded={p.full} {...grabDrag} />}
      <div className={s.head} {...(p.sheet ? headDrag : {})}>
        {head}
        <IconButton label={appConfig.copy.closeDialog} variant="secondary" onClick={p.onClose}><Icon id="close" /></IconButton>
      </div>
      {/* the sheet's peek is the head and the actions; the body joins at full height (CSS) */}
      {p.sheet
        ? <><div className={s.actions}>{actions}</div><div className={s.body}>{body}</div></>
        : <div className={s.body}>{actions}{body}</div>}
    </section>
  )
}

/** the root the phone sheet's drag resizes (SheetGrip · useSheetDrag) */
const SHEET_SEL = '[data-karte-sheet]'
/** a full sheet pulled this low closes outright; above it, it settles on its peek */
const CLOSE_BELOW = 0.15

/** The head's name (and address) while they are still being looked up: the register section's
 *  own skeleton bars, sized like the lines they stand for, and the words for a screen reader. */
function HeadSkeleton({ sub = false }: { sub?: boolean }) {
  return (
    <div className={s.headSkeleton} data-testid="karte-head-loading">
      <span className="sr-only">{appConfig.copy.karte.addressLoading}</span>
      <div className={cx(s.skeleton, s.skTitle)} aria-hidden />
      {sub && <div className={cx(s.skeleton, s.skSub)} aria-hidden />}
    </div>
  )
}

function Quick({ canCapture, word, primary, onMeasure, onVisit }: { canCapture: boolean; word: string; primary: boolean; onMeasure: () => void; onVisit: () => void }) {
  const C = appConfig.copy.karte
  return (
    <div className={cx(s.quick, !canCapture && s.one)}>
      <Button variant="quiet" icon={<Icon id="measure" />} onClick={onMeasure}>{C.measureHere}</Button>
      {/* a door the role cannot go through is not drawn (docs/roles-and-access.md) */}
      {canCapture && <Button variant={primary ? 'primary' : 'secondary'} icon={<Icon id="clipboard" />} onClick={onVisit}>{word}</Button>}
    </div>
  )
}

/** The station's own word about the object: Sofortmassnahmen and Bemerkungen with their source,
 *  plus the register's hazard tags at the top — a gas valve is read before anything else. */
function StationWord({ obj }: { obj: StationObject }) {
  const C = appConfig.copy.karte
  const measures = noteLines(obj.measures)
  const remarks = noteLines(obj.remarks)
  if (!measures.length && !remarks.length) return null
  return (
    <div className={s.card}>
      {measures.length > 0 && (
        <>
          <div className={s.cardTitle}>{C.measures}</div>
          <ul className={s.bullets}>{measures.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </>
      )}
      {remarks.length > 0 && (
        <>
          <div className={s.cardTitle}>{C.remarks}</div>
          <ul className={cx(s.bullets, s.quietList)}>{remarks.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </>
      )}
      <div className={s.src}>{obj.measuresSource ? fillTemplate(C.notesSource, { src: obj.measuresSource }) : C.notesStation}</div>
    </div>
  )
}

function Plans({ obj, docs, georefOn, georefAvailable, onOpenDoc, onToggleGeoref, avail }: {
  obj: StationObject; docs: ViewerPlanDoc[]; georefOn: boolean; georefAvailable: boolean
  onOpenDoc: (id: string) => void; onToggleGeoref: () => void
  /** offline only: what this device holds (null = still asking; undefined = online, no lamps) */
  avail?: ObjectAvailability | null
}) {
  const C = appConfig.copy.karte
  if (!docs.length) return null
  const floorNames = obj.floors.map((f) => f.name || floorLabel(f.index))
  const offline = avail !== undefined
  // the lamp a row carries offline; a row is dimmed only once a probe said «not here»
  const lampOf = (plan: ViewerPlanDoc['plan']) => !avail ? null
    : plan ? (avail.plans[planKey(plan)] ? 'device' as const : 'online' as const) : avail.gebaeude
  const word = (l: 'device' | 'part' | 'online') => C.device.lampWord[l]
  const georefOff = !!avail && !avail.georef && !georefOn
  return (
    <div className={s.sec}>
      <div className={s.secHead}>
        <span className={s.eyebrow}><Icon id="doc" />{C.plansTitle}</span>
        {offline && <span className={s.legend}><span className={s.lamp} aria-hidden />{C.onDevice}</span>}
      </div>
      <div className={s.list}>
        {docs.map(({ doc, plan }) => {
          const lamp = lampOf(plan)
          const off = lamp === 'online'
          return plan ? (
            <button key={doc.id} type="button" className={cx(s.row, off && s.off)} onClick={() => onOpenDoc(doc.id)}>
              <span className={cx(s.rowLead, s.plan)}><PlanGlyph doc={doc} /></span>
              <span className={s.rowText}>
                <b>{plan.title}</b>
                <span>{off ? C.planNotStored : [plan.pages == null ? C.planPdf : plan.pages === 1 ? C.planPagesOne : fillTemplate(C.planPages, { n: plan.pages }), plan.georef ? C.planGeoref : ''].filter(Boolean).join(' · ')}</span>
              </span>
              {lamp && <><LampDot lamp={lamp} /><span className="sr-only">{word(lamp)}</span></>}
              <Icon id="chevron" className={s.chev} />
            </button>
          ) : (
            <button key={doc.id} type="button" className={cx(s.row, off && s.off)} onClick={() => onOpenDoc(doc.id)}>
              <span className={s.rowLead}><Icon id="floors" /></span>
              <span className={s.rowText}>
                <b>{C.floorsRow}</b>
                <span>{off ? C.planNotStored : fillTemplate(floorNames.length === 1 ? C.floorsRowSubOne : C.floorsRowSub, { n: floorNames.length, list: floorNames.join(' · ') })}</span>
              </span>
              {lamp && <><LampDot lamp={lamp} /><span className="sr-only">{word(lamp)}</span></>}
              <Icon id="chevron" className={s.chev} />
            </button>
          )
        })}
        {georefAvailable && (
          // offline without the plan on the device it cannot be laid on the map: said, not offered
          // (an overlay already on stays switchable off)
          <button type="button" className={cx(s.row, georefOff && s.off)} role="switch" aria-checked={georefOn} disabled={georefOff} onClick={onToggleGeoref}>
            <span className={s.rowLead}><Icon id="layers" /></span>
            <span className={s.rowText}><b>{C.georefRow}</b><span>{georefOff ? C.georefOffline : C.georefRowSub}</span></span>
            <span className={cx(s.switch, georefOn && s.on)} aria-hidden />
          </button>
        )}
      </div>
    </div>
  )
}

function Register({ reg, address, onRetry }: { reg: RegisterState; address: string | null; onRetry: () => void }) {
  const C = appConfig.copy.karte
  const B = appConfig.copy.building
  const info = reg.info
  let inner: ReactNode
  if (reg.state === 'loading') {
    inner = <><div className={s.skeleton} style={{ width: '70%' }} /><div className={s.skeleton} style={{ width: '45%' }} /></>
  } else if (!info) {
    inner = reg.state === 'offline'
      ? <div className={s.note}><Icon id="info" /><span>{C.registerOffline}</span></div>
      : <><div className={s.note}><Icon id="warn" /><span>{C.registerError}</span></div><Button variant="quiet" className={s.retry} onClick={onRetry}>{C.retry}</Button></>
  } else if (info.registers === 'off') {
    inner = <div className={s.note}><Icon id="info" /><span>{C.registerOff}</span></div>
  } else if (info.registers === 'outside_ch' || info.registers === 'no_location') {
    inner = <div className={s.note}><Icon id="info" /><span>{C.registerOutside}</span></div>
  } else if (info.gwr_status === 'error' && !info.gwr) {
    inner = <><div className={s.note}><Icon id="warn" /><span>{C.registerError}</span></div><Button variant="quiet" className={s.retry} onClick={onRetry}>{C.retry}</Button></>
  } else if (info.gwr_status === 'none' && !info.plants.length) {
    inner = <div className={s.note}><Icon id="info" /><span>{C.registerNone}</span></div>
  } else {
    const chips = buildingChips(info)
    const hazards = chips.filter((c) => c.hazard)
    const facts = chips.filter((c) => !c.hazard)
    const sources = [buildingSources(info)]
    if (reg.cached && info.registers_fetched_at) sources.push(fillTemplate(C.registerCached, { d: fmtDay(info.registers_fetched_at) }))
    // the register's building is not the object's address — say so, never pass it off as the object's
    const other = address && info.address && streetKey(info.address) !== streetKey(address)
      ? fillTemplate(C.registerOther, { a: splitAddress(info.address)[0], b: splitAddress(address)[0] }) : ''
    inner = (
      <>
        {hazards.length > 0 && <ul className={s.tags}>{hazards.map((c) => <li key={c.key} className={cx(s.tag, s.warn)} title={c.title}><Icon id="warn" />{c.text}</li>)}</ul>}
        {facts.length > 0
          ? <ul className={s.tags}>{facts.map((c) => <li key={c.key} className={s.tag} title={c.title}>{c.text}</li>)}</ul>
          : !hazards.length && <div className={s.src}>{C.registerEmpty}</div>}
        <div className={s.src}>{sources.filter(Boolean).join(' · ')}{other && <> · <b>{other}</b></>}</div>
      </>
    )
  }
  return (
    <div className={s.sec}>
      <div className={s.secHead}>
        <span className={s.eyebrow}><Icon id="floors" />{C.registerTitle}</span>
        <span className={s.hint} title={B.hintTitle}><Icon id="info" />{B.hint}</span>
      </div>
      {inner}
    </div>
  )
}

function Nearby({ nearby, hydrants, onSelectObject }: { nearby: Near<StationObject>[]; hydrants: Near<NamedPoint>[]; onSelectObject: (id: string) => void }) {
  const C = appConfig.copy.karte
  return (
    <div className={s.sec}>
      <div className={s.secHead}><span className={s.eyebrow}><Icon id="locate" />{C.nearTitle}</span></div>
      {nearby.length + hydrants.length > 0 ? (
        <div className={s.list}>
          {nearby.map(({ item: o, distanceM }) => (
            <button key={o.id} type="button" className={s.row} onClick={() => onSelectObject(o.id)}>
              <span className={s.rowLead}>{o.kind === 'depot' ? <KeyBoxGlyph /> : <Icon id="footprint" />}</span>
              <span className={s.rowText}><b>{o.name}</b><span>{[C.kind[o.kind], o.address].filter(Boolean).join(' · ')}</span></span>
              <span className={s.rowEnd}>{fmtDistance(distanceM)}<Icon id="chevron" className={s.chev} /></span>
            </button>
          ))}
          {hydrants.map(({ item: h, distanceM }) => (
            <div key={h.id} className={s.row}>
              <span className={cx(s.rowLead, s.hydrant)}><Icon id="drop" /></span>
              <span className={s.rowText}><b>{fillTemplate(C.nearHydrant, { n: h.label })}</b><span>{C.nearHydrantSub}</span></span>
              <span className={s.rowEnd}>{fmtDistance(distanceM)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className={s.note}><Icon id="info" /><span>{C.nearNone}</span></div>
      )}
      <div className={s.src}>{C.nearNote}</div>
    </div>
  )
}

function Visits({ visits, canCapture, empty, onOpenVisit, offline, last }: {
  visits: VisitsState; canCapture: boolean; empty: string; onOpenVisit: (id: string) => void
  /** offline the list cannot be asked: say so, with the catalogue's last visit when it names one */
  offline?: boolean
  last?: StationObject['lastVisit']
}) {
  const C = appConfig.copy.karte
  if (visits.state === 'off') return null
  return (
    <div className={s.sec}>
      <div className={s.secHead}><span className={s.eyebrow}><Icon id="clipboard" />{C.visitsTitle}</span></div>
      {visits.state === 'loading' ? <div className={s.skeleton} style={{ width: '60%' }} />
        : visits.state === 'error' ? (
          <div className={s.note}><Icon id="info" /><span>
            {offline ? C.visitsOffline : C.visitsUnavailable}
            {offline && last?.date && <> {fillTemplate(C.visitsLast, { c: last.checklist ?? C.visitNoChecklist, d: fmtDay(last.date) })}</>}
          </span></div>
        )
          : visits.list.length ? (
            <div className={s.list}>
              {visits.list.map((v) => {
                const by = typeof v.by === 'string' ? v.by : v.by?.name ?? ''
                const who = v.with?.length ? v.with.join(', ') : by
                const n = v.findings ?? 0
                return (
                  <button key={v.id} type="button" className={s.row} onClick={() => onOpenVisit(v.id)}>
                    <span className={s.rowLead}><Icon id="clipboard" /></span>
                    <span className={s.rowText}><b>{v.checklist?.title ?? C.visitNoChecklist}</b><span>{[fmtDay(v.visitedAt), who].filter(Boolean).join(' · ')}</span></span>
                    <span className={s.rowEnd}>
                      {v.lifecycle === 'draft' ? <span className={cx(s.badge, s.ink)}>{C.visitDraft}</span>
                        : n === 0 ? <span className={cx(s.badge, s.green)}><Icon id="check" />{C.visitNoDefects}</span>
                          : <span className={cx(s.badge, s.amber)}>{n === 1 ? C.visitDefectOne : fillTemplate(C.visitDefects, { n })}</span>}
                      <Icon id="chevron" className={s.chev} />
                    </span>
                  </button>
                )
              })}
            </div>
          ) : <div className={s.note}><Icon id="info" /><span>{empty}</span></div>}
      {!canCapture && <div className={s.src}>{C.visitsReadOnly}</div>}
    </div>
  )
}
