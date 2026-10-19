// «Karte & Objekte» — the ONE panel: whatever is known about the selected place, in one order
// for an object, a building and a dropped pin (owner, 17.10.2026 · R2; docs/karte-objekte.md ·
// The panel):
//
//   head (kind, name, address, ✕)
//   → the station's own word (Sofortmassnahmen, Bemerkungen, with their source) — read first
//   → Pläne & Module as rows (a row opens the Einsatz's plan reader, read-only — KartePlans)
//   → Gebäude laut Register («Register-Hinweis», source and Stand on every line)
//   → In der Nähe (one list by distance, objects and hydrants, and a sentence saying so)
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
// After a tap on one of an object's buildings, the switch «Objekt | <the house>» stands right under
// the head (Karte Haus round 1 · variant A, `level`): the whole object, or only the house tapped.
//
// A head whose address is still being looked up is a SKELETON, never «Gebäude» / «…» standing in
// for a name (owner-5): the kicker already says what it is.

import { useState, type ReactNode } from 'react'
import { SheetGrab, useSwipeDismiss } from '../../lib/overlays'
import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import { cx } from '../../lib/cx'
import { fillTemplate } from '../../lib/format'
import { Segmented } from '../Segmented'
import { fmtDistance, fmtLV95, fmtWGS } from '../../lib/geo'
import { buildingChips, buildingSources, fmtDay, noteLines } from '../../lib/buildingCard'
import type { BuildingInfo } from '../../lib/api/building'
import type { StationObject } from '../../lib/api/stationReference'
import type { NearRow } from '../../lib/karte/places'
import { objectHeadSub, objectRowSub, splitAddress, streetKey } from '../../lib/karte/places'
import type { ViewerPlanDoc } from '../../lib/karte/plans'
import { planKey, type ObjectAvailability } from '../../lib/karte/availability'
import type { VisitSummary } from '../../objectVisits/types'
import type { LngLat } from '../../types'
import { Button } from '../Button'
import { RegisterTags, StationNotes } from '../BuildingFacts'
import { LampDot } from './KarteDevice'
import s from './Karte.module.css'

export type PanelSel =
  | { kind: 'object'; obj: StationObject }
  /** `partOf`: the house was reached as one of this object's buildings (its name) */
  | { kind: 'building'; at: LngLat; address: string | null; partOf?: string | null }
  | { kind: 'pin'; at: LngLat; near: { label: string; distanceM: number | null } | null; nearState: 'loading' | 'ok' | 'none' | 'offline'; onBuilding: boolean }

export interface RegisterState {
  state: 'loading' | 'ok' | 'offline' | 'error'
  info: BuildingInfo | null
  /** the answer is the device's copy (offline / the server could not be asked) */
  cached: boolean
}

export interface VisitsState { state: 'loading' | 'ok' | 'error' | 'off'; list: VisitSummary[] }

/** The switch «Objekt | <Haus>»: which level is open, the object's plan count, the house's street
 *  (null until the register names it) and the way to the other level. */
export interface PanelLevel { on: 'object' | 'house'; plans: number; house: string | null; onPick: (to: 'object' | 'house') => void }

/** A hydrant row hovered with the mouse (`enter` / `leave`) or tapped (`tap`, which toggles). */
export type HydrantCue = 'enter' | 'leave' | 'tap'

export function KartePanel(p: {
  sel: PanelSel
  register: RegisterState
  nearby: NearRow[]
  /** the hydrant shown on the map (a row hovered or tapped, or the hydrant under the mouse) */
  litHydrant?: string | null
  onHydrant?: (id: string, cue: HydrantCue) => void
  level?: PanelLevel | null
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
        <Plans docs={p.docs} onOpenDoc={p.onOpenDoc} avail={p.offline ? p.avail ?? null : undefined} />
        <Register key={o.id} reg={p.register} address={o.address} onRetry={p.onRetryRegister} />
        <Nearby rows={p.nearby} lit={p.litHydrant ?? null} onHydrant={p.onHydrant} onSelectObject={p.onSelectObject} />
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
              <div className={s.sub}>{sel.partOf ? fillTemplate(C.partOf, { name: sel.partOf }) : place || C.buildingNoObject}</div>
            </>
          )}
        </div>
      </>
    )
    // no «Kein Stationsobjekt …» box (owner-4): the kicker says «Gebäude», the line under the head
    // says «Kein Stationsobjekt» once it is known, and the closing sentence still says missing ≠ safe
    body = (
      <>
        <Register key={sel.at.join(',')} reg={p.register} address={null} onRetry={p.onRetryRegister} />
        <Nearby rows={p.nearby} lit={p.litHydrant ?? null} onHydrant={p.onHydrant} onSelectObject={p.onSelectObject} />
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
        <Nearby rows={p.nearby} lit={p.litHydrant ?? null} onHydrant={p.onHydrant} onSelectObject={p.onSelectObject} />
        <Actions canCapture={p.canCapture} onReport={p.onReport}
          extra={<Button key="copy" variant="secondary" icon={<Icon id="copy" />} onClick={p.onCopyCoords}>{C.copyCoords}</Button>} />
      </>
    )
  }
  return (
    // ⚠️ `layers-card` on the phone is not a borrowed look but the Ebenen sheet itself: its frame,
    // and the app's rules for an open bottom sheet (15-mobile · the toasts move up out of its way)
    <section className={cx(p.sheet ? cx('layers-card', s.sheet) : s.panel, p.withRail && !p.sheet && s.withRail)} aria-label={appConfig.copy.karte.title}
      data-karte-panel="" data-karte-sheet={p.sheet ? '' : undefined} {...swipe}>
      {p.sheet && <SheetGrab />}
      <div className={s.head}>
        {head}
        {/* THE sheet ✕ (docs/ui-conventions · Close: `.ip-x`, 36px), as Ebenen's — it was a 44px framed IconButton (review round 4) */}
        <button type="button" className="ip-x" aria-label={appConfig.copy.closeDialog} title={appConfig.copy.closeDialog} onClick={p.onClose}><Icon id="close" /></button>
      </div>
      <div className={s.body}>{p.level && <LevelSwitch level={p.level} />}{body}</div>
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
  return <div className={s.quick} data-section="actions">{buttons}</div>
}

