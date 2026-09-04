import { useEffect, useMemo, useRef, useState } from 'react'
import { caretToEnd } from '../lib/ui'
import { Icon } from '../lib/icons'
import type { AttendanceState, LngLat, Person, PresenceInterval, Shift, ShiftBand } from '../types'
import { ageMinutes, type LivePerson } from '../lib/usePersonPositions'
import { fmtDistance, haversineM } from '../lib/geo'
import type { ZeitplanSheet } from '../lib/zeitplanPrint'
import { cx } from '../lib/cx'
import { appConfig } from '../config/appConfig'
import { useKeptState } from '../lib/draftKeep'
import { useIsPhone } from '../lib/useIsPhone'
import { useKeyboardInset } from '../lib/useKeyboardInset'
import { fillTemplate, fmtSpanShort, hhmm, stripUnprintable } from '../lib/format'
import { personnelProviderName } from '../lib/deploymentConfig'
import { applyTimeToIso, isoOnDay } from '../lib/abschluss'
import { rankAbbr, rankDisplay, rankOrder } from '../lib/rank'
import { matchesQuery, searchQuery } from '../lib/search'
import { intervalsOf, isPresent } from '../lib/attendanceIntervals'
import { matchesAny, stateMatches, toggled, type StateKey } from '../lib/attendanceFilter'
import { ortCounts, ortOf } from '../lib/attendanceOrt'
import { fmtDayShort, fmtStartValue, incidentDays, isOtherDay } from '../lib/zeitplanFormat'
import { loadPrefs, savePrefs } from '../lib/prefs'
import { CaptureUsageChip, type CaptureUsage } from './CaptureUsageChip'
import { Segmented } from './Segmented'
import { Menu, Overlay, Sheet } from '../lib/overlays'
import { TimeBlockSheet } from './TimeBlockSheet'
import { timeBlockLabels } from '../lib/timeBlockLabels'
import { EmptyState } from './EmptyState'
import { SyncGlyph } from './SyncGlyph'
import { ZeitplanView } from './ZeitplanView'
import { BandGrid } from './BandGrid'
import s from './Anwesenheit.module.css'
import c from './SurfaceControls.module.css'

/** Zeitraum stops for the Zeitplan axis, in hours — from one watch to a WEEK. The long tail
 *  (120 h, 168 h) is for the deployment that does not end on day four: an Elementarereignis
 *  with a Pikett rota runs into a second week, and a plan that cannot show it is planned
 *  somewhere else. */
const HORIZONS = [3, 6, 9, 12, 18, 24, 36, 48, 72, 96, 120, 168]



/** The three readings of this surface. `bands` is the Schichten grid — shift-major over discrete
 *  time, the transpose of the Zeitplan (see BandGrid). It is a TAB and not an entry in the ⋯ menu
 *  on purpose: a whole way of working does not belong behind three dots. */
type AnwesenheitTab = 'list' | 'plan' | 'bands'

/** Which tab was open, remembered in `sessionStorage` and stamped with the incident.
 *
 *  Deliberately not the device cookie it used to be. Coming back to the tab you were working
 *  in matters across a RELOAD mid-incident — that is what the memory is for — but a choice
 *  made last week should not decide where a fresh launch lands, and it should certainly not
 *  follow you into a different Einsatz. sessionStorage dies with the app; the incident stamp
 *  covers switching. Anything else falls back to the crew list, which is what this surface is
 *  for and the only one of the three that is useful before anyone has planned anything. */
const TAB_KEY = 'kp-front-anwesenheit-tab'

