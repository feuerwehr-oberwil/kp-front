// «Karte & Objekte» — the ONE panel: whatever is known about the selected place, in one order
// for an object, a building and a dropped pin (owner, 17.10.2026 · R2; docs/karte-objekte.md ·
// The panel):
//
//   head (kind, name, address, ✕)
//   → the station's own word (Sofortmassnahmen, Bemerkungen, no source line) — read first
//   → Pläne & Module as tiles, two to a line (a tile opens the Einsatz's plan reader, read-only —
//     KartePlans; owner, 27.10.2026 · mocks 2B/2C top)
//   → Gebäude laut Register as BULLETS, the hazards first with ⚠ («Register-Hinweis», source and
//     Stand on every line)
// Every part a top-level section with its head — no card around the first ones, no tabs (owner,
// 27.10.2026: «don't have an inline card but keep everything top level»).
//   → In der Nähe (one list by distance, objects and hydrants, and a sentence saying so)
//   → Objektbesuche, an object's only (rows open the existing read view; a read-only line for
//     other roles). A plain building has none to show – its always-empty line went (owner 20.10.)
//   → the actions LAST: «Objektbesuch» and «Melden» (capture roles only)
//
// The panel ENDS there. The closing «Keine Gefahrenangaben der Station erfasst …» went with
// review round 7 (owner, 20.10.2026: «knowing that there could be something but it isn't filled
// doesn't help anyone in case of an emergency») — where the station wrote nothing, nothing is
// drawn. What IS known still never reads as «no hazard»: a fact the app asked for and did not
// get (the register offline, the register silent) is still said, as a quiet line, not a box;
// only a warning keeps its box.
//
// No «Messen ab hier» (Messen is the bar's) and no «Objektplan auf der Karte» row (the aligned
// plan is switched in Ebenen). Presentational only: the surface (KarteApp) owns the loads and
// passes their states in.
//
// Scrolling is REMEMBERED per selection (owner, 20.10.2026 · s09): a plan or an Objektbesuch
// takes the panel off the screen, and coming back puts «Objektbesuch» back under the thumb
// instead of the head. Another place — the other level, the next object — starts at the top
// (`scrollKey` below).
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
// It carries no plan count (owner, 27.10.2026): the tiles right under it show the plans.
//
// A head whose address is still being looked up is a SKELETON, never «Gebäude» / «…» standing in
// for a name (owner-5): the kicker already says what it is.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
import { RegisterHintBody, RegisterHintButton, RegisterLines, StationNotes } from '../BuildingFacts'
import { ListCard, ListRow } from '../ListRow'
import { LampDot } from './KarteDevice'
import s from './Karte.module.css'

export type PanelSel =
  | { kind: 'object'; obj: StationObject }
  /** `partOf`: the house was reached as one of this object's buildings (its name) */
  | { kind: 'building'; at: LngLat; address: string | null; partOf?: string | null }
  | { kind: 'pin'; at: LngLat; near: { label: string; distanceM: number | null } | null; nearState: 'loading' | 'ok' | 'none' | 'offline'; onBuilding: boolean }

/** What the panel's scroll position is remembered under — the PLACE, so coming back to the same
 *  object restores it and another object starts at the top. */
function scrollKey(sel: PanelSel): string {
  if (sel.kind === 'object') return `o:${sel.obj.id}`
  const at = `${sel.at[0].toFixed(6)},${sel.at[1].toFixed(6)}`
  return sel.kind === 'building' ? `b:${at}` : `p:${at}`
}

// Outside the component on purpose: opening a plan, an Objektbesuch or the Einsatz takes the
// panel off the screen entirely, and the position must survive that (owner, 20.10.2026 · s09).
// Bounded to the last few places — oldest out first, never a session-long log.
const SCROLL_KEEP = 12
const scrollMemory = new Map<string, number>()

function rememberScroll(key: string, top: number): void {
  scrollMemory.delete(key)
  scrollMemory.set(key, top)
  for (const old of scrollMemory.keys()) {
    if (scrollMemory.size <= SCROLL_KEEP) break
    scrollMemory.delete(old)
  }
}