/** The station's own word about the object, FIRST (owner R2: in a hurry it matters most):
 *  Sofortmassnahmen and Bemerkungen, each a section of the sheet, then where they come from. */
function StationWord({ obj }: { obj: StationObject }) {
  const C = appConfig.copy.karte
  const measures = noteLines(obj.measures)
  const remarks = noteLines(obj.remarks)
  if (!measures.length && !remarks.length) return null
  return (
    <div data-section="station">
      <StationNotes measures={measures} remarks={remarks}
        source={obj.measuresSource ? fillTemplate(C.notesSource, { src: obj.measuresSource }) : C.notesStation} />
    </div>
  )
}

/** The object's plans as rows (owner, review round 4: «just "modul 1", "modul 2", etc. is enough»):
 *  each row is the module in words and nothing else — no title, no «PDF · 1 Seite», no number badge
 *  (lib/karte/plans · planRowLabel) — and «Gebäude» for the stack. One left edge and one height for
 *  every row; offline, the ●/○ «auf diesem Gerät» mark trails the words (a row the device does not
 *  hold is dimmed). A row opens the plan in the Einsatz's reader, read-only (KartePlans). */
function Plans({ docs, onOpenDoc, avail }: {
  docs: ViewerPlanDoc[]
  onOpenDoc: (id: string) => void
  /** offline only: what this device holds (null = still asking; undefined = online, no lamps) */
  avail?: ObjectAvailability | null
}) {
  const C = appConfig.copy.karte
  if (!docs.length) return null
  const offline = avail !== undefined
  // the lamp a row carries offline; a row is dimmed only once a probe said «not here»
  const lampOf = (plan: ViewerPlanDoc['plan']) => !avail ? null
    : plan ? avail.plans[planKey(plan)] ?? 'online' : avail.gebaeude
  return (
    <div className={s.sec} data-section="plans">
      <div className={s.secHead}>
        <span className={s.eyebrow}>{C.plansTitle}</span>
        {offline && <span className={s.legend}><span className={s.lamp} aria-hidden />{C.onDevice}</span>}
      </div>
      <div className={s.list}>
        {docs.map(({ doc, row, plan }) => {
          const lamp = lampOf(plan)
          const off = lamp === 'online'
          return (
            <button key={doc.id} type="button" className={cx(s.row, s.planRow, off && s.off)} onClick={() => onOpenDoc(doc.id)}
              aria-label={lamp ? `${row} · ${off ? C.planNotStored : C.device.lampWord[lamp]}` : undefined}>
              <span className={s.rowText}><b>{row}</b></span>
              {lamp && <LampDot lamp={lamp} />}
              <Icon id="chevron" className={s.chev} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Gebäude laut Register. The chips stand, and so does «Registereintrag …, nicht …» right under
 *  them when the register's building is another address's (owner, review round 4). «Register-
 *  Hinweis» is a tap-to-open toggle («tap to open and this blabla (gwr, stand, etc.) should all
 *  be hidden by default») that reveals the hint AND the source line — the registers, their Stand,
 *  the device's copy. Folded again for every place (keyed by the caller). */
function Register({ reg, address, onRetry }: { reg: RegisterState; address: string | null; onRetry: () => void }) {
  const C = appConfig.copy.karte
  const B = appConfig.copy.building
  const info = reg.info
  const [open, setOpen] = useState(false)
  let inner: ReactNode
  let source: ReactNode = null
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
        <RegisterTags chips={hazards} />
        {facts.length > 0 ? <RegisterTags chips={facts} /> : !hazards.length && <div className={s.src}>{C.registerEmpty}</div>}
        {/* the register's entry is ANOTHER building's: said right under the chips, never folded
            (owner, review round 4) — the chips may be about Grenzweg 7, not this object */}
        {other && <div className={s.src} data-testid="register-other"><b>{other}</b></div>}
      </>
    )
    source = <div className={s.src}>{sources.filter(Boolean).join(' · ')}</div>
  }
  return (
    <div className={s.sec} data-section="register">
      <div className={s.secHead}>
        <span className={s.eyebrow}>{C.registerTitle}</span>
        <button type="button" className={cx(s.hint, s.hintBtn)} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon id="info" />{B.hint}<Icon id="chevron-down" className="chev" />
        </button>
      </div>
      {inner}
      {open && (
        <div className={s.hintBody} data-testid="register-hint">
          <div className={s.src}>{B.hintTitle}</div>
          {source}
        </div>
      )}
    </div>
  )
}

/** «Objekt · 2 Pläne | <Haus>» (Karte Haus round 1 · variant A): one tap opens the other level,
 *  both ways. The app's own Segmented, a CHOICE (blue fill), one line per half – a long street
 *  ends in «…», so the switch is the same height on both levels and for every name (round 2). */
function LevelSwitch({ level }: { level: PanelLevel }) {
  const C = appConfig.copy.karte
  const plans = level.plans === 0 ? C.levelPlansNone : level.plans === 1 ? C.levelPlansOne : fillTemplate(C.levelPlans, { n: level.plans })
  const label = (text: string) => <span className={s.levelText}>{text}</span>
  return (
    <div className={s.level} data-section="level">
      <Segmented ariaLabel={C.level} value={level.on}
        onChange={(to) => { if (level.on !== to) level.onPick(to) }}
        options={[
          { value: 'object', label: label(`${C.levelObject} · ${plans}`) },
          { value: 'house', label: label(level.house ?? C.levelHouse), title: level.house ?? C.levelHouse },
        ]} />
    </div>
  )
}

/** In der Nähe: ONE list by distance (lib/karte/places · nearbyPlaces). An object row opens it; a
 *  hydrant row is not a place to open — the mouse over it (or a tap, on touch) shows that hydrant
 *  on the map with its distance (KarteApp), and the nearest one says «Nächster». */
function Nearby({ rows, lit, onHydrant, onSelectObject }: { rows: NearRow[]; lit: string | null; onHydrant?: (id: string, cue: HydrantCue) => void; onSelectObject: (id: string) => void }) {
  const C = appConfig.copy.karte
  return (
    <div className={s.sec} data-section="nearby">
      <div className={s.secHead}><span className={s.eyebrow}>{C.nearTitle}</span></div>
      {rows.length > 0 ? (
        <div className={s.list}>
          {rows.map((r) => r.kind === 'object' ? (
            <button key={r.item.id} type="button" className={s.row} onClick={() => onSelectObject(r.item.id)}>
              <span className={s.rowLead}><Icon id="footprint" /></span>
              <span className={s.rowText}><b>{r.item.name}</b><span>{objectRowSub(r.item, C.kind[r.item.kind])}</span></span>
              <span className={s.rowEnd}>{fmtDistance(r.distanceM)}<Icon id="chevron" className={s.chev} /></span>
            </button>
          ) : (
            // hover is the mouse's only (a finger's pointerenter would pin nothing and flash the map)
            <button key={r.item.id} type="button" className={cx(s.row, s.hydRow, lit === r.item.id && s.lit)} data-hydrant={r.item.id}
              aria-pressed={lit === r.item.id}
              onPointerEnter={(e) => { if (e.pointerType === 'mouse') onHydrant?.(r.item.id, 'enter') }}
              onPointerLeave={(e) => { if (e.pointerType === 'mouse') onHydrant?.(r.item.id, 'leave') }}
              onClick={() => onHydrant?.(r.item.id, 'tap')}>
              <span className={cx(s.rowLead, s.hydrant)}><Icon id="drop" /></span>
              <span className={s.rowText}>
                <b>{r.nearest && <span className={cx('ip-badge', s.nearest)}>{C.nearNearest}</span>}{C.nearHydrant}</b>
                <span>{C.compass[r.dir]}</span>
              </span>
              <span className={s.rowEnd}>{fmtDistance(r.distanceM)}</span>
            </button>
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
                      {/* Objektbesuche's tones for the same states (objectVisits · WorkList): draft ink, defects amber */}
                      {v.lifecycle === 'draft' ? <span className="ip-badge ip-badge-arch">{C.visitDraft}</span>
                        : n === 0 ? <span className="ip-badge ip-badge-ok">{C.visitNoDefects}</span>
                          : <span className="ip-badge ip-badge-todo">{n === 1 ? C.visitDefectOne : fillTemplate(C.visitDefects, { n })}</span>}
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
