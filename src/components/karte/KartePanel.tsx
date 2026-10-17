// «Karte & Objekte» — the ONE panel: whatever is known about the selected place, in one order
// for an object, a building and a dropped pin (owner, 17.10.2026 · R2; docs/karte-objekte.md ·
// The panel):
//
//   head (kind, name, address, ✕)
//   → the station's own word (Sofortmassnahmen, Bemerkungen, with their source) — read first
//   → Pläne & Module as rows (a row opens the Einsatz's plan reader, read-only — KartePlans)
//   → Gebäude laut Register («Register-Hinweis», source and Stand on every line)
//   → In der Nähe (distance only, and a sentence saying so)
//   → Objektbesuche (rows open the existing read view; a read-only line for other roles)
//   → «Keine Gefahrenangaben … heisst nicht …»
//   → the actions LAST: «Objektbesuch» and «Melden» (capture roles only)
//
// No «Messen ab hier» (Messen is the bar's) and no «Objektplan auf der Karte» row (the aligned
// plan is switched in Ebenen). Missing data is SAID, never silently left out, and never as «no
// hazard» — as a quiet line, not a box; only a warning keeps its box. Presentational only: the
// surface (KarteApp) owns the loads and passes their states in.
//
// On a PHONE it is the slide-up sheet Ebenen is (owner, 17.10.2026 · R2: «a full slide-up like
// for "ebenen" and not this half thing»): the SAME frame — `.layers-card` (15-mobile · flush with
// the bottom edge and both sides, over the bar, the hero corner, its height cap), the grab bar
// (`overlays/SheetGrab`) and push-down-to-close (`overlays/useSwipeDismiss`) — one height, the
// whole panel, scrolling. Closing it leaves the place selected on the map (KarteApp). The tablet
// keeps its left panel.
//
// A head whose address is still being looked up is a SKELETON, never «Gebäude» / «…» standing in
// for a name (owner-5): the kicker already says what it is.

