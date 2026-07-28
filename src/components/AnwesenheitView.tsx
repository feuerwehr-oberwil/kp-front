import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import type { AttendanceState, Person, PresenceInterval, Shift, ShiftBand } from '../types'
import type { ZeitplanSheet } from '../lib/zeitplanPrint'
import { cx } from '../lib/cx'
import { appConfig } from '../config/appConfig'
import { fillTemplate, fmtSpanShort, hhmm } from '../lib/format'
import { applyTimeToIso, isoOnDay } from '../lib/abschluss'
import { rankAbbr, rankLabel, rankOrder } from '../lib/rank'
import { intervalsOf, isPresent } from '../lib/attendanceIntervals'
import { fmtDayShort, fmtStartValue, incidentDays, isOtherDay } from '../lib/zeitplanFormat'
import { loadPrefs, savePrefs } from '../lib/prefs'
import { useIsPhone } from '../lib/useIsPhone'
import { CaptureUsageChip, type CaptureUsage } from './CaptureUsageChip'
import { Segmented } from './Segmented'
import { Menu, Sheet } from '../lib/overlays'
import { TimeBlockSheet } from './TimeBlockSheet'
import { timeBlockLabels } from '../lib/timeBlockLabels'
import { EmptyState } from './EmptyState'
import { ZeitplanView } from './ZeitplanView'
import { BandGrid } from './BandGrid'
import s from './Anwesenheit.module.css'

/** Zeitraum stops for the Zeitplan axis, in hours — from one watch to a four-day deployment. */
const HORIZONS = [3, 6, 9, 12, 18, 24, 36, 48, 72, 96]

/** sentinel value for the «Alle» segment of the rank filter (no real rank uses it) */
const RANK_ALL = '__all__'

/** The three readings of this surface. `bands` is the Schichten grid — shift-major over discrete
 *  time, the transpose of the Zeitplan (see BandGrid). It is a TAB and not an entry in the ⋯ menu
 *  on purpose: a whole way of working does not belong behind three dots. */
type AnwesenheitTab = 'list' | 'plan' | 'bands'

// HH:MM of an ISO stamp — the tappable time chip / the <input type="time"> value
function toHM(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}


/**
 * Every recorded block of one person, opened from the row's «+».
 *
 * A single chip on the row can only ever show the LATEST block, which reads as the whole story
 * when somebody has come and gone twice. This lists them all, corrects any of them, and is where
 * a return is opened. Built on the SAME sheet the Zeitplan's Schichten use, so the two stay
 * identical rather than drifting apart.
 */