export interface RegisterState {
  state: 'loading' | 'ok' | 'offline' | 'error'
  info: BuildingInfo | null
  /** the answer is the device's copy (offline / the server could not be asked) */
  cached: boolean
}

export interface VisitsState { state: 'loading' | 'ok' | 'error' | 'off'; list: VisitSummary[] }

/** The switch «Objekt | <Haus>»: which level is open, the house's street (null until the register
 *  names it) and the way to the other level. */
export interface PanelLevel { on: 'object' | 'house'; house: string | null; onPick: (to: 'object' | 'house') => void }

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
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const key = scrollKey(sel)
  const restoredFor = useRef<string | null>(null)
  /** the offset still to be restored; 0 once it is (or once the finger moved first) */
  const pending = useRef(0)
  // After EVERY render, not once: the panel's sections arrive one load at a time (the register,
  // In der Nähe, Objektbesuche), and the body can only hold the remembered offset once they have.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (restoredFor.current !== key) {
      restoredFor.current = key
      pending.current = scrollMemory.get(key) ?? 0
      el.scrollTop = 0
    }
    const want = pending.current
    if (want > 0 && el.scrollHeight - el.clientHeight >= want) {
      el.scrollTop = want
      pending.current = 0
    }
  })
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
        <PlanTiles docs={p.docs} onOpenDoc={p.onOpenDoc} avail={p.offline ? p.avail ?? null : undefined} />
        <Register key={o.id} reg={p.register} address={o.address} onRetry={p.onRetryRegister} />
        <Nearby rows={p.nearby} lit={p.litHydrant ?? null} onHydrant={p.onHydrant} onSelectObject={p.onSelectObject} />
        <Visits visits={p.visits} canCapture={p.canCapture} empty={C.visitsNever} onOpenVisit={p.onOpenVisit} offline={p.offline} last={o.lastVisit} />
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
    // no «Kein Stationsobjekt …» box (owner-4): the kicker says «Gebäude» and the line under the
    // head says «Kein Stationsobjekt» once it is known — nothing else is added about what is missing
    body = (
      <>
        <Register key={sel.at.join(',')} reg={p.register} address={null} onRetry={p.onRetryRegister} />
        <Nearby rows={p.nearby} lit={p.litHydrant ?? null} onHydrant={p.onHydrant} onSelectObject={p.onSelectObject} />
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
          <ListCard>
            <ListRow lead={<Icon id="footprint" />} title={C.pinBuilding} sub={C.pinBuildingSub} onClick={p.onPinBuilding} />
          </ListCard>
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
        {/* THE sheet ✕ (docs/ui-conventions · Close: `.ip-x`) — it was a 44px framed IconButton (review round 4); 32px
            here, the panel's rhythm (Karte Haus review round 4 · mock A, Karte.module.css · «one rhythm») */}
        <button type="button" className="ip-x" aria-label={appConfig.copy.closeDialog} title={appConfig.copy.closeDialog} onClick={p.onClose}><Icon id="close" /></button>
      </div>
      <div className={s.body} ref={bodyRef} data-karte-body=""
        onScroll={(e) => {
          const el = e.currentTarget
          // while the body is still growing back to the remembered offset, its own 0 is not a scroll
          if (pending.current > 0 && el.scrollTop <= 0) return
          pending.current = 0
          rememberScroll(key, el.scrollTop)
        }}>{p.level && <LevelSwitch level={p.level} />}{body}</div>
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
 *  Sofortmassnahmen and Bemerkungen, each a section of the sheet — without a source line
 *  («Station · Modul 1»; owner, 27.10.2026: «drop the source»): the panel IS the object. */
function StationWord({ obj }: { obj: StationObject }) {
  const measures = noteLines(obj.measures)
  const remarks = noteLines(obj.remarks)
  if (!measures.length && !remarks.length) return null
  return (
    <div data-section="station">
      <StationNotes measures={measures} remarks={remarks} />
    </div>
  )
}

/** Pläne & Module as tiles, two to a line (owner, 27.10.2026 · mock 2C): each says the plan's
 *  name and nothing else — «Modul 1», «Wasser», «PV» (lib/navRail · planLabel), «Gebäude» for the
 *  stack — behind a document glyph (the floors glyph the Gebäude). Offline, the ●/○ «auf diesem
 *  Gerät» mark trails the name (a tile the device does not hold is dimmed) and the head's legend
 *  says what it means. A tile opens the plan in the Einsatz's reader, read-only (KartePlans).
 *  Not a ListRow: a row spans the card, and two tiles a line is what keeps four plans in the
 *  first screen. */
function PlanTiles({ docs, onOpenDoc, avail }: {
  docs: ViewerPlanDoc[]
  onOpenDoc: (id: string) => void
  /** offline only: what this device holds (null = still asking; undefined = online, no lamps) */
  avail?: ObjectAvailability | null
}) {
  const C = appConfig.copy.karte
  if (!docs.length) return null
  const offline = avail !== undefined
  // the lamp a tile carries offline; a tile is dimmed only once a probe said «not here»
  const lampOf = (plan: ViewerPlanDoc['plan']) => !avail ? null
    : plan ? avail.plans[planKey(plan)] ?? 'online' : avail.gebaeude
  return (
    <div className={s.sec} data-section="plans">
      <div className={s.secHead}>
        <span className={s.eyebrow}>{C.plansTitle}</span>
        {offline && <span className={s.legend}><span className={s.lamp} aria-hidden />{C.onDevice}</span>}
      </div>
      <div className={s.planTiles} role="group" aria-label={C.plansTitle}>
        {docs.map(({ doc, row, plan }) => {
          const lamp = lampOf(plan)
          const off = lamp === 'online'
          return (
            <button key={doc.id} type="button" className={cx(s.planTile, off && s.off)} onClick={() => onOpenDoc(doc.id)}
              aria-label={lamp ? `${row} · ${off ? C.planNotStored : C.device.lampWord[lamp]}` : undefined}>
              <Icon id={plan ? 'doc' : 'floors'} />
              <span className={s.planTileText}>{row}</span>
              {lamp ? <LampDot lamp={lamp} /> : <Icon id="chevron" className={s.chev} />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Gebäude laut Register, as bullets — the hazards first, each with ⚠ and its word (owner,
 *  27.10.2026: bullet lists instead of tag chips). «Registereintrag …, nicht …» stands right under
 *  them when the register's building is another address's (owner, review round 4). «Register-
 *  Hinweis» is a tap-to-open toggle («tap to open and this blabla (gwr, stand, etc.) should all
 *  be hidden by default») that reveals the hint AND the source line — the registers, their Stand,
 *  the device's copy. Folded again for every place (keyed by the caller). */
function Register({ reg, address, onRetry }: { reg: RegisterState; address: string | null; onRetry: () => void }) {
  const C = appConfig.copy.karte
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
        {chips.length > 0 ? <RegisterLines chips={[...hazards, ...facts]} /> : <div className={s.src}>{C.registerEmpty}</div>}
        {/* the register's entry is ANOTHER building's: said right under the lines, never folded
            (owner, review round 4) — they may be about Grenzweg 7, not this object */}
        {other && <div className={s.src} data-testid="register-other"><b>{other}</b></div>}
      </>
    )
    source = <div className={s.src}>{sources.filter(Boolean).join(' · ')}</div>
  }
  return (
    <div className={s.sec} data-section="register">
      <div className={s.secHead}>
        <span className={s.eyebrow}>{C.registerTitle}</span>
        <RegisterHintButton className={cx(s.hint, s.hintBtn)} open={open} onToggle={() => setOpen((o) => !o)} />
      </div>
      {inner}
      {open && <RegisterHintBody className={s.hintBody} textClassName={s.src}>{source}</RegisterHintBody>}
    </div>
  )
}

/** «Objekt | <Haus>» (Karte Haus round 1 · variant A; no plan count since 27.10.2026): one tap opens the other level,
 *  both ways. The app's own Segmented, one line per half – a long street ends in «…», so the switch
 *  is the same height on both levels and for every name (round 2); its picked half is a neutral
 *  surface pill in the panel's rhythm, not the blue choice fill (review round 4 · Karte.module.css). */
function LevelSwitch({ level }: { level: PanelLevel }) {
  const C = appConfig.copy.karte
  const label = (text: string) => <span className={s.levelText}>{text}</span>
  return (
    <div className={s.level} data-section="level">
      <Segmented ariaLabel={C.level} value={level.on}
        onChange={(to) => { if (level.on !== to) level.onPick(to) }}
        options={[
          { value: 'object', label: label(C.levelObject) },
          { value: 'house', label: label(level.house ?? C.levelHouse), title: level.house ?? C.levelHouse },
        ]} />
    </div>
  )
}

/** In der Nähe: ONE list by distance (lib/karte/places · nearbyPlaces). An object row opens it; a
 *  hydrant row is not a place to open — the mouse over it (or a tap, on touch) shows that hydrant
 *  on the map with its distance (KarteApp). No «Nächster» tag: the order says it (owner 20.10.2026). */
function Nearby({ rows, lit, onHydrant, onSelectObject }: { rows: NearRow[]; lit: string | null; onHydrant?: (id: string, cue: HydrantCue) => void; onSelectObject: (id: string) => void }) {
  const C = appConfig.copy.karte
  return (
    <div className={s.sec} data-section="nearby">
      <div className={s.secHead}><span className={s.eyebrow}>{C.nearTitle}</span></div>
      {rows.length > 0 ? (
        <ListCard>
          {rows.map((r) => r.kind === 'object' ? (
            <ListRow key={r.item.id} lead={<Icon id="footprint" />} title={r.item.name} sub={objectRowSub(r.item, C.kind[r.item.kind])}
              end={fmtDistance(r.distanceM)} onClick={() => onSelectObject(r.item.id)} />
          ) : (
            // a hydrant is not a place to open: no chevron. Hover is the mouse's only (a finger's
            // pointerenter would pin nothing and flash the map)
            <ListRow key={r.item.id} className={cx(s.hydRow, lit === r.item.id && s.lit)} data-hydrant={r.item.id} chevron={false}
              aria-pressed={lit === r.item.id}
              onPointerEnter={(e) => { if (e.pointerType === 'mouse') onHydrant?.(r.item.id, 'enter') }}
              onPointerLeave={(e) => { if (e.pointerType === 'mouse') onHydrant?.(r.item.id, 'leave') }}
              onClick={() => onHydrant?.(r.item.id, 'tap')}
              lead={<Icon id="drop" />}
              title={C.nearHydrant}
              sub={C.compass[r.dir]} end={fmtDistance(r.distanceM)} />
          ))}
        </ListCard>
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
            <ListCard>
              {visits.list.map((v) => {
                const by = typeof v.by === 'string' ? v.by : v.by?.name ?? ''
                const who = v.with?.length ? v.with.join(', ') : by
                const n = v.findings ?? 0
                return (
                  <ListRow key={v.id} lead={<Icon id="clipboard" />} title={v.checklist?.title ?? C.visitNoChecklist}
                    sub={[fmtDay(v.visitedAt), who].filter(Boolean).join(' · ')} onClick={() => onOpenVisit(v.id)}
                    // Objektbesuche's tones for the same states (objectVisits · WorkList): draft ink, defects amber
                    end={v.lifecycle === 'draft' ? <span className="ip-badge ip-badge-arch">{C.visitDraft}</span>
                      : n === 0 ? <span className="ip-badge ip-badge-ok">{C.visitNoDefects}</span>
                        : <span className="ip-badge ip-badge-todo">{n === 1 ? C.visitDefectOne : fillTemplate(C.visitDefects, { n })}</span>} />
                )
              })}
            </ListCard>
          ) : <Quiet>{empty}</Quiet>}
      {!canCapture && <div className={s.src}>{C.visitsReadOnly}</div>}
    </div>
  )
}