function rememberedTab(incidentId: string | undefined): AnwesenheitTab | null {
  if (!incidentId) return null
  try {
    const raw = sessionStorage.getItem(TAB_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { incidentId?: string; view?: AnwesenheitTab }
    return v?.incidentId === incidentId && v.view ? v.view : null
  } catch { return null }
}

// HH:MM of an ISO stamp — the tappable time chip / the <input type="time"> value
function toHM(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : hhmm(d)
}


/** a block's duration for the card head — nothing (not «NaN min») when an end is unparseable */
const spanOrNothing = (ms: number) => (Number.isFinite(ms) ? fmtSpanShort(ms) : undefined)

/**
 * Every recorded block of one person, opened from the row's «+».
 *
 * A single chip on the row can only ever show the LATEST block, which reads as the whole story
 * when somebody has come and gone twice. This lists them all, corrects any of them, and is where
 * a return is opened. Built on the SAME sheet the Zeitplan's Schichten use, so the two stay
 * identical rather than drifting apart.
 */
function PresenceSheet({ person, blocks, note, canEdit, startedAt, onSetTimes, onRemoveBlock, onSetNote, onRemoveGuest, onBack, onClose }: {
  person: Person
  blocks: PresenceInterval[]
  /** free remark on this person for this incident («Fahrer TLF», «abgelöst 21:40») */
  note?: string
  onSetNote?: (personId: string, note: string) => void
  /** take a hand-added person off the sheet entirely — never offered for a roster row */
  onRemoveGuest?: (p: Person) => void
  canEdit: boolean
  /** incident alarm time — drives the day labels and the «ab Beginn» shortcut */
  startedAt?: string | null
  onSetTimes?: (personId: string, patch: { from?: string; to?: string }, index?: number) => void
  /** drop one recorded block — the sheet was the only place it was visible and the only place it
   *  could not be removed, so a mis-tapped «Weiterer Block» was permanent */
  onRemoveBlock?: (personId: string, index: number) => void
  onBack: () => void
  onClose: () => void
}) {
  const A = appConfig.copy.anwesenheit
  const open = blocks.length > 0 && !blocks[blocks.length - 1].to
  // One clock, read once when the sheet opens, for «seit 29 min» on a running stretch. A lazy
  // initialiser rather than a bare Date.now() in the body: reading the wall clock during render is
  // impure and re-runs on every keystroke in a time field. The number then stands still while the
  // sheet is open, which is the right trade — this surface is transient, and a ticking hook here
  // is exactly the shape that once cost the phone its battery.
  const [openedAt] = useState(() => Date.now())
  return (
    <TimeBlockSheet
      title={fillTemplate(A.blocksTitle, { name: person.displayName })}
      subject={person.displayName}
      sectionTitle={A.blocksSection}
      emptyLabel={A.blocksNone}
      note={A.blocksHint}
      // Always offered. While a block is still running, adding one closes it at this moment and
      // opens the next — that is a relief in place, and waiting for the row to be cycled to
      // «gegangen» first made the common case take two surfaces.
      addLabel={canEdit ? (open ? A.addBlock : A.backAgain) : undefined}
      onAdd={canEdit ? onBack : undefined}
      onClose={onClose}
      labels={timeBlockLabels(A.blockRemove)}
      days={incidentDays(startedAt, openedAt)}
      // The remark belongs to the person on THIS Einsatz, not to their roster entry: «Fahrer
      // TLF», «abgelöst 21:40». It sits with the times because that is the one surface that is
      // already about what this person did here, and it prints on the Personalblatt beside them.
      extra={(
        <>
          {canEdit && onSetNote ? (
            <label className="ip-field">
              <span>{A.noteLabel}</span>
              <input
                className="ip-input" defaultValue={note ?? ''} placeholder={A.notePlaceholder}
                // a remark is one line beside the name on the Personalblatt; an essay pasted in
                // here used to make the whole Rapport fail to compose (report_pdf · _clip_note)
                maxLength={240}
                onBlur={(e) => onSetNote(person.id, stripUnprintable(e.target.value))}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            </label>
          ) : note ? (
            <div className="ip-field"><span>{A.noteLabel}</span><b>{note}</b></div>
          ) : null}
          {/* Only for somebody who is not on the Mannschaftsliste. A roster row cannot be
              «removed» — it goes back to frei by tapping — but a hand-added person can be a
              mistake, and then there has to be a way off the sheet. It lives HERE rather than on
              the row, because the row's tap is the one gesture that must never delete anybody. */}
          {canEdit && person.guest && onRemoveGuest && (
            <button type="button" className="ip-btn ip-btn-danger" onClick={() => onRemoveGuest(person)}>
              <Icon id="trash" /> {A.removeGuest}
            </button>
          )}
        </>
      )}

      blocks={blocks.map((iv, i) => ({
        key: String(i),
        from: toHM(iv.from),
        to: iv.to ? toHM(iv.to) : undefined,
        // the day each end sits on — see TimeBlock.fromDay. Latent here today (the wheel only
        // appears once the incident spans more than one day) and wrong the moment it does.
        fromDay: new Date(iv.from),
        toDay: iv.to ? new Date(iv.to) : undefined,
        openLabel: A.stillHere,
        // Same card as the Zeitplan, but the head is a READ-OUT here: a stretch of presence has no
        // second state to flip into — it is running or it is finished, and that is decided by the
        // row in the list, not in this sheet. So no switch, and no «umschalten» on hover.
        head: iv.to
          ? { label: A.ended, tone: 'done' as const }
          : { label: A.running, tone: 'open' as const },
        duration: spanOrNothing((iv.to ? Date.parse(iv.to) : openedAt) - Date.parse(iv.from)),
        // mirror of onTo: a von typed after the bis means the block STARTED the previous day
        onFrom: canEdit && onSetTimes ? (v, day) => { const iso = day ? isoOnDay(day, v) : applyTimeToIso(iv.from, v, { prevDayIfAfter: iv.to }); if (iso) onSetTimes(person.id, { from: iso }, i) } : undefined,
        // ALWAYS, not only on a multi-day Einsatz: the clock alone never says which day, and a
        // recorded time is the half of this surface that ends up on the Rapport.
        dayLabel: fmtDayShort(new Date(iv.from)),
        toDayLabel: iv.to ? fmtDayShort(new Date(iv.to)) : undefined,
        warn: !!iv.to && Date.parse(iv.to) <= Date.parse(iv.from),
        // FIRST block only, and never when it would swallow this block's own end: pulling a
        // LATER block back to the alarm time made it span every earlier block, and totalMinutes
        // simply sums — a 2 h return became 38 h on the Rapport, counting block 1 twice.
        // Offered even when the start ALREADY is the alarm time — the tab then shows as pressed
        // and says so, instead of disappearing at the one moment you might want to return to it.
        // Still the FIRST stretch only: pulling a later one back to the alarm time makes it span
        // every earlier one, and totalMinutes simply sums — a 2 h return once reached the Rapport
        // as 38 h that way.
        onFromStart: canEdit && onSetTimes && startedAt && i === 0
          && (!iv.to || Date.parse(startedAt) < Date.parse(iv.to))
          ? () => onSetTimes(person.id, { from: startedAt }, i) : undefined,
        fromStartValue: startedAt ? fmtStartValue(startedAt, incidentDays(startedAt, openedAt)) : undefined,
        fromIsStart: !!startedAt && iv.from === startedAt,
        // «noch da» on EVERY end, as asked: emptying it says the person never left, and an open
        // stretch runs to the Einsatzende for the Rapport (attendanceIntervals.totalMinutes).
        // ⚠ It is deliberately NOT restricted to the last row any more — see the note in the
        // handover: opening an earlier stretch while a later one exists double-counts those hours.
        onReopen: canEdit && onSetTimes
          ? () => onSetTimes(person.id, { to: undefined }, i) : undefined,
        onRemove: canEdit && onRemoveBlock ? () => onRemoveBlock(person.id, i) : undefined,
        // also offered while the stretch is still OPEN — that is how it gets closed from here.
        // With no end yet, the start is the base the clock is written onto.
        onTo: canEdit && onSetTimes ? (v, day) => { const iso = day ? isoOnDay(day, v) : applyTimeToIso(iv.to ?? iv.from, v, { nextDayIfBefore: iv.from }); if (iso) onSetTimes(person.id, { to: iso }, i) } : undefined,
      }))}
    />
  )
}

/**
 * The chosen sheet, before it goes anywhere.
 *
 * Two menu entries and two ways out would be four entries; this is the fold. The sheet names what
 * it is about to produce — how many people, how many bands, as of when — which is both the
 * confirmation (paper is out of the machine before a toast has faded, and it does not undo) and
 * the sanity check on whether the search + rank filter above are set the way you meant.
 */
function PaperSheet({ sheet, people, bands, printOnline, onPrint, onDownload, onClose }: {
  sheet: ZeitplanSheet
  people: Person[]
  bands: number
  printOnline?: boolean
  onPrint?: () => void
  onDownload?: () => void
  onClose: () => void
}) {
  const Z = appConfig.copy.zeitplan
  const schicht = sheet === 'schichtplan'
  // read once, as the sheet opens: this is «Stand», the moment the sheet was asked for
  const [openedAt] = useState(() => new Date())
  return (
    <Sheet open onClose={onClose} fit title={schicht ? Z.sheetSchichtplanTitle : Z.sheetVerfuegbarkeitenTitle}
      footer={
        <>
          {onDownload && (
            <button type="button" className="ip-btn" onClick={() => { onDownload(); onClose() }}>{Z.pdf}</button>
          )}
          {onPrint && (
            <button type="button" className="ip-btn primary" onClick={() => { onPrint(); onClose() }}>
              <Icon id="printer" />{appConfig.copy.printRelay.send}
              <span className={`dot print-relay-dot${printOnline ? ' online' : ''}`} aria-hidden />
            </button>
          )}
        </>
      }
    >
      <p className={s.paperContent}>
        {schicht
          ? fillTemplate(Z.sheetContentBands, { people: Z.peopleCount(people.length), bands: Z.bandsCount(bands), t: hhmm(openedAt) })
          : fillTemplate(Z.sheetContent, { people: Z.peopleCount(people.length), t: hhmm(openedAt) })}
      </p>
      <p className={s.paperHint}>{schicht ? Z.sheetSchichtplanHint : Z.sheetVerfuegbarkeitenHint}</p>
    </Sheet>
  )
}

/** Record somebody who is not on the Mannschaftsliste. One field: a name is all this needs, and
 *  everything else about them (times, Bemerkung, blocks) is edited on the row afterwards exactly
 *  like anybody else's — which is the point of shaping a guest like a Person. */
function GuestDialog({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (name: string) => void }) {
  const A = appConfig.copy.anwesenheit
  // the typed name survives a jump to another surface and back — see lib/draftKeep. Cleared on
  // submit; NOT cleared on cancel, because «weg» and «ich mache gleich weiter» look identical
  // from here and losing the name is the more expensive of the two mistakes.
  const [name, setName, clearName] = useKeptState('anwesenheit:guest', '')
  const submit = () => { if (name.trim()) { onSubmit(name); clearName() } }
  // ⚠️ `initialFocus`, not `autoFocus` — the Overlay's Dialog already picks its own initial focus
  // on its own schedule (see JournalComposer's caretToEnd note for the same race), so the native
  // `autoFocus` attribute and Base UI's focus management fought over the same input and whichever
  // ran last won: flaky on repeated opens. Handing Base UI the ref settles it deterministically —
  // the same fix TruppFinder/PlanPickers/JournalComposer already use.
  const nameRef = useRef<HTMLInputElement>(null)
  // lifts the sheet clear of the keyboard on phones (see JournalComposer's `kbInset` for the same
  // pattern) — the sheet is bottom-anchored there (15-mobile.css · .ip-sheet), so without this the
  // keyboard covered the one field the dialog exists for.
  const kbInset = useKeyboardInset()
  return (
    <Overlay open onClose={onCancel} className="ip-sheet ip-fit ui-dialog" ariaLabel={A.addGuestTitle}
      initialFocus={nameRef} style={{ marginBottom: kbInset }}>
      <div className="ip-head"><h2>{A.addGuestTitle}</h2>
        <button className="ip-x" onClick={onCancel} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
      </div>
      <div className="ip-body">
        <p className="ip-hint">{A.addGuestHint}</p>
        <label className="ip-field">
          <span>{A.addGuestName}</span>
          <input
            ref={nameRef}
            className="ip-input" onFocus={caretToEnd} value={name} maxLength={80} placeholder={A.addGuestPlaceholder}
            onChange={(e) => setName(stripUnprintable(e.target.value))}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          />
        </label>
      </div>
      <div className="ip-actions">
        <button type="button" className="ip-btn" onClick={onCancel}>{appConfig.copy.mittel.cancel}</button>
        <button type="button" className="ip-btn primary" disabled={!name.trim()} onClick={submit}>{appConfig.copy.mittel.save}</button>
      </div>
    </Overlay>
  )
}

// The Anwesenheit surface: one unified, compact grid of the whole Mannschaft. Each name is a
// button whose tap cycles its state — frei → anwesend → gegangen → frei — so a single view
// both shows and edits attendance with no mode switching (3am tenet: recognition over recall).
// A member in an active Atemschutz-Trupp is locked: tapping jumps to the Trupp instead of
/**
 * Where a person is, next to their name.
 *
 * This is the surface the whole live-position feature exists for: the FU is looking at the
 * crew list and wants to know that the two sent on the Wassertransport really are at the
 * Weiher — and how to reach them if not. So the chip is deliberately **neutral**: distance is
 * information, never a warning. Somebody 3 km out is doing what they were told, and colouring
 * that amber would turn a working picture into an accusation.
 *
 * Renders nothing at all when that person is not sharing — an empty slot says "no data",
 * which is honest, where a dash or a «kein Standort» label would imply something is missing.
 */
function LivePositionChip({ live, center, onShow }: {
  live: LivePerson | undefined
  center?: LngLat
  onShow?: () => void
}) {
  const L = appConfig.copy.livePosition
  if (!live) return null
  const mins = ageMinutes(live.at, Date.now())
  const dist = center ? fmtDistance(haversineM(center, live.coord)) : ''
  // Under the GPS noise floor there is no meaningful distance to state — «12 m» would be a
  // precision the fix does not have. At the Einsatzort is the useful reading anyway.
  const atScene = center ? haversineM(center, live.coord) < 60 : false
  const text = atScene
    ? L.atScene
    : fillTemplate(mins === 0 ? L.chipNow : L.chip, { d: dist, n: String(mins) })
  // Icon ONLY on the row. «63 m · jetzt» is the answer to a question you ask about ONE person,
  // and printed behind every name it became a second column of numbers competing with the name
  // — the thing the list is actually read for. The reading is not lost: it is the tooltip and
  // the accessible name, and tapping still puts the person on the map, which is the real answer.
  const label = `${text}${onShow ? ` · ${L.tapHint}` : ''}`
  return (
    <button
      type="button"
      className={cx(s.livePos, atScene && s.livePosHere)}
      onClick={onShow}
      disabled={!onShow}
      title={label}
      aria-label={label}
    >
      <Icon id="locate" />
    </button>
  )
}

// marking them gone (the checkout rule). Order is stable alphabetical so chips don't reflow
// under your finger while you tap.
export function AnwesenheitView({
  people, attendance, canEdit, loading, error, blockedIds, truppOfPerson,
  onAddGuest, onMarkPresent, onMarkLeft, onClear, onSetOrt, onJumpToTrupp, onReload, onUndo, onRedo, canUndo = false, canRedo = false, onSetTimes, onRemoveBlock, onSetNote, captureUsage,
  shifts, bands, onCreateBand, onSaveBand, onRemoveBand, onCycleCell, onSetCellState, onPutCellState,
  startedAt, onAddShift, onAddShiftSpan, onReplaceShift, onSetShiftTime, onRemoveShift,
  onPrintZeitplan, onDownloadZeitplan, zeitplanPrintOnline,
  livePositions, incidentCenter, onShowOnMap, incidentId,
}: {
  people: Person[]
  attendance: AttendanceState
  canEdit: boolean
  loading: boolean
  error: boolean
  /** person ids assigned to an active Trupp — locked against "Gegangen" until released */
  blockedIds: Set<string>
  /** record somebody who is not on the Mannschaftsliste — see useAttendanceActions · addGuest */
  onAddGuest?: (name: string) => void
  onMarkPresent: (p: Person) => void
  /** flip a present person between Einsatzort and Magazin — «wen könnte ich noch
   *  nachziehen» (see lib/attendanceOrt). Absent for a session that may not write. */
  onSetOrt?: (p: Person) => void
  onMarkLeft: (p: Person) => void
  onClear: (p: Person) => void
  /** the Trupp a locked row belongs to — the jump POINTS at that card, it does not merely
   *  open the Überwachung and leave the finding to whoever tapped */
  truppOfPerson: Map<string, string>
  onJumpToTrupp: (truppId?: string) => void
  onReload: () => void
  /** Take back the last tap on THIS list — the same step the ↶ in the top bar makes.
   *
   * ⚠️ It is offered here for the PHONE only (see the header), and only because the top bar hides
   * its history pair as soon as an Atemschutz-Alarmchip is on it (15-mobile.css: an overdue Trupp
   * outranks two edit buttons at 390px). That is exactly the moment this list is being tapped
   * fastest, so the way back cannot be the thing that disappears. Absent for a session that may
   * not write, and on a tablet, where the top bar keeps the pair. */
  onUndo?: () => void
  onRedo?: () => void
  canUndo?: boolean
  canRedo?: boolean
  /** correct a wrong auto-stamped time via the row's time chip (e.g. "gegangen" marked
   *  after the person already left) — same handler as the Rapport Stunden editor. Patches the
   *  CURRENT presence block; `index` targets an earlier one. */
  onSetTimes?: (personId: string, patch: { from?: string; to?: string }, index?: number) => void
  /** drop one recorded presence block (never the last one — that is what «frei» is for) */
  onRemoveBlock?: (personId: string, index: number) => void
  /** write the free remark on a person's attendance row */
  onSetNote?: (personId: string, note: string) => void
  /** QR self-reporting in use — «QR: N Einträge · zuletzt HH:MM» chip (informational) */
  captureUsage?: CaptureUsage | null
  /** Schichtenplanung — the second view of this same Mannschaft (see ZeitplanView) */
  shifts?: Shift[]
  /** …and the third: the named windows the Schichten grid puts up as columns (see BandGrid) */
  bands?: ShiftBand[]
  onCreateBand?: (label: string, from: string, to: string) => void
  /** rename + re-time in one commit; a re-time asks whether to drag the assigned people along */
  onSaveBand?: (id: string, label: string, from: string, to: string) => void
  onRemoveBand?: (id: string) => void
  /** one cell tap: leer → verfügbar → eingeteilt → leer */
  onCycleCell?: (band: ShiftBand, person: Person) => void
  /** settle a window that holds BOTH states for one person */
  onSetCellState?: (band: ShiftBand, person: Person, state: 'available' | 'confirmed') => void
  /** the right-click menu's explicit setter — like onSetCellState, but also fills an empty cell */
  onPutCellState?: (band: ShiftBand, person: Person, state: 'available' | 'confirmed') => void
  startedAt?: string | null
  onAddShift?: (p: Person) => void
  /** plan exactly the stretch swept out on the grid */
  onAddShiftSpan?: (p: Person, from: number, to: number) => void
  /** a whole shift replaced after a drag */
  onReplaceShift?: (sh: Shift, undoName?: string) => void
  onSetShiftTime?: (id: string, patch: { from?: string; to?: string }) => void
  onRemoveShift?: (id: string, personName: string) => void
  /** print / download one of the two Schichtenplanung sheets (rendered server-side) */
  onPrintZeitplan?: (people: Person[], sheet: ZeitplanSheet) => void
  onDownloadZeitplan?: (people: Person[], sheet: ZeitplanSheet) => void
  zeitplanPrintOnline?: boolean
  /** Self-reported live positions, keyed by person id (see lib/usePersonPositions). Absent for
   *  a session that may not read them — a link-scoped phone gets no crew picture at all. */
  livePositions?: Map<string, LivePerson>
  /** Einsatzort, to measure the distance from */
  incidentCenter?: LngLat
  /** jump to that person's dot on the Lage — the reason the chip is tappable */
  onShowOnMap?: (personId: string) => void
  /** stamps the remembered tab, so switching Einsatz starts on the crew list again */
  incidentId?: string
}) {
  const [q, setQ] = useState('')
  const [rankSel, setRankSel] = useState<ReadonlySet<string>>(() => new Set())
  // Anwesenheit, Zeitplan and Schichten are three readings of the SAME filtered, ordered
  // Mannschaft — the search + rank filter above apply to all of them, so a name sits in the same
  // place whichever one is open.
  const [view, setView] = useState<AnwesenheitTab>(() => rememberedTab(incidentId) ?? 'list')
  const pickView = (v: AnwesenheitTab) => {
    setView(v)
    try { sessionStorage.setItem(TAB_KEY, JSON.stringify({ incidentId, view: v })) } catch { /* private mode */ }
  }
  // one clock for the whole surface: it drives the «jetzt» line and the growing open bar. Only
  // ticks while the Zeitplan is on screen — the attendance list has nothing that moves.
  const [nowMs, setNowMs] = useState(() => Date.now())
  // how many hours of axis fit on screen; a device preference of the moment, not incident data
  const [horizonH, setHorizonH] = useState(() => loadPrefs().zeitplanHorizonH ?? 12)
  const pickHorizon = (h: number) => { setHorizonH(h); savePrefs({ ...loadPrefs(), zeitplanHorizonH: h }) }
  // finer steps than a doubling ladder: the difference between «tonight» and «the next two days»
  // is worth several stops, not two
  const stepHorizon = (dir: 1 | -1) => {
    const i = HORIZONS.indexOf(horizonH)
    pickHorizon(HORIZONS[Math.min(HORIZONS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir))])
  }
  // person whose recorded presence blocks are open in a sheet
  const [blocksFor, setBlocksFor] = useState<string | null>(null)
  // which paper sheet was picked from the printer menu, and is now naming itself before it goes
  const [paper, setPaper] = useState<ZeitplanSheet | null>(null)
  const [addingGuest, setAddingGuest] = useState(false)
  useEffect(() => {
    if (view !== 'plan') return
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [view])
  // «Erneut versuchen» reports on itself, the same way «Jetzt synchronisieren» does
  // (IncidentSwitcher): the ring spins while the roster loads, and on success it closes into a
  // tick — which has to be shown HERE, because success also clears `error` and with it the
  // button's reason to exist. So the button stays for the tick's 2.5s, then leaves. `floorDone`
  // is the same 420ms floor as the sync button: a LAN round trip can settle in ~50ms, and an arc
  // that flicks past reads as a glitch rather than as work done.
  const [reloadPhase, setReloadPhase] = useState<'idle' | 'busy' | 'done'>('idle')
  const [reloadFloorDone, setReloadFloorDone] = useState(true)
  const reloadTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => { reloadTimers.current.forEach(clearTimeout) }, [])
  const runReload = () => {
    if (reloadPhase === 'busy' || loading) return
    setReloadPhase('busy')
    setReloadFloorDone(false)
    reloadTimers.current.push(setTimeout(() => setReloadFloorDone(true), 420))
    onReload()
  }
  useEffect(() => {
    if (reloadPhase !== 'busy' || loading || !reloadFloorDone) return
    // the fetch settled: still failing → back to the retry face; cleared → tick, then leave
    if (error) { setReloadPhase('idle'); return }
    setReloadPhase('done')
    reloadTimers.current.push(setTimeout(() => setReloadPhase('idle'), 2500))
  }, [reloadPhase, loading, reloadFloorDone, error])
  const A = appConfig.copy.anwesenheit
  // …and whether this is a phone, which is the only place the head carries a ↶ (see below)
  const isPhone = useIsPhone()
  // the roster's source, named only where this station has one (see deploymentConfig)
  const rosterProvider = personnelProviderName()

  // Distinct ranks present in the roster, most senior first — drives the quick-filter chips.
  // Only shown when at least one member carries a rank (else the row is noise).
  const ranksPresent = useMemo(() => {
    const keys = [...new Set(people.map((p) => p.rank).filter((r): r is string => !!r))]
    return keys.sort((a, b) => rankOrder(a) - rankOrder(b))
  }, [people])

  const counts = useMemo(() => {
    let present = 0
    let left = 0
    for (const a of Object.values(attendance)) {
      if (a.status === 'present') present++
      else if (a.status === 'left') left++
    }
    const { scene, station } = ortCounts(attendance)
    return { present, left, scene, station }
  }, [attendance])

  // Planning is done with the people who are HERE. The whole Mannschaft on the axis buries the
  // handful actually on scene under a dozen empty lanes, so both planning tabs start filtered
  // to those present — and the toggle is right there, because somebody who arrives in two
  // hours still has to be plannable. Never applied to the crew list itself: that IS the
  // surface where people are marked present, and hiding the absent would hide the work.
  const [presentOnly, setPresentOnly] = useState(true)
  // …and the state narrowing, plus the one genuinely orthogonal flag. Both are SETS: several
  // picks inside a facet OR together («anwesend oder gegangen» = wer war überhaupt da), an empty
  // set means «alle». Every row carries the MARK the person row carries — the grey/green/amber
  // dot, the pin, the house, the Bemerkung dot — so picking a filter and looking up what a glyph
  // means stay the same gesture.
  const [stateSel, setStateSel] = useState<ReadonlySet<StateKey>>(() => new Set())
  // «hat eine Bemerkung» is the one flag that really is independent: anybody in any state can
  // carry one, so it rides ALONGSIDE the state rather than competing with it.
  const [noteOnly, setNoteOnly] = useState(false)
  const stateEntries = [
    { key: 'frei', cls: [], mark: <i className={s.dotFrei} />, label: A.statusFrei },
    { key: 'present', cls: [], mark: <i className={s.dotPresent} />, label: A.statusPresent },
    { key: 'left', cls: [], mark: <i className={s.dotLeft} />, label: A.statusLeft },
    // the two places, under the state they refine — both mean «anwesend, und zwar dort»
    { key: 'scene', cls: [s.markOrt], mark: <Icon id="pin" />, label: A.ortScene },
    { key: 'station', cls: [s.markOrt, s.markOrtStation], mark: <Icon id="station" />, label: A.ortStation },
  ] satisfies { key: StateKey; cls: string[]; mark: React.ReactNode; label: string }[]
  /** ⚠️ What is on is named in the button's TOOLTIP and marked with a fixed-size dot — it is
   *  never printed on the button. A label that appears when a filter is set changes the button's
   *  width, which moves every control after it on the line AND re-anchors the dropdown: the menu
   *  jumped sideways the moment you picked something in it. The dot is absolutely positioned, so
   *  the geometry is identical filtered or not — which matters more now that a facet can hold
   *  several picks and the label would be arbitrarily long. */
  const stateOn = [
    ...stateEntries.filter((e) => stateSel.has(e.key)).map((e) => e.label),
    ...(noteOnly ? [A.statusNote] : []),
  ].join(' · ')
  const rankOn = ranksPresent.filter((r) => rankSel.has(r)).map(rankDisplay).join(' · ')
  const planning = view !== 'list'
  /** Attendance entries with no roster row: guests, mutual aid, an AdF who never synced. They
   *  are shaped like a Person so every row action below works on them unchanged — and the
   *  Rapport already prints them as guest lines. */
  const guests = useMemo((): Person[] => {
    const known = new Set(people.map((p) => p.id))
    return Object.entries(attendance)
      .filter(([id]) => !known.has(id))
      .map(([id, a]) => ({ id, displayName: a.displayNameSnapshot || id, active: true, updatedAt: '', guest: true }))
  }, [people, attendance])

  const rows = useMemo(() => {
    // umlaut-neutral, and one typo forgiven (lib/search) — «Mueller» finds Müller, «Widemr»
    // finds Widmer. A 66-name Mannschaft searched with gloves on cannot demand exact spelling.
    const needle = searchQuery(q)
    return [...people, ...guests]
      .filter((p) => !needle || matchesQuery(needle, p.displayName))
      // within a facet the picks OR; the facets AND with each other and with the search
      .filter((p) => matchesAny(rankSel, (r) => p.rank === r))
      .filter((p) => !(planning && presentOnly) || isPresent(attendance[p.id]))
      .filter((p) => matchesAny(stateSel, (k) => stateMatches(k, attendance[p.id])))
      .filter((p) => !noteOnly || !!attendance[p.id]?.note)
      // grouped by seniority (most senior first), alpha within a rank
      .sort((a, b) => rankOrder(a.rank) - rankOrder(b.rank) || a.displayName.localeCompare(b.displayName, 'de'))
  }, [people, guests, q, rankSel, planning, presentOnly, stateSel, noteOnly, attendance])

  // frei → anwesend → gegangen → frei. A present+locked member jumps to the Trupp instead.
  const cycle = (p: Person) => {
    const status = attendance[p.id]?.status
    if (status === 'present') {
      if (blockedIds.has(p.id)) { onJumpToTrupp(truppOfPerson.get(p.id)); return }
      onMarkLeft(p)
    } else if (status === 'left') {
      // A roster row cycles back to «frei» — it is still on the Mannschaftsliste either way.
      // A guest's attendance entry IS the only record that they were ever here, so the same tap
      // would delete the person. They cycle back to «anwesend» instead, and removing one is an
      // explicit act in the Zeiten sheet — same rule as a hand-added Mittel, where 0 is a value
      // and «gelöscht» is a decision.
      if (p.guest) onMarkPresent(p)
      else onClear(p)
    } else {
      onMarkPresent(p)
    }
  }

  // where the axis reaches, in words — mirrors timelineSpan's own anchoring
  const horizonEndLabel = useMemo(() => {
    const startMs = startedAt ? Date.parse(startedAt) : nowMs
    const from = Math.max(Number.isFinite(startMs) ? startMs : nowMs, nowMs - 2 * 3_600_000)
    const end = new Date(from + horizonH * 3_600_000)
    return `${isOtherDay(end, new Date(from)) ? `${fmtDayShort(end)} ` : ''}${hhmm(end)}`
  }, [startedAt, nowMs, horizonH])

  // ⚠️ Guests are NOT in `people` — they are synthesised from attendance entries that have no
  // roster row (see `guests` above). Looking the clock button's person up in `people` alone meant
  // the sheet simply never opened for one, and since a guest deliberately cannot be cycled back
  // to «frei» (that tap would delete the only record they were ever here), the sheet is their ONE
  // way out — «Gast entfernen» lives in it. So a guest could be added and then never removed.
  // Searched across both lists, not across `rows`: `rows` is filtered by the search box and the
  // rank/anwesend filters, and typing while the sheet is open would otherwise close it.
  const blocksPerson = people.find((p) => p.id === blocksFor) ?? guests.find((p) => p.id === blocksFor)
  const empty = !people.length
  const planAvailable = !!shifts && !!onAddShift && !!onAddShiftSpan && !!onReplaceShift && !!onSetShiftTime && !!onRemoveShift
  const showPlan = planAvailable && view === 'plan'
  // the Schichten grid is a reading of the same shift slice, so it rides the same availability
  // gate; without the band actions wired up it can only ever be a read-only picture, and a grid
  // whose cells do not answer a tap is worse than no third tab
  const bandsAvailable = planAvailable && !!bands && !!onCreateBand && !!onSaveBand && !!onRemoveBand && !!onCycleCell && !!onSetCellState
  const showBands = bandsAvailable && view === 'bands'

  return (
    <div className={s.surface}>
      <header className={s.head}>
        <div className={s.headTitles}>
          <h2>{A.title}</h2>
          {/* «12 anwesend · 3 gegangen» — and, once anybody is at the Magazin,
              where those twelve are. That second half IS the answer to «wen könnte ich noch
              nachziehen», so it belongs in the head and not behind a filter. Hidden while
              everybody is at the scene: on the ordinary Einsatz it would say «12 vor Ort · 0
              Magazin» forever, which is a line that teaches you to stop reading the head.
              ⚠️ UNDER THE TITLE, the way every other surface head carries its quiet line
              (tokens · --head-*). It used to be a full-width row of its own BELOW the tabs and
              the buttons — which fixed the real problem it had (squeezed into a 250px column it
              stacked five lines deep) at the cost of a head that was a different object from the
              three next to it. The titles block now yields to the tools only down to
              --head-titles-min and then takes a row of its own, so the counts still get a line
              they fit on — the same way the Rapport's head has always solved this. */}
          <p className={s.headSummary}>
            {fillTemplate(A.summary, { present: counts.present })}
            {counts.station > 0 && (
              <> · {fillTemplate(A.summaryOrt, { scene: counts.scene, station: counts.station })}</>
            )}
            {/* «gegangen» closes the line. Between «anwesend» and the Ort split it sat in the
                middle of the two numbers that describe the crew ON HAND, which is not what it
                counts. Hidden at zero: a «0 gegangen» is not news on most Einsätze. */}
            {counts.left > 0 && <> · {fillTemplate(A.summaryLeft, { left: counts.left })}</>}
          </p>
        </div>
        {/* …and the poster read-out under it again, in its own still-quieter row. Beside the
            title it was a pill competing with the panel's own heading; folded into the counts it
            muddled «wie steht es» with «womit wurde erfasst». One line each. */}
        <p className={s.headQr}><CaptureUsageChip usage={captureUsage} /></p>
        <div className={s.headActions}>
          {/* ⚠️ Phone only. The pair is whole — a ↶ without its ↷ makes the step back the one
              thing that cannot itself be taken back, and this cluster has the room at phone width
              (the overflow it hit between 601 and ~850px is above this breakpoint). On a tablet
              the top bar keeps both, and nothing is duplicated here. */}
          {isPhone && onUndo && (
            <button className={c.iconBtn} onClick={onUndo} disabled={!canUndo}
              aria-label={A.undoTap} title={A.undoTap}>
              <Icon id="undo" />
            </button>
          )}
          {isPhone && onRedo && (
            <button className={c.iconBtn} onClick={onRedo} disabled={!canRedo}
              aria-label={A.redoTap} title={A.redoTap}>
              <Icon id="redo" />
            </button>
          )}
          {/* The Zeitplan's paper output. Kept MOUNTED in both views and merely hidden in the
              list — mounting it only for the Zeitplan made the view toggle jump sideways every
              time you switched tabs, because the actions row is right-aligned and one more button
              pushes everything along. Reserving the width keeps the toggle under your thumb. */}
          {/* Paper lives in a menu. Two more buttons on this line is what pushed the header past
              its own width between 601 and ~850px — where `.headActions` is flex:none, so nothing
              shrank and `overflow: hidden` simply cut the end off, taking «Aktualisieren» with it
              on an iPad held upright. One trigger instead of two also ends the old trick of
              keeping the pair mounted-but-invisible in the list view just to stop the toggle
              sliding sideways. */}
          {/* TWO sheets, chosen separately — they answer different questions, so the menu names
              both instead of guessing which was meant. «Schichtplan» only exists once there are
              bands to put across the top; «Verfügbarkeiten» is the one that exists regardless, and
              the only one on which a freihändige Zeit appears at all. Picking one opens a sheet
              that names its own contents and offers PDF and printer — which keeps the
              confirmation before paper starts moving, without four menu entries.
              Offered on the Zeitplan AND the Schichten tab: one surface, one way to paper. */}
          {(showPlan || showBands) && (onPrintZeitplan || onDownloadZeitplan) && (
            <Menu
              trigger={
                <button className={c.iconBtn} aria-label={appConfig.copy.zeitplan.paperMenu}
                  title={appConfig.copy.zeitplan.paperMenu}>
                  {/* icon + relay dot side by side, like the Rapport's print button — .iconBtn is
                      inline-grid, so as two loose children they stacked (printer OVER the dot) */}
                  <span className="print-send-main">
                    <Icon id="printer" />
                    {onPrintZeitplan && (
                      <span className={`dot print-relay-dot${zeitplanPrintOnline ? ' online' : ''}`} aria-hidden />
                    )}
                  </span>
                </button>
              }
              popupClassName={c.menuPop}
              itemClassName={() => c.menuItem}
              items={[
                ...(bands?.length ? [{
                  label: appConfig.copy.zeitplan.sheetSchichtplan,
                  onClick: () => setPaper('schichtplan'),
                }] : []),
                {
                  label: appConfig.copy.zeitplan.sheetVerfuegbarkeiten,
                  onClick: () => setPaper('verfuegbarkeiten'),
                },
              ]}
            />
          )}
          {/* Only when a fetch actually FAILED. It used to sit here permanently as
              «Aktualisieren», which said the wrong thing twice: the attendance never needed it
              (the workspace blob follows live), and the roster it really refreshed cannot change
              during an incident — only an admin's Divera sync moves it, and usePersonnel now picks
              that up in the background. What is left means what it says: that did not load, try
              again. */}
          {(error || reloadPhase === 'done') && (
            <button className={cx(s.reload, error && s.reloadFailed)} onClick={runReload}
              disabled={loading || reloadPhase !== 'idle'}
              aria-label={A.reload} title={error ? A.loadFailedHint : undefined}>
              {loading || reloadPhase !== 'idle'
                ? <SyncGlyph done={reloadPhase === 'done'}
                    label={reloadPhase === 'done' ? appConfig.copy.incidentSwitcher.syncDone : A.loading} />
                : <Icon id="warn" />}
              {reloadPhase !== 'done' && (
                <span className={s.reloadLabel}>{loading || reloadPhase === 'busy' ? A.loading : A.retry}</span>
              )}
            </button>
          )}
        </div>
        {/* The three readings of this Mannschaft, in a slot of their OWN rather than inside the
            action cluster. Only offered where a Zeitplan can actually be edited/read — the surface
            is inert without the shift slice wired up.
            On a phone the cluster and the tabs together no longer fit one line (printer + three
            segments + reload ≈ 380px against ~362px of room), so they wrapped — and because the
            titles already claimed a full row, the header spent THREE rows before the search: a
            title, a row holding one right-aligned reload button, and the tabs. It is its own slot
            now: the icons ride up beside the title and the tabs take a full-width line under it. */}
        {!empty && planAvailable && (
          <div className={s.headTabs}>
            <Segmented<AnwesenheitTab> ariaLabel={A.viewLabel} value={view} onChange={pickView}
              options={[
                { value: 'list', label: A.viewList },
                { value: 'plan', label: A.viewPlan },
                ...(bandsAvailable ? [{ value: 'bands' as const, label: A.viewBands }] : []),
              ]} />
          </div>
        )}
      </header>

      {!empty && (
        <div className={c.controls}>
          <label className={c.search}>
            <Icon id="search" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={A.searchPlaceholder} inputMode="search" />
            {q && <button className={c.searchClear} onClick={() => setQ('')} aria-label={A.clearSearch}><Icon id="close" /></button>}
          </label>
          {/* Only on the planning tabs — see the `presentOnly` note above. */}
          {planning && (
            <button
              type="button"
              className={cx(c.iconBtn, presentOnly && c.iconBtnOn)}
              aria-pressed={presentOnly}
              title={presentOnly ? A.presentOnlyOn : A.presentOnlyOff}
              aria-label={presentOnly ? A.presentOnlyOn : A.presentOnlyOff}
              onClick={() => setPresentOnly((v) => !v)}
            >
              {/* a TICK, the same glyph Mittel's «In Verwendung» carries: both mean «show only
                  the ones that count right now». It used to be the people glyph, which the Grad
                  filter beside it has a better claim to. */}
              <Icon id="check" />
            </button>
          )}
          {/* ⚠️ TWO buttons, one per QUESTION — «welcher Grad» and «wer ist wo». They were one
              merged funnel for an afternoon and it was wrong: a menu you open to reach either
              answer is slower than two you aim at, and the two facets have nothing to do with
              each other. Different glyphs so they are told apart without reading: the crew
              glyph for the Dienstgrad, the funnel for the state narrowing.
              Both narrow independently and AND together — «Of» + «anwesend» is one question.
              Neither button PRINTS what it has on (that changed its width and re-anchored the
              dropdown); each carries a fixed-position dot and names it in its tooltip.
              Both are `modal={false}` (the app-wide default is modal): with the backdrop in place
              a tap on the OTHER filter button first hits that backdrop, so switching between the
              two — which is the whole point of splitting them — costs two taps. Safe exactly here,
              because what lies under this bar is the filter row and the list, not the map. */}
          {ranksPresent.length > 1 && (
            <Menu
              modal={false}
              trigger={
                <button className={cx(c.iconBtn, rankSel.size > 0 && c.iconBtnOn)}
                  aria-label={rankOn ? `${A.rankFilterLabel} – ${rankOn}` : A.rankFilterLabel}
                  title={rankOn ? `${A.rankFilterLabel} – ${rankOn}` : A.rankFilterLabel}>
                  {/* the crew glyph — this is the facet that sorts PEOPLE. It cost the
                      «nur Anwesende» toggle its own people icon (that one is a tick now,
                      matching Mittel's «In Verwendung»), because two identical glyphs side
                      by side on the planning tabs is worse than either choice of icon. */}
                  <Icon id="people" />
                  {rankSel.size > 0 && <span className={c.filterDot} aria-hidden />}
                </button>
              }
              popupClassName={c.menuPop}
              itemClassName={() => c.menuItem}
              // CHECKBOXES, not a one-of-N: «Of + Wm» is the Kader, and that is a real question.
              // Base UI keeps the menu open on a checkbox, which is what composing a set needs.
              // «Alle» stays as its own row — it is the readable «nothing is filtered» state, and
              // un-ticking your way back out is a gesture nobody would find at 3am.
              items={[
                { kind: 'head' as const, label: A.rankFilterLabel },
                { kind: 'check' as const, label: A.rankAll, checked: rankSel.size === 0, onChange: () => setRankSel(new Set()) },
                // rankDisplay, NOT rankLabel: a rank the station's list does not cover came out
                // as a blank row (see lib/rank)
                ...ranksPresent.map((r) => ({
                  kind: 'check' as const,
                  label: rankDisplay(r),
                  checked: rankSel.has(r),
                  onChange: () => setRankSel((sel) => toggled(sel, r)),
                })),
              ]}
            />
          )}
          {/* Status/Ort/Bemerkung only mean something on the crew list — the two planning tabs
              are about time, and «wer ist im Magazin» is not a question you ask of a Zeitplan. */}
          {view === 'list' && (
            <Menu
              modal={false} // one-tap switch with the rank filter beside it — see the note above
              trigger={
                /* «Nach Status filtern», not the bare «Filtern»: the rank filter beside it names
                   its facet and this popup's own heading already does, so the hold tooltip was
                   the one place answering «which filter is this?» with «Filtern». */
                <button className={cx(c.iconBtn, (stateSel.size > 0 || noteOnly) && c.iconBtnOn)}
                  aria-label={stateOn ? `${A.statusFilterLabel} – ${stateOn}` : A.statusFilterLabel}
                  title={stateOn ? `${A.statusFilterLabel} – ${stateOn}` : A.statusFilterLabel}>
                  <Icon id="filter" />
                  {(stateSel.size > 0 || noteOnly) && <span className={c.filterDot} aria-hidden />}
                </button>
              }
              popupClassName={c.menuPop}
              itemClassName={() => c.menuItem}
              items={[
                { kind: 'head' as const, label: A.statusFilterLabel },
                // «Alle» clears the states but LEAVES the Bemerkung flag: they are separate
                // questions, and a row under «Status» that silently switched off a checkbox
                // below the rule would be the same trap the split Ort group was.
                { kind: 'check' as const, label: A.statusAll, checked: stateSel.size === 0, onChange: () => setStateSel(new Set()) },
                ...stateEntries.map((e) => ({
                  kind: 'check' as const,
                  label: <span className={cx(s.markRow, ...e.cls)}>{e.mark}{e.label}</span>,
                  checked: stateSel.has(e.key),
                  onChange: () => setStateSel((sel) => toggled(sel, e.key)),
                })),
                // a CHECKBOX, not one more state: «hat eine Bemerkung» is the one flag that
                // really is orthogonal — anybody in any state can carry one. Base UI keeps the
                // menu open on a checkbox, which is right: it is rarely the only thing set.
                { kind: 'sep' as const },
                {
                  kind: 'check' as const,
                  // ⚠️ `.markNote`, not `.statusNote` — the latter is the COPY key beside it
                  // (`A.statusNote`), and there is no such CSS class. CSS Modules resolved it to
                  // undefined and cx dropped it, so this was the one row of the menu whose mark
                  // was an empty 9px hole while every other row carried its own.
                  label: <span className={cx(s.markRow, s.markNote)}><i />{A.noteOnly}</span>,
                  checked: noteOnly,
                  onChange: setNoteOnly,
                },
              ]}
            />
          )}
          {/* «Weitere Person» sits at the END of the search line, not under the list: you look
              for somebody, they are not on the Mannschaftsliste, so you add them — one motion,
              which used to end with a scroll past sixty names to reach the button. */}
          {canEdit && onAddGuest && (
            // a bare +, like every other control on this line — the words «Weitere Person» cost
            // ~160px of a search row that has a field and two filters to fit as well. What it
            // adds is named in the dialog it opens, and in its own tooltip/aria-label.
            <button type="button" className={c.addBtn} onClick={() => setAddingGuest(true)}
              title={A.addGuest} aria-label={A.addGuest}>
              <Icon id="plus" />
            </button>
          )}
          {/* (the inline legend strip and its phone ⓘ popover are gone — both facets live in
              the two filter buttons above, which is also where the marks are looked up now.) */}
          {/* how far the axis reaches — it belongs on the search line beside the thing it filters,
              not on a row of its own pushing the grid down */}
          {showPlan && (
            <div className={s.horizon}>
              <span className={s.horizonLabel}>{appConfig.copy.zeitplan.horizon}</span>
              {/* A ZOOM, not a stepper. «−» shows MORE time (the axis zooms out), which is why
                  the number beside it grows — magnifier glyphs rather than −/+ so nobody reads
                  it as «make this number smaller». */}
              <button type="button" className={s.zoomBtn} onClick={() => stepHorizon(1)}
                disabled={horizonH >= HORIZONS[HORIZONS.length - 1]} aria-label={appConfig.copy.zeitplan.zoomOut}><Icon id="zoom-out" /></button>
              <b className={s.horizonValue}>{horizonH} h</b>
              {/* At a constant px-per-hour the view is pixel-identical when you widen the window —
                  only this number moved, and the scrollbar that would have hinted at more axis is
                  ignored by iPadOS. Naming the end makes the control answer its own question. */}
              <span className={s.horizonEnd}>{fillTemplate(appConfig.copy.zeitplan.horizonUntil, { t: horizonEndLabel })}</span>
              <button type="button" className={s.zoomBtn} onClick={() => stepHorizon(-1)}
                disabled={horizonH <= HORIZONS[0]} aria-label={appConfig.copy.zeitplan.zoomIn}><Icon id="zoom-in" /></button>
            </div>
          )}
        </div>
      )}

      {/* The ranks used to have a row of their own here. They now sit inline with the search (see
          .controls above) — on a desk screen seeing them all is faster than opening anything, but
          not at the price of a second band of chrome. On a PHONE they stay one button that carries
          its own state: neutral for «Alle», tinted and naming the rank while a filter is on, so a
          filtered list can never look like the whole Mannschaft. */}

      {empty ? (
        <EmptyState className="empty-fill" icon={error ? 'warn' : 'people'}
          title={error ? A.loadFailedTitle : A.emptyTitle}
          sub={error ? A.loadFailedHint
            : rosterProvider ? fillTemplate(A.emptyHintSync, { provider: rosterProvider }) : A.emptyHint}
          action={<button type="button" className="ip-btn" onClick={onReload} disabled={loading}><Icon id="rotate" /> {A.retry}</button>} />
      ) : !rows.length ? (
        <div className="ip-ac-note ip-ac-note-center">{A.noMatches}</div>
      ) : showBands ? (
        <BandGrid
          people={rows}
          shifts={shifts!}
          bands={bands!}
          canEdit={canEdit}
          startedAt={startedAt ?? null}
          attendance={attendance}
          onAddShift={onAddShift!}
          onSetShiftTime={onSetShiftTime!}
          onReplaceShift={onReplaceShift!}
          onRemoveShift={onRemoveShift!}
          onCreateBand={onCreateBand!}
          onSaveBand={onSaveBand!}
          onRemoveBand={onRemoveBand!}
          onCycleCell={onCycleCell!}
          onSetCellState={onSetCellState!}
          onPutCellState={onPutCellState ?? onSetCellState!}
        />
      ) : showPlan ? (
        <ZeitplanView
          people={rows}
          attendance={attendance}
          shifts={shifts!}
          canEdit={canEdit}
          startedAt={startedAt ?? null}
          nowMs={nowMs}
          onAdd={onAddShift!}
          onSetTime={onSetShiftTime!}
          onRemove={onRemoveShift!}
          onAddSpan={onAddShiftSpan!}
          onReplace={onReplaceShift!}
          horizonH={horizonH}
        />
      ) : (
        <div className={s.grid}>
          {rows.map((p) => {
            const a = attendance[p.id]
            const present = isPresent(a)
            const left = !!a && !present
            const locked = present && blockedIds.has(p.id)
            const blocks = intervalsOf(a)
            return (
              <div key={p.id} className={cx(s.person, present && s.isPresent, left && s.isLeft)}>
                <button
                  type="button"
                  className={s.personMain}
                  disabled={!canEdit}
                  onClick={() => cycle(p)}
                  title={locked ? A.lockedTitle
                    : !p.active ? (rosterProvider ? fillTemplate(A.notInSource, { provider: rosterProvider }) : A.notInDivera)
                      : undefined}
                >
                  <span className={cx(s.dot, present && s.dotPresent, left && s.dotLeft, !present && !left && s.dotFrei)} />
                  {/* …and only when there is an abbreviation to put in it: a rank the station's
                      list does not cover gave `rankAbbr` '' and rendered an EMPTY badge — a
                      small blank chip in front of the name. No chip is better than a blank one;
                      the full label (or the raw key) is still in the tooltip. */}
                  {p.rank && rankAbbr(p.rank) && <span className={s.rank} title={rankDisplay(p.rank)}>{rankAbbr(p.rank)}</span>}
                  {/* somebody recorded for this Einsatz only — the badge sits where a Grad would,
                      so the row still reads «who is this» before it reads the name */}
                  {p.guest && <span className={cx(s.rank, s.guestBadge)}>{A.guestBadge}</span>}
                  <span className={s.name}>{p.displayName}</span>
                  {/* ⚠️ NO remark text in the row. It was shown here so it would not be
                      forgotten — and it took the width away from the NAME («Anna Me…»), which is
                      the one thing this list exists to show. The remark lives in the person's
                      sheet; a dot on the clock button says there IS one. */}
                  {locked && <Icon id="gauge" />}
                </button>
                {/* NO time on the row. It carried a whole editor — and once a start sitting on the
                    alarm time read «ab Beginn», that word alone took most of the width and crushed
                    the name to «B…», which is the one thing this list must never do. The times
                    belong to the sheet, where a person's several stretches are all visible at once
                    instead of just the latest. The row answers «who is here», the sheet «since
                    when, exactly». */}
                {/* Rückkehr — the tap cycle's third step CLEARS the row (frei), and it must keep
                    doing that (it is the only way back from a mis-tick). So coming back gets its
                    own control: it opens a NEW block instead of reopening the closed one. */}
                {/* THE one clock in the row, always there: it opens the sheet where several
                    stretches — came, went, came back — are added and corrected. The chip beside it
                    edits the single time shown; this is the way to all the others. */}
                {/* Am Einsatzort oder noch im Magazin. ONE tap flips it, and the chip says
                    which it is in a word — this is read at a glance down a column of 12 names,
                    so it must not be a colour alone. Only on somebody who is HERE: «wo ist
                    jemand, der gegangen ist» has no answer worth a control. */}
                {present && (
                  canEdit && onSetOrt ? (
                    <button
                      type="button"
                      className={cx(s.ort, ortOf(a) === 'station' ? s.ortStation : s.ortScene)}
                      title={fillTemplate(ortOf(a) === 'station' ? A.ortToScene : A.ortToStation, { name: p.displayName })}
                      aria-label={fillTemplate(ortOf(a) === 'station' ? A.ortToScene : A.ortToStation, { name: p.displayName })}
                      onClick={() => onSetOrt(p)}
                    >
                      <Icon id={ortOf(a) === 'station' ? 'station' : 'pin'} />
                    </button>
                  ) : (
                    <span className={cx(s.ort, ortOf(a) === 'station' ? s.ortStation : s.ortScene)}>
                      <Icon id={ortOf(a) === 'station' ? 'station' : 'pin'} />
                    </span>
                  )
                )}
                <LivePositionChip
                  live={livePositions?.get(p.id)}
                  center={incidentCenter}
                  onShow={onShowOnMap ? () => onShowOnMap(p.id) : undefined}
                />
                {canEdit && blocks.length > 0 && (
                  <button
                    type="button"
                    className={cx(s.backBtn, attendance[p.id]?.note && s.hasNote)}
                    /* ⚠️ The blue dot on this button means «da steht eine Bemerkung» and nothing
                       on the row said so — a mark you have to be told about is a mark nobody
                       reads. It is named in the filter menu now, and the button says it too. */
                    title={fillTemplate(attendance[p.id]?.note ? A.openBlocksNote : A.openBlocks, { name: p.displayName })}
                    aria-label={fillTemplate(attendance[p.id]?.note ? A.openBlocksNote : A.openBlocks, { name: p.displayName })}
                    onClick={() => setBlocksFor(p.id)}
                  >
                    <Icon id="clock" />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {addingGuest && onAddGuest && (
        <GuestDialog
          onCancel={() => setAddingGuest(false)}
          onSubmit={(name) => { onAddGuest(name); setAddingGuest(false) }}
        />
      )}

      {paper && (
        <PaperSheet
          sheet={paper}
          people={rows}
          bands={bands?.length ?? 0}
          printOnline={zeitplanPrintOnline}
          onPrint={onPrintZeitplan ? () => onPrintZeitplan(rows, paper) : undefined}
          onDownload={onDownloadZeitplan ? () => onDownloadZeitplan(rows, paper) : undefined}
          onClose={() => setPaper(null)}
        />
      )}

      {blocksPerson && (
        <PresenceSheet
          person={blocksPerson}
          blocks={intervalsOf(attendance[blocksPerson.id])}
          note={attendance[blocksPerson.id]?.note}
          canEdit={canEdit}
          startedAt={startedAt}
          onSetTimes={onSetTimes}
          onRemoveBlock={onRemoveBlock}
          onSetNote={onSetNote}
          onRemoveGuest={(p) => { setBlocksFor(null); onClear(p) }}
          /* stays open: the new block appears in the list you are looking at, so a mis-tap is
             seen and can be corrected on the spot */
          onBack={() => onMarkPresent(blocksPerson)}
          onClose={() => setBlocksFor(null)}
        />
      )}
    </div>
  )
}
