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

import type { ReactNode } from 'react'
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
import { floorLabel } from '../../lib/whiteboard'
import type { VisitSummary } from '../../objectVisits/types'
import type { LngLat } from '../../types'
import { Button, IconButton } from '../Button'
import { PlanGlyph } from '../PlanGlyph'
import { KeyBoxGlyph } from './KeyBoxGlyph'
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
  sheet: boolean
  full: boolean
  withRail: boolean
  onToggleFull: () => void
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
  let head: ReactNode
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
    body = (
      <>
        <Quick canCapture={p.canCapture} word={C.startVisit} primary={false} onMeasure={p.onMeasureHere} onVisit={p.onStartVisit} />
        {(o.lat == null || o.lng == null) && (
          <div className={cx(s.note, s.amber)}><Icon id="warn" /><span><b>{C.approxHead}</b> {C.approxBody}</span></div>
        )}
        <StationWord obj={o} />
        <Plans obj={o} docs={p.docs} georefOn={p.georefOn} georefAvailable={p.georefAvailable} onOpenDoc={p.onOpenDoc} onToggleGeoref={p.onToggleGeoref} />
        {o.kind === 'depot' && !o.plans.length && <div className={s.note}><Icon id="info" /><span>{C.depotNote}</span></div>}
        {o.kind !== 'depot' && <Register reg={p.register} address={o.address} onRetry={p.onRetryRegister} />}
        <Nearby nearby={p.nearby} hydrants={p.hydrants} onSelectObject={p.onSelectObject} />
        <Visits visits={p.visits} canCapture={p.canCapture} empty={C.visitsNever} onOpenVisit={p.onOpenVisit} />
        {!noteLines(o.measures).length && !noteLines(o.remarks).length && <div className={s.src}>{C.missing}</div>}
      </>
    )
  } else if (sel.kind === 'building') {
    const info = p.register.info
    const [street, place] = splitAddress(info?.address ?? sel.address)
    head = (
      <>
        <span className={s.glyph}><Icon id="footprint" /></span>
        <div>
          <div className={s.eyebrow}>{C.building}</div>
          <h2 className={s.title}>{street || (p.register.state === 'loading' ? C.building : C.buildingNoAddress)}</h2>
          <div className={s.sub}>{place || (p.register.state === 'loading' ? C.loadingDots : C.buildingNoObject)}</div>
        </div>
      </>
    )
    body = (
      <>
        <Quick canCapture={p.canCapture} word={C.startReport} primary onMeasure={p.onMeasureHere} onVisit={p.onStartVisit} />
        <div className={s.note}><Icon id="info" /><span>{C.noObjectHere}</span></div>
        <Register reg={p.register} address={null} onRetry={p.onRetryRegister} />
        <Nearby nearby={p.nearby} hydrants={p.hydrants} onSelectObject={p.onSelectObject} />
        <Visits visits={{ state: 'ok', list: [] }} canCapture={p.canCapture} empty={C.visitsNoneHere} onOpenVisit={p.onOpenVisit} />
        <div className={s.src}>{C.missing}</div>
      </>
    )
  } else {
    const title = sel.nearState === 'loading' ? C.loadingDots
      : sel.near ? (sel.near.distanceM != null ? fillTemplate(C.pinNear, { a: sel.near.label, m: Math.round(sel.near.distanceM) }) : fillTemplate(C.pinLabelNear, { a: sel.near.label }))
        : sel.nearState === 'offline' ? C.pinOffline : C.pinNoAddress
    const empty = sel.nearState === 'none' && !sel.onBuilding && !p.nearby.length
    head = (
      <>
        <span className={cx(s.glyph, s.pin)}><Icon id="pin" /></span>
        <div>
          <div className={s.eyebrow}>{C.pin}</div>
          <h2 className={s.title}>{title}</h2>
          <div className={s.coords}>LV95 {fmtLV95(sel.at[0], sel.at[1])}<br />WGS84 {fmtWGS(sel.at[0], sel.at[1])}</div>
        </div>
      </>
    )
    body = (
      <>
        <Quick canCapture={p.canCapture} word={C.startReport} primary onMeasure={p.onMeasureHere} onVisit={p.onStartVisit} />
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
    <section className={cx(s.panel, p.sheet && s.sheet, p.full && s.full, p.withRail && !p.sheet && s.withRail)} aria-label={appConfig.copy.karte.title}>
      {p.sheet && <button type="button" className={s.grab} aria-label={appConfig.copy.closeDialog} aria-expanded={p.full} onClick={p.onToggleFull} />}
      <div className={s.head}>
        {head}
        <IconButton label={appConfig.copy.closeDialog} variant="secondary" onClick={p.onClose}><Icon id="close" /></IconButton>
      </div>
      <div className={s.body}>{body}</div>
    </section>
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

function Plans({ obj, docs, georefOn, georefAvailable, onOpenDoc, onToggleGeoref }: {
  obj: StationObject; docs: ViewerPlanDoc[]; georefOn: boolean; georefAvailable: boolean
  onOpenDoc: (id: string) => void; onToggleGeoref: () => void
}) {
  const C = appConfig.copy.karte
  if (!docs.length) return null
  const floorNames = obj.floors.map((f) => f.name || floorLabel(f.index))
  return (
    <div className={s.sec}>
      <div className={s.secHead}><span className={s.eyebrow}><Icon id="doc" />{C.plansTitle}</span></div>
      <div className={s.list}>
        {docs.map(({ doc, plan }) => plan ? (
          <button key={doc.id} type="button" className={s.row} onClick={() => onOpenDoc(doc.id)}>
            <span className={cx(s.rowLead, s.plan)}><PlanGlyph doc={doc} /></span>
            <span className={s.rowText}>
              <b>{plan.title}</b>
              <span>{[plan.pages == null ? C.planPdf : plan.pages === 1 ? C.planPagesOne : fillTemplate(C.planPages, { n: plan.pages }), plan.georef ? C.planGeoref : ''].filter(Boolean).join(' · ')}</span>
            </span>
            <Icon id="chevron" className={s.chev} />
          </button>
        ) : (
          <button key={doc.id} type="button" className={s.row} onClick={() => onOpenDoc(doc.id)}>
            <span className={s.rowLead}><Icon id="floors" /></span>
            <span className={s.rowText}>
              <b>{C.floorsRow}</b>
              <span>{fillTemplate(floorNames.length === 1 ? C.floorsRowSubOne : C.floorsRowSub, { n: floorNames.length, list: floorNames.join(' · ') })}</span>
            </span>
            <Icon id="chevron" className={s.chev} />
          </button>
        ))}
        {georefAvailable && (
          <button type="button" className={s.row} role="switch" aria-checked={georefOn} onClick={onToggleGeoref}>
            <span className={s.rowLead}><Icon id="layers" /></span>
            <span className={s.rowText}><b>{C.georefRow}</b><span>{C.georefRowSub}</span></span>
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

function Visits({ visits, canCapture, empty, onOpenVisit }: { visits: VisitsState; canCapture: boolean; empty: string; onOpenVisit: (id: string) => void }) {
  const C = appConfig.copy.karte
  if (visits.state === 'off') return null
  return (
    <div className={s.sec}>
      <div className={s.secHead}><span className={s.eyebrow}><Icon id="clipboard" />{C.visitsTitle}</span></div>
      {visits.state === 'loading' ? <div className={s.skeleton} style={{ width: '60%' }} />
        : visits.state === 'error' ? <div className={s.note}><Icon id="info" /><span>{C.visitsUnavailable}</span></div>
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