function PresenceSheet({ person, blocks, canEdit, startedAt, onSetTimes, onRemoveBlock, onBack, onClose }: {
  person: Person
  blocks: PresenceInterval[]
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
      blocks={blocks.map((iv, i) => ({
        key: String(i),
        from: toHM(iv.from),
        to: iv.to ? toHM(iv.to) : undefined,
        openLabel: A.stillHere,
        // Same card as the Zeitplan, but the head is a READ-OUT here: a stretch of presence has no
        // second state to flip into — it is running or it is finished, and that is decided by the
        // row in the list, not in this sheet. So no switch, and no «umschalten» on hover.
        head: iv.to
          ? { label: A.ended, tone: 'done' as const }
          : { label: A.running, tone: 'open' as const },
        duration: fmtSpanShort((iv.to ? Date.parse(iv.to) : openedAt) - Date.parse(iv.from)),
        // mirror of onTo: a von typed after the bis means the block STARTED the previous day
        onFrom: canEdit && onSetTimes ? (v, day) => { const iso = day ? isoOnDay(day, v) : applyTimeToIso(iv.from, v, { prevDayIfAfter: iv.to }); if (iso) onSetTimes(person.id, { from: iso }, i) } : undefined,
        // on a multi-day Einsatz the clock alone does not say which day this block belongs to
        dayLabel: startedAt && isOtherDay(new Date(iv.from), new Date(startedAt)) ? fmtDayShort(new Date(iv.from)) : undefined,
        toDayLabel: iv.to && isOtherDay(new Date(iv.to), new Date(iv.from)) ? fmtDayShort(new Date(iv.to)) : undefined,
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
          ? fillTemplate(Z.sheetContentBands, { people: people.length, bands, t: hhmm(openedAt) })
          : fillTemplate(Z.sheetContent, { people: people.length, t: hhmm(openedAt) })}
      </p>
      <p className={s.paperHint}>{schicht ? Z.sheetSchichtplanHint : Z.sheetVerfuegbarkeitenHint}</p>
    </Sheet>
  )
}

// The Anwesenheit surface: one unified, compact grid of the whole Mannschaft. Each name is a
// button whose tap cycles its state — frei → anwesend → gegangen → frei — so a single view
// both shows and edits attendance with no mode switching (3am tenet: recognition over recall).
// A member in an active Atemschutz-Trupp is locked: tapping jumps to the Trupp instead of
// marking them gone (the checkout rule). Order is stable alphabetical so chips don't reflow
// under your finger while you tap.
export function AnwesenheitView({
  people, attendance, canEdit, loading, error, blockedIds,
  onMarkPresent, onMarkLeft, onClear, onJumpToTrupp, onReload, onSetTimes, onRemoveBlock, captureUsage,
  shifts, bands, onCreateBand, onSaveBand, onRemoveBand, onCycleCell,
  startedAt, onAddShift, onAddShiftSpan, onReplaceShift, onSetShiftTime, onRemoveShift,
  onPrintZeitplan, onDownloadZeitplan, zeitplanPrintOnline,
}: {
  people: Person[]
  attendance: AttendanceState
  canEdit: boolean
  loading: boolean
  error: boolean
  /** person ids assigned to an active Trupp — locked against "Gegangen" until released */
  blockedIds: Set<string>
  onMarkPresent: (p: Person) => void
  onMarkLeft: (p: Person) => void
  onClear: (p: Person) => void
  onJumpToTrupp: () => void
  onReload: () => void
  /** correct a wrong auto-stamped time via the row's time chip (e.g. "gegangen" marked
   *  after the person already left) — same handler as the Rapport Stunden editor. Patches the
   *  CURRENT presence block; `index` targets an earlier one. */
  onSetTimes?: (personId: string, patch: { from?: string; to?: string }, index?: number) => void
  /** drop one recorded presence block (never the last one — that is what «frei» is for) */
  onRemoveBlock?: (personId: string, index: number) => void
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
}) {
  const isPhone = useIsPhone()
  const [q, setQ] = useState('')
  const [rankFilter, setRankFilter] = useState<string | null>(null)
  // Anwesenheit, Zeitplan and Schichten are three readings of the SAME filtered, ordered
  // Mannschaft — the search + rank filter above apply to all of them, so a name sits in the same
  // place whichever one is open.
  const [view, setView] = useState<AnwesenheitTab>(() => loadPrefs().anwesenheitView ?? 'list')
  const pickView = (v: AnwesenheitTab) => { setView(v); savePrefs({ ...loadPrefs(), anwesenheitView: v }) }
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
  useEffect(() => {
    if (view !== 'plan') return
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [view])
  const A = appConfig.copy.anwesenheit

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
    return { present, left, total: people.length }
  }, [attendance, people])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return people
      .filter((p) => !needle || p.displayName.toLowerCase().includes(needle))
      .filter((p) => !rankFilter || p.rank === rankFilter)
      // grouped by seniority (most senior first), alpha within a rank
      .sort((a, b) => rankOrder(a.rank) - rankOrder(b.rank) || a.displayName.localeCompare(b.displayName, 'de'))
  }, [people, q, rankFilter])

  // frei → anwesend → gegangen → frei. A present+locked member jumps to the Trupp instead.
  const cycle = (p: Person) => {
    const status = attendance[p.id]?.status
    if (status === 'present') {
      if (blockedIds.has(p.id)) { onJumpToTrupp(); return }
      onMarkLeft(p)
    } else if (status === 'left') {
      onClear(p)
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

  const blocksPerson = people.find((p) => p.id === blocksFor)
  const empty = !people.length
  const planAvailable = !!shifts && !!onAddShift && !!onAddShiftSpan && !!onReplaceShift && !!onSetShiftTime && !!onRemoveShift
  const showPlan = planAvailable && view === 'plan'
  // the Schichten grid is a reading of the same shift slice, so it rides the same availability
  // gate; without the band actions wired up it can only ever be a read-only picture, and a grid
  // whose cells do not answer a tap is worse than no third tab
  const bandsAvailable = planAvailable && !!bands && !!onCreateBand && !!onSaveBand && !!onRemoveBand && !!onCycleCell
  const showBands = bandsAvailable && view === 'bands'

  return (
    // data-noswipe while the Zeitplan is showing: this surface is a grid you WORK on, and paging
    // away from it by accident is the opposite of what a horizontal drag here means. Planning a
    // shift IS a horizontal drag, and the two cannot share a finger — so the pager gives way, and
    // it gives way for the whole surface rather than just the lanes, because a swipe that pages
    // from the header but not from the row underneath it is worse than one that never pages.
    // The bottom bar and the nav rail still switch surfaces; only the gesture is gone.
    // …and while the Schichten grid is showing, for the same reason: from the fourth band it
    // scrolls sideways, and a horizontal drag there means «show me the next column», not «page to
    // the next surface».
    <div className={s.surface} {...(showPlan || showBands ? { 'data-noswipe': true } : {})}>
      <header className={s.head}>
        <div className={s.headTitles}>
          <h2>{A.title}</h2>
          <p>{fillTemplate(A.summary, { present: counts.present, left: counts.left, total: counts.total })}</p>
        </div>
        <div className={s.headActions}>
          <CaptureUsageChip usage={captureUsage} />
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
                <button className={s.iconBtn} aria-label={appConfig.copy.zeitplan.paperMenu}
                  title={appConfig.copy.zeitplan.paperMenu}>
                  <Icon id="printer" />
                  {onPrintZeitplan && (
                    <span className={`dot print-relay-dot${zeitplanPrintOnline ? ' online' : ''}`} aria-hidden />
                  )}
                </button>
              }
              popupClassName={s.menuPop}
              itemClassName={() => s.menuItem}
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
          {/* the two readings of this Mannschaft. Only offered where a Zeitplan can actually be
              edited/read — the surface is inert without the shift slice wired up. */}
          {!empty && planAvailable && (
            <Segmented<AnwesenheitTab> ariaLabel={A.viewLabel} value={view} onChange={pickView}
              options={[
                { value: 'list', label: A.viewList },
                { value: 'plan', label: A.viewPlan },
                ...(bandsAvailable ? [{ value: 'bands' as const, label: A.viewBands }] : []),
              ]} />
          )}
          <button className={s.reload} onClick={onReload} disabled={loading} aria-label={A.reload}>
            <Icon id="rotate" /><span className={s.reloadLabel}>{loading ? A.loading : A.refresh}</span>
          </button>
        </div>
      </header>

      {!empty && (
        <div className={s.controls}>
          <label className={s.search}>
            <Icon id="search" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={A.searchPlaceholder} inputMode="search" />
            {q && <button className={s.searchClear} onClick={() => setQ('')} aria-label={A.clearSearch}><Icon id="close" /></button>}
          </label>
          {ranksPresent.length > 1 && isPhone && (
            <Menu
              trigger={
                <button className={cx(s.iconBtn, rankFilter && s.iconBtnOn)}
                  aria-label={A.rankFilterLabel} title={A.rankFilterLabel}>
                  <Icon id="filter" />
                  {/* the active rank rides ON the button: a filtered list that looks like the whole
                      Mannschaft is the one way this control can mislead */}
                  {rankFilter && <span className={s.filterOn}>{rankAbbr(rankFilter) || rankLabel(rankFilter)}</span>}
                </button>
              }
              popupClassName={s.menuPop}
              itemClassName={() => s.menuItem}
              items={[
                { label: A.rankAll, onClick: () => setRankFilter(null) },
                ...ranksPresent.map((r) => ({
                  label: rankLabel(r),
                  onClick: () => setRankFilter(r === rankFilter ? null : r),
                })),
              ]}
            />
          )}
          {view === 'list' && !isPhone && (
            <div className={s.legend} aria-hidden>
              <span><i className={s.dotFrei} />{A.legendFrei}</span>
              <span><i className={s.dotPresent} />{A.legendPresent}</span>
              <span><i className={s.dotLeft} />{A.legendLeft}</span>
            </div>
          )}
          {/* how far the axis reaches — it belongs on the search line beside the thing it filters,
              not on a row of its own pushing the grid down */}
          {showPlan && (
            <div className={s.horizon}>
              <span className={s.horizonLabel}>{appConfig.copy.zeitplan.horizon}</span>
              <button type="button" className={s.zoomBtn} onClick={() => stepHorizon(-1)}
                disabled={horizonH <= HORIZONS[0]} aria-label={appConfig.copy.zeitplan.zoomIn}><Icon id="minus" /></button>
              <b className={s.horizonValue}>{horizonH} h</b>
              {/* At a constant px-per-hour the view is pixel-identical when you widen the window —
                  only this number moved, and the scrollbar that would have hinted at more axis is
                  ignored by iPadOS. Naming the end makes the control answer its own question. */}
              <span className={s.horizonEnd}>{fillTemplate(appConfig.copy.zeitplan.horizonUntil, { t: horizonEndLabel })}</span>
              <button type="button" className={s.zoomBtn} onClick={() => stepHorizon(1)}
                disabled={horizonH >= HORIZONS[HORIZONS.length - 1]} aria-label={appConfig.copy.zeitplan.zoomOut}><Icon id="plus" /></button>
            </div>
          )}
        </div>
      )}

      {/* On a desktop the ranks are a row of chips — they fit, and seeing them all is faster than
          opening anything. On a PHONE that row was a band of its own, ~44px of the little vertical
          space there is, permanently spent on a control that is used once a shift. It becomes one
          button that carries its own state: neutral for «Alle», tinted and naming the rank while a
          filter is on, so a filtered list can never look like the whole Mannschaft. */}
      {!empty && ranksPresent.length > 1 && !isPhone && (
        <div className={s.rankRow}>
          {/* rank filter — the shared <Segmented>; «Alle» (sentinel) clears the filter, and re-tapping
              the active rank clears it too (parent decides the toggle-off). */}
          <Segmented<string> ariaLabel={A.rankFilterLabel} value={rankFilter ?? RANK_ALL}
            onChange={(v) => setRankFilter(v === RANK_ALL || v === rankFilter ? null : v)}
            options={[
              { value: RANK_ALL, label: A.rankAll },
              ...ranksPresent.map((r) => ({ value: r, label: rankAbbr(r) || rankLabel(r), title: rankLabel(r) })),
            ]} />
        </div>
      )}

      {empty ? (
        <EmptyState className="empty-fill" icon={error ? 'warn' : 'people'}
          title={error ? A.loadFailedTitle : A.emptyTitle} sub={error ? A.loadFailedHint : A.emptyHint}
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
          onCreateBand={onCreateBand!}
          onSaveBand={onSaveBand!}
          onRemoveBand={onRemoveBand!}
          onCycleCell={onCycleCell!}
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
                  title={locked ? A.lockedTitle : !p.active ? A.notInDivera : undefined}
                >
                  <span className={cx(s.dot, present && s.dotPresent, left && s.dotLeft, !present && !left && s.dotFrei)} />
                  {p.rank && <span className={s.rank} title={rankLabel(p.rank)}>{rankAbbr(p.rank)}</span>}
                  <span className={s.name}>{p.displayName}</span>
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
                {canEdit && blocks.length > 0 && (
                  <button
                    type="button"
                    className={s.backBtn}
                    title={fillTemplate(A.openBlocks, { name: p.displayName })}
                    aria-label={fillTemplate(A.openBlocks, { name: p.displayName })}
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
          canEdit={canEdit}
          startedAt={startedAt}
          onSetTimes={onSetTimes}
          onRemoveBlock={onRemoveBlock}
          /* stays open: the new block appears in the list you are looking at, so a mis-tap is
             seen and can be corrected on the spot */
          onBack={() => onMarkPresent(blocksPerson)}
          onClose={() => setBlocksFor(null)}
        />
      )}
    </div>
  )
}