import type { ReactNode } from 'react'
import { SheetGrab, useSwipeDismiss } from '../../lib/overlays'
import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import { cx } from '../../lib/cx'
import { fillTemplate } from '../../lib/format'
import { fmtDistance, fmtLV95, fmtWGS } from '../../lib/geo'
import { buildingChips, buildingSources, fmtDay, noteLines } from '../../lib/buildingCard'
import type { BuildingInfo } from '../../lib/api/building'
import type { StationObject } from '../../lib/api/stationReference'
import type { Near, NamedPoint } from '../../lib/karte/places'
import { objectHeadSub, objectRowSub, splitAddress, streetKey } from '../../lib/karte/places'
import type { ViewerPlanDoc } from '../../lib/karte/plans'
import { planKey, type ObjectAvailability } from '../../lib/karte/availability'
import { floorLabel } from '../../lib/whiteboard'
import type { VisitSummary } from '../../objectVisits/types'
import type { LngLat } from '../../types'
import { Button } from '../Button'
import { PlanGlyph } from '../PlanGlyph'
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
  /** no network: the plan rows say what this device holds (● / ○, docs/karte-objekte.md · Offline) */
  offline?: boolean
  /** what this device holds of the selected object's plans; null = not asked yet */
  avail?: ObjectAvailability | null
  /** a phone: the Ebenen sheet's frame instead of the tablet's left panel */
  sheet: boolean
  withRail: boolean
  onClose: () => void
  /** «Objektbesuch»: the visit chooser at this object */
  onStartVisit: () => void
  /** «Melden»: something is wrong or missing here — the station's Fehlermeldung, preselected */
  onReport: () => void
  onOpenDoc: (docId: string) => void
  onSelectObject: (id: string) => void
  onRetryRegister: () => void
  onOpenVisit: (visitId: string) => void
  onPinBuilding: () => void
  onCopyCoords: () => void
}) {
  const C = appConfig.copy.karte
  const { sel } = p
  // the phone sheet goes when it is pushed down, like Ebenen (measured: only ever on a bottom sheet)
  const swipe = useSwipeDismiss({ onClose: p.onClose, enabled: p.sheet })
  let head: ReactNode
  let body: ReactNode
  if (sel.kind === 'object') {
    const o = sel.obj
    head = (
      <>
        <span className={cx(s.glyph, o.kind === 'einsatzobjekt' && s.ein)}><Icon id={o.kind === 'einsatzobjekt' ? 'footprint' : 'station'} /></span>
        <div>
          <div className={s.eyebrow}>{C.kind[o.kind]}</div>
          <h2 className={s.title}>{o.name}</h2>
          {objectHeadSub(o) && <div className={s.sub}>{objectHeadSub(o)}</div>}
        </div>
      </>
    )
    body = (
      <>
        {(o.lat == null || o.lng == null) && (
          <div className={cx(s.note, s.amber)}><Icon id="warn" /><span><b>{C.approxHead}</b> {C.approxBody}</span></div>
        )}
        <StationWord obj={o} />
        <Plans obj={o} docs={p.docs} onOpenDoc={p.onOpenDoc} avail={p.offline ? p.avail ?? null : undefined} />
        <Register reg={p.register} address={o.address} onRetry={p.onRetryRegister} />
        <Nearby nearby={p.nearby} hydrants={p.hydrants} onSelectObject={p.onSelectObject} />
        <Visits visits={p.visits} canCapture={p.canCapture} empty={C.visitsNever} onOpenVisit={p.onOpenVisit} offline={p.offline} last={o.lastVisit} />
        {!noteLines(o.measures).length && !noteLines(o.remarks).length && <div className={s.src}>{C.missing}</div>}
        <Actions canCapture={p.canCapture} onVisit={p.onStartVisit} onReport={p.onReport} />
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
    // no «Kein Stationsobjekt …» box (owner-4): the kicker says «Gebäude», the line under the head
    // says «Kein Stationsobjekt» once it is known, and the closing sentence still says missing ≠ safe
    body = (
      <>
        <Register reg={p.register} address={null} onRetry={p.onRetryRegister} />
        <Nearby nearby={p.nearby} hydrants={p.hydrants} onSelectObject={p.onSelectObject} />
        <Visits visits={{ state: 'ok', list: [] }} canCapture={p.canCapture} empty={C.visitsNoneHere} onOpenVisit={p.onOpenVisit} />
        <div className={s.src}>{C.missing}</div>
        <Actions canCapture={p.canCapture} onReport={p.onReport} />
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
    body = (
      <>
        <Quiet>{empty ? C.pinEmpty : C.pinNote}</Quiet>
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
        <Actions canCapture={p.canCapture} onReport={p.onReport}
          extra={<Button key="copy" variant="secondary" icon={<Icon id="copy" />} onClick={p.onCopyCoords}>{C.copyCoords}</Button>} />
      </>
    )
  }
  return (
    // ⚠️ `layers-card` on the phone is not a borrowed look but the Ebenen sheet itself: its frame,
    // and the app's rules for an open bottom sheet (15-mobile · the toasts move up out of its way)
    <section className={cx(p.sheet ? cx('layers-card', s.sheet) : s.panel, p.withRail && !p.sheet && s.withRail)} aria-label={appConfig.copy.karte.title}
      data-karte-sheet={p.sheet ? '' : undefined} {...swipe}>
      {p.sheet && <SheetGrab />}
      <div className={s.head}>
        {head}
        {/* THE sheet ✕ (docs/ui-conventions · Close: `.ip-x`, 36px), as Ebenen's — it was a 44px framed IconButton (review round 4) */}
        <button type="button" className="ip-x" aria-label={appConfig.copy.closeDialog} title={appConfig.copy.closeDialog} onClick={p.onClose}><Icon id="close" /></button>
      </div>
      <div className={s.body}>{body}</div>
    </section>
  )
}

/** A missing or quiet fact, said in a line of its own — not boxed (owner R2: no boxed notes). */
function Quiet({ children }: { children: ReactNode }) {
  return <p className={s.quietLine}>{children}</p>
}

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

/** The actions, LAST (owner R2: the facts first, what to do about them after): «Objektbesuch»
 *  where there is an object, «Melden» everywhere. A door the role cannot go through is not drawn
 *  (docs/roles-and-access.md) — without `canCapture` only `extra` (the pin's «Koordinaten
 *  kopieren», which writes nothing) is left. */
function Actions({ canCapture, onVisit, onReport, extra }: { canCapture: boolean; onVisit?: () => void; onReport: () => void; extra?: ReactNode }) {
  const C = appConfig.copy.karte
  const buttons = [
    extra,
    canCapture && onVisit && <Button key="visit" variant="secondary" icon={<Icon id="clipboard" />} onClick={onVisit}>{C.startVisit}</Button>,
    canCapture && <Button key="report" variant="secondary" icon={<Icon id="warn" />} onClick={onReport}>{C.startReport}</Button>,
  ].filter(Boolean)
  if (!buttons.length) return null
  return <div className={cx(s.quick, buttons.length === 1 && s.one)} data-section="actions">{buttons}</div>
}

/** The station's own word about the object, FIRST (owner R2: in a hurry it matters most):
 *  Sofortmassnahmen and Bemerkungen, each a section of the sheet, then where they come from. */
function StationWord({ obj }: { obj: StationObject }) {
  const C = appConfig.copy.karte
  const measures = noteLines(obj.measures)
  const remarks = noteLines(obj.remarks)
  if (!measures.length && !remarks.length) return null
  return (
    <div className={s.sec} data-section="station">
      {measures.length > 0 && (
        <>
          <div className={s.secHead}><span className={s.eyebrow}>{C.measures}</span></div>
          <ul className={s.bullets}>{measures.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </>
      )}
      {remarks.length > 0 && (
        <>
          <div className={s.secHead}><span className={s.eyebrow}>{C.remarks}</span></div>
          <ul className={cx(s.bullets, s.quietList)}>{remarks.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </>
      )}
      <div className={s.src}>{obj.measuresSource ? fillTemplate(C.notesSource, { src: obj.measuresSource }) : C.notesStation}</div>
    </div>
  )
}

/** The object's plans as rows — code, the title (lib/karte/plans · planTitle, already on the
 *  document), pages and, offline, what this device holds. A row opens the plan in the Einsatz's
 *  reader, read-only (KartePlans · KarteSurface). */
function Plans({ obj, docs, onOpenDoc, avail }: {
  obj: StationObject; docs: ViewerPlanDoc[]
  onOpenDoc: (id: string) => void
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
  return (
    <div className={s.sec} data-section="plans">
      <div className={s.secHead}>
        <span className={s.eyebrow}>{C.plansTitle}</span>
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
                <b>{doc.title}</b>
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
      ? <Quiet>{C.registerOffline}</Quiet>
      : <><div className={s.note}><Icon id="warn" /><span>{C.registerError}</span></div><Button variant="quiet" className={s.retry} onClick={onRetry}>{C.retry}</Button></>
  } else if (info.registers === 'off') {
    inner = <Quiet>{C.registerOff}</Quiet>
  } else if (info.registers === 'outside_ch' || info.registers === 'no_location') {
    inner = <Quiet>{C.registerOutside}</Quiet>
  } else if (info.gwr_status === 'error' && !info.gwr) {
    inner = <><div className={s.note}><Icon id="warn" /><span>{C.registerError}</span></div><Button variant="quiet" className={s.retry} onClick={onRetry}>{C.retry}</Button></>
  } else if (info.gwr_status === 'none' && !info.plants.length) {
    inner = <Quiet>{C.registerNone}</Quiet>
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
    <div className={s.sec} data-section="register">
      <div className={s.secHead}>
        <span className={s.eyebrow}>{C.registerTitle}</span>
        <span className={s.hint} title={B.hintTitle}><Icon id="info" />{B.hint}</span>
      </div>
      {inner}
    </div>
  )
}

function Nearby({ nearby, hydrants, onSelectObject }: { nearby: Near<StationObject>[]; hydrants: Near<NamedPoint>[]; onSelectObject: (id: string) => void }) {
  const C = appConfig.copy.karte
  return (
    <div className={s.sec} data-section="nearby">
      <div className={s.secHead}><span className={s.eyebrow}>{C.nearTitle}</span></div>
      {nearby.length + hydrants.length > 0 ? (
        <div className={s.list}>
          {nearby.map(({ item: o, distanceM }) => (
            <button key={o.id} type="button" className={s.row} onClick={() => onSelectObject(o.id)}>
              <span className={s.rowLead}><Icon id="footprint" /></span>
              <span className={s.rowText}><b>{o.name}</b><span>{objectRowSub(o, C.kind[o.kind])}</span></span>
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
        <Quiet>{C.nearNone}</Quiet>
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
    <div className={s.sec} data-section="visits">
      <div className={s.secHead}><span className={s.eyebrow}>{C.visitsTitle}</span></div>
      {visits.state === 'loading' ? <div className={s.skeleton} style={{ width: '60%' }} />
        : visits.state === 'error' ? (
          <Quiet>
            {offline ? C.visitsOffline : C.visitsUnavailable}
            {offline && last?.date && <> {fillTemplate(C.visitsLast, { c: last.checklist ?? C.visitNoChecklist, d: fmtDay(last.date) })}</>}
          </Quiet>
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
          ) : <Quiet>{empty}</Quiet>}
      {!canCapture && <div className={s.src}>{C.visitsReadOnly}</div>}
    </div>
  )
}
