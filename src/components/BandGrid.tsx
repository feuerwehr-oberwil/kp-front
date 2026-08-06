import { useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm } from '../lib/format'
import { applyTimeToIso, isoOnDay, keepEndAfterStart, keepStartBeforeEnd } from '../lib/abschluss'
import { cx } from '../lib/cx'
import { ContextMenu } from '../lib/overlays'
import { useIsPhone } from '../lib/useIsPhone'
import { rankAbbr, rankLabel } from '../lib/rank'
import { fmtDayShort, incidentDays, isOtherDay } from '../lib/zeitplanFormat'
import {
  bandCell, bandCellNeedsResolve, bandCellWindow, bandCounts, bandSplitPlan, conflictingShiftIds,
  draftBand, isAssignedCell, shiftsFor, sortBands, unshownShifts,
} from '../lib/shifts'
import type { AttendanceState, Person, Shift, ShiftBand } from '../types'
import type { BandCell, BandSplitPlan } from '../lib/shifts'
import { intervalsOf } from '../lib/attendanceIntervals'
import { PersonShiftSheet } from './PersonShiftSheet'
import { Sheet } from '../lib/overlays'
import { TimeField } from './TimeField'
import { EmptyState } from './EmptyState'
import { ShiftConflictNotice } from './ShiftConflictNotice'
import s from './BandGrid.module.css'

const clock = (iso: string): string => {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? hhmm(d) : ''
}

/**
 * «07:00–12:00». Always the full clock, on both ends.
 *
 * The hour alone used to stand in for a whole hour, which read fine until one end had minutes and
 * the other did not: «20:30–21» is two different notations in one range, and the eye has to stop
 * and work out that the second one is a time at all. A clock on a Führungsformular is five
 * characters; it costs a little width and never has to be decoded.
 */
function fmtRange(from: string, to: string): string {
  const a = new Date(from)
  const b = new Date(to)
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return ''
  return `${hhmm(a)}–${hhmm(b)}`
}

/**
 * The one question the cycle cannot answer: this person is assigned for part of this watch and
 * merely offered for another part, so no single next state follows from a tap.
 *
 * Three ways out and no fourth. «Abbrechen» matters as much as the other two — the cell is not
 * broken, and somebody who opened this by mistake must be able to leave it exactly as it was.
 */
function ResolveSheet({ person, band, bandTitle: title, cell, split, onPick, onClose }: {
  person: Person
  band: ShiftBand
  bandTitle: string
  cell: BandCell
  /** stretches that run past the watch and will be CUT at its edges — shown before anything moves */
  split: BandSplitPlan[]
  onPick: (state: 'available' | 'confirmed') => void
  onClose: () => void
}) {
  const iso = (ms: number) => new Date(ms).toISOString()
  const S = appConfig.copy.schichten
  // TWO reasons to be here, and they are not the same question. Either the window genuinely holds
  // both states, or it holds one — but the stretch carrying it runs past the watch, so changing it
  // from this column would reach outside. Saying «teils verfügbar, teils geplant» over a cell that
  // is wholly geplant is the sheet describing a different problem than the one you tapped.
  const mixed = cell.state === 'mixed'
  return (
    <Sheet open onClose={onClose} fit sheetClassName={s.sheet} title={mixed ? S.resolveTitle : S.crossTitle}
      footer={
        <>
          <button type="button" className="ip-btn" onClick={onClose}>{S.resolveCancel}</button>
          <button type="button" className="ip-btn" onClick={() => { onPick('available'); onClose() }}>
            {S.resolveAvailable}
          </button>
          <button type="button" className="ip-btn primary" onClick={() => { onPick('confirmed'); onClose() }}>
            {S.resolveConfirmed}
          </button>
        </>
      }
    >
      <p className={s.resolveMsg}>
        {fillTemplate(mixed ? S.resolveMsg : S.crossMsg, { name: person.displayName, band: title })}
      </p>
      {/* WHICH hours are which. «teilweise eingeteilt und teilweise nur verfügbar» describes the
          shape of the problem without saying where it is, and the answer here overwrites both —
          nobody should have to close this sheet and read the strip to find out what they are
          about to change. */}
      <ul className={s.resolveList}>
        {cell.segments.map((seg) => (
          <li key={seg.from}>
            <b>{fmtRange(new Date(seg.from).toISOString(), new Date(seg.to).toISOString())}</b>
            <span className={seg.state === 'confirmed' ? s.segWordConfirmed : s.segWordAvailable}>
              {seg.state === 'confirmed' ? S.confirmed : S.available}
            </span>
          </li>
        ))}
        {/* the hole is a fact about this watch too, and «alles auf geplant» does NOT fill it */}
        {cell.partial && <li className={s.resolveGap}>{S.resolveGap}</li>}
      </ul>
      {/* What the answer will CUT. Turning one stretch somebody drew into three is not a thing to
          discover afterwards, so the pieces are named before the press — and which of them stay
          exactly as they are. */}
      {split.length > 0 && (
        <div className={s.splitBox}>
          <h4>{S.splitTitle}</h4>
          {split.map((plan) => {
            const span = plan.pieces[plan.pieces.length - 1].to - plan.pieces[0].from
            return (
              <div key={plan.shift.id} className={s.splitItem}>
                <b>{fmtRange(plan.shift.from, plan.shift.to)}</b>
                {/* The cut, drawn. Three lines of clock readings made you rebuild the picture in
                    your head at the one moment being wrong is expensive — this IS the picture: one
                    stretch, the watch's window inside it, the middle piece marked as the part that
                    moves. Each piece keeps a minimum width so its own boundary time fits under it;
                    where that no longer fits the box, the box scrolls rather than squeezing the
                    clock into something unreadable. */}
                <div className={s.splitBarBox}>
                  <div className={s.splitBar}>
                    {plan.pieces.map((piece) => (
                      <span key={piece.from} className={piece.inside ? s.pieceInside : s.pieceKeeps}
                        style={{ flexGrow: (piece.to - piece.from) / Math.max(1, span) }}>
                        <em>{clock(iso(piece.from))}</em>
                      </span>
                    ))}
                    {/* the far end has no piece of its own to hang under */}
                    <span className={s.pieceEnd}><em>{clock(iso(plan.pieces[plan.pieces.length - 1].to))}</em></span>
                  </div>
                </div>
                <p className={s.splitLegend}>
                  <i className={s.pieceInside} aria-hidden />{S.splitChanges}
                  <i className={s.pieceKeeps} aria-hidden />
                  {fillTemplate(S.splitKeeps, { state: plan.shift.confirmed ? S.confirmed : S.available })}
                </p>
              </div>
            )
          })}
        </div>
      )}
      {/* only where something is actually cut — and it says what the cut protects, which is the
          opposite of what this line used to promise */}
      {split.length > 0 && <p className={s.note}>{S.splitNote}</p>}
    </Sheet>
  )
}

/** Where an instant sits inside a band, as a percentage — the strip's own coordinates. */
function pctOf(at: number, band: ShiftBand): number {
  const from = Date.parse(band.from)
  const to = Date.parse(band.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0
  return Math.max(0, Math.min(100, ((at - from) / (to - from)) * 100))
}

/**
 * The one line a cell can carry, as the parts it is built from (one part = one line).
 *
 * A word only fits a window that holds ONE state end to end. One state over part of it names its
 * hours instead — and names them AGAINST the column, because that is what the cell is about: a
 * stretch that runs to the watch's own end is «ab 09:00», one that starts with it is «bis 20:00».
 * Only when both ends differ does it take a full range, and that one goes on two lines rather than
 * running out of a 56px cell.
 *
 * Anything else — two states, or two separate stretches — has no true word, so it says «teilweise»
 * and hands the detail to the strip below it.
 */
function cellText(cell: BandCell, win: { from: string; to: string } | null, band: ShiftBand,
  S: typeof appConfig.copy.schichten): string[] {
  if (cell.state === 'empty') return []
  if (cell.state === 'confirmed') return [S.confirmed]
  if (cell.state === 'available') return [S.available]
  if (cell.state === 'deviating' && cell.segments.length === 1 && win) {
    if (win.from === band.from) return [fillTemplate(S.cellUntil, { t: clock(win.to) })]
    if (win.to === band.to) return [fillTemplate(S.cellFrom, { t: clock(win.from) })]
    return [`${clock(win.from)}–`, clock(win.to)]
  }
  return [S.partial]
}

/** What a column is called. The label is optional on purpose — a band you named «Früh» reads as
 *  «Früh», one you just wanted a column for reads as its own hours, and nothing blocks creating it
 *  at 3am because a text field was still empty. */
function bandTitle(b: ShiftBand): string {
  return b.label.trim() || fmtRange(b.from, b.to)
}

/**
 * The sheet that creates, renames, re-times and deletes ONE band.
 *
 * Deliberately the plainest surface in the app: a name, two times, one button. The whole point of
 * the Schichten grid is that the time entry happens ONCE here instead of once per person, so this
 * is the only place on the surface where a clock is typed at all.
 */
function BandSheet({ band, bands, startedAt, onCreate, onSave, onRemove, onClose }: {
  /** null = a new band */
  band: ShiftBand | null
  bands: ShiftBand[]
  startedAt: string | null
  onCreate: (label: string, from: string, to: string) => void
  onSave: (id: string, label: string, from: string, to: string) => void
  onRemove: (id: string) => void
  onClose: () => void
}) {
  const S = appConfig.copy.schichten
  // One clock, read once as the sheet opens — the same lazy-initialiser pattern the Presence sheet
  // uses. The grid has nothing that moves, so it carries no ticking hook to borrow a «now» from,
  // and reading the wall clock during render would re-draft the times on every keystroke.
  const [openedAt] = useState(() => Date.now())
  const [draft] = useState(() => band ?? draftBand(bands, openedAt, startedAt, appConfig.shifts.defaultHours))
  const [label, setLabel] = useState(band?.label ?? '')
  const [from, setFrom] = useState(draft.from)
  const [to, setTo] = useState(draft.to)
  // A Schicht is almost always in the future — «Nacht 22–06» is planned in the afternoon, and
  // the second and third of them days ahead. Bounded at `openedAt`, the wheel offered today
  // and nothing else.
  const days = incidentDays(startedAt, Math.max(
    openedAt + appConfig.shifts.planAheadHours * 3_600_000, Date.parse(to) || 0))
  const commit = () => {
    if (band) onSave(band.id, label.trim(), from, to)
    else onCreate(label.trim(), from, to)
    onClose()
  }
  const subject = band ? bandTitle(band) : S.sheetAddTitle
  return (
    <Sheet open onClose={onClose} fit sheetClassName={s.sheet}
      title={band ? S.sheetEditTitle : S.sheetAddTitle}
      footer={
        <>
          {band && (
            <button type="button" className="ip-btn danger" onClick={() => { onRemove(band.id); onClose() }}>
              <Icon id="trash" />{S.removeBand}
            </button>
          )}
          <button type="button" className="ip-btn primary" onClick={commit}>
            {band ? S.save : S.create}
          </button>
        </>
      }
    >
      <label className={s.field}>
        <span className={s.fieldLabel}>{S.labelField}</span>
        <input className={s.text} value={label} onChange={(e) => setLabel(e.target.value)}
          placeholder={S.labelPlaceholder} enterKeyHint="done"
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
      </label>
      <div className={s.times}>
        <span className={s.field}>
          <span className={s.fieldLabel}>{appConfig.copy.zeitplan.from}</span>
          <TimeField ariaLabel={`${appConfig.copy.zeitplan.from} – ${subject}`} value={clock(from)} days={days}
            onCommit={(v, day) => {
              if (!v) return
              // a von typed after the bis means this band STARTED the previous day, exactly as on
              // the Zeitplan card — a reversed band renders as a column of nothing
              const iso = day ? isoOnDay(day, v) : applyTimeToIso(from, v, { prevDayIfAfter: to })
              // …and never past its own end, however the day was chosen
              if (iso) setFrom(keepStartBeforeEnd(iso, to))
            }} />
          {/* the date is ALWAYS there, not only when it differs from the incident's first day.
              «07:00» on day three of an Elementarereignis is a question, not an answer — and it is
              what makes the overnight roll above visible instead of silent. */}
          <span className={s.day}>{fmtDayShort(new Date(from))}</span>
        </span>
        <span className={s.sep} aria-hidden>–</span>
        <span className={s.field}>
          <span className={s.fieldLabel}>{appConfig.copy.zeitplan.to}</span>
          <TimeField ariaLabel={`${appConfig.copy.zeitplan.to} – ${subject}`} value={clock(to)} days={days}
            onCommit={(v, day) => {
              if (!v) return
              // «Nacht 22–06»: a bis before the von runs past midnight, it does not run backwards
              const iso = day ? isoOnDay(day, v) : applyTimeToIso(to, v, { nextDayIfBefore: from })
              if (iso) setTo(keepEndAfterStart(from, iso))
            }} />
          <span className={s.day}>{fmtDayShort(new Date(to))}</span>
        </span>
      </div>
      <p className={s.note}>{band ? S.removeBandHint : S.sheetHint}</p>
    </Sheet>
  )
}

/**
 * Schichtbänder — the Zeitplan transposed.
 *
 * The Zeitplan is person-major over CONTINUOUS time: pick a person, draw when. The question «we're
 * running 07–12 and 12–17, who can do it?» is the transpose — shift-major over DISCRETE time: pick
 * a window, decide who. Doing that on the axis costs 3–10 gestures per person (open the sheet,
 * pick von, pick bis, close); at 50 people that is 150–500. Here the time entry happens once, in
 * the band, and every person after that is a single tap.
 *
 * So the columns are shifts, not hours, and there is no axis on this surface at all: at 390px a
 * five-hour band on a 12h axis is 230px wide inside a ~190px track, which means you would never
 * see two bands side by side — which is the only thing this reading is for.
 *
 * The cells split the two halves of a shift (see `bandCell`): **availability is derived**, because
 * somebody who drew 10:00–20:00 on the axis IS available for a 12:00–17:00 watch and should not
 * have to say so twice; **assignment is stored**, because putting somebody on a watch is a
 * decision, and it must not appear because a clock lined up nor vanish because a band moved five
 * minutes. Everything else follows from that: a cell covering only part of a window shows its real
 * hours instead of a promise, and deleting a band leaves every one of its shifts standing.
 */
export function BandGrid({
  people, shifts, bands, canEdit, startedAt, attendance,
  onAddShift, onSetShiftTime, onReplaceShift, onRemoveShift,
  onCreateBand, onSaveBand, onRemoveBand, onCycleCell, onSetCellState, onPutCellState,
}: {
  /** already filtered + ordered by the shared Anwesenheit header, so all three views read alike */
  people: Person[]
  shifts: Shift[]
  bands: ShiftBand[]
  canEdit: boolean
  startedAt: string | null
  /** read-only «tatsächlich anwesend» half of the person sheet */
  attendance: AttendanceState
  /** the same four shift actions the Zeitplan hands its sheet — one surface, one editor */
  onAddShift: (p: Person) => void
  onSetShiftTime: (id: string, patch: { from?: string; to?: string }) => void
  onReplaceShift: (sh: Shift) => void
  onRemoveShift: (id: string, personName: string) => void
  onCreateBand: (label: string, from: string, to: string) => void
  /** rename + re-time in one commit; the re-time asks about dragging assigned people along */
  onSaveBand: (id: string, label: string, from: string, to: string) => void
  onRemoveBand: (id: string) => void
  onCycleCell: (band: ShiftBand, person: Person) => void
  /** settle a window that holds BOTH states for one person — «alles auf verfügbar / geplant» */
  onSetCellState: (band: ShiftBand, person: Person, state: 'available' | 'confirmed') => void
  /** the right-click menu's explicit setter — handles the empty cell too */
  onPutCellState: (band: ShiftBand, person: Person, state: 'available' | 'confirmed') => void
}) {
  const S = appConfig.copy.schichten
  /** null = closed · 'new' = the create sheet · a band = its edit sheet */
  const [sheet, setSheet] = useState<'new' | ShiftBand | null>(null)
  /** whose own times are open — the SAME sheet the Zeitplan opens from a name */
  const [openPerson, setOpenPerson] = useState<string | null>(null)
  const isPhone = useIsPhone()
  /** the cell whose window holds both states and has to be settled by hand */
  const [resolve, setResolve] = useState<{ person: Person; band: ShiftBand } | null>(null)
  const cols = useMemo(() => sortBands(bands), [bands])
  const conflicts = useMemo(() => conflictingShiftIds(shifts), [shifts])
  const person = people.find((p) => p.id === openPerson)

  if (!cols.length) {
    return (
      <div className={s.bandgrid}>
        {/* The state every incident begins in — and the only one where creating a band is allowed
            to be BIG, because it is then the sole sensible action on the surface. The ＋ in the
            head row afterwards only has to be reachable, not loud. */}
        <EmptyState className="empty-fill" icon="clock" title={S.emptyTitle} sub={S.emptyHint}
          /* one column, not the EmptyState's default row: `.empty-state-act` lays its children
             side by side, so the hint sat BESIDE the button and squeezed «Erste Schicht
             definieren» onto three lines */
          action={canEdit ? (
            <div className={s.emptyAct}>
              <button type="button" className="ip-btn primary" onClick={() => setSheet('new')}>
                <Icon id="plus" />{S.addBandFirst}
              </button>
              <p className={s.emptyAxis}>{S.emptyAxisHint}</p>
            </div>
          ) : undefined} />
        {sheet && (
          <BandSheet band={null} bands={bands} startedAt={startedAt}
            onCreate={onCreateBand} onSave={onSaveBand} onRemove={onRemoveBand}
            onClose={() => setSheet(null)} />
        )}
      </div>
    )
  }

  return (
    <div className={s.bandgrid}>
      {/* the same notice the Zeitplan carries — one wording for one fault, on both readings */}
      <ShiftConflictNotice shifts={shifts} people={people} className={s.conflictNotice} />
      <div className={s.scroll}>
        {/* --bands drives the grid's own width: at three columns it is exactly the port and the
            cells share it out; from the fourth the minimum cell width wins and the surface scrolls
            sideways instead of squeezing cells under the thumb floor. */}
        <div className={s.grid} style={{ ['--bands' as string]: cols.length }}>
          <div className={cx(s.row, s.headRow)}>
            {/* «0  8» said nothing about which number was which. The key names them ONCE, here,
                for every column at the same time — labelling each head twice would not fit in a
                65px column and would repeat the same two words across the whole row. Same two
                words and the same two colours as the Zeitplan's Deckung curve. */}
            <div className={cx(s.who, s.whoHead)}>
              <span className={s.headKey}>
                <span className={cx(s.keyDot, s.dotAvailable)} aria-hidden />{S.available}
              </span>
              <span className={s.headKey}>
                <span className={cx(s.keyDot, s.dotConfirmed)} aria-hidden />{S.confirmed}
              </span>
            </div>
            {cols.map((b) => {
              const c = bandCounts(shifts, b)
              return (
                <button key={b.id} type="button" className={s.band} disabled={!canEdit}
                  onClick={() => setSheet(b)} title={bandTitle(b)}
                  aria-label={`${bandTitle(b)} · ${fillTemplate(S.countsAria, { available: c.available, planned: c.confirmed })}`}>
                  <b>{bandTitle(b)}</b>
                  {/* only when the label is a real name — otherwise the head would say its own
                      hours twice */}
                  {b.label.trim() && <i>{fmtRange(b.from, b.to)}</i>}
                  {/* The two numbers the Deckung curve exists for once time is continuous. There is
                      deliberately no target beside them: a Soll/Ist column invites filling a
                      number rather than asking who can actually come. */}
                  <span className={s.counts}>
                    {/* «2·» — two people, but not all of them across the whole watch. Without it
                        the head said two where 07:00 has one, and staffing off that number leaves
                        the first hours short. */}
                    <span className={s.cntAvailable}>{c.available}{c.availablePartial && <i title={S.partialHint}>·</i>}</span>
                    <span className={s.cntConfirmed}>{c.confirmed}{c.confirmedPartial && <i title={S.partialHint}>·</i>}</span>
                  </span>
                </button>
              )
            })}
            {/* THE one way in. It stands in the row it creates, next to the columns it produces —
                no proposal, no adopting a drawn bar, no collecting anything by matching times. */}
            {canEdit
              ? (
                <button type="button" className={s.addBand} onClick={() => setSheet('new')}
                  title={S.addBand} aria-label={S.addBand}><Icon id="plus" /></button>
              )
              : <span className={s.pad} aria-hidden />}
          </div>

          {people.map((p) => {
            const cells = cols.map((b) => bandCell(shifts, p.id, b))
            // The mark carries exactly what the columns are SILENT about — band-less times, and
            // times that drifted out of the band they belong to. Once a cell picks hours up,
            // repeating them in the name column prints the same fact twice across one row.
            const own = unshownShifts(shifts, p.id, cols)
            return (
              <div key={p.id} className={s.row}>
                <button type="button" className={s.who} onClick={() => setOpenPerson(p.id)}
                  aria-label={fillTemplate(appConfig.copy.zeitplan.openFor, { name: p.displayName })}
                  title={fillTemplate(appConfig.copy.zeitplan.openFor, { name: p.displayName })}>
                  {/* rank + name are ONE line, always: they identify the same person, and on a
                      112px phone column a bare wrap put the badge above the name and made that
                      row a head taller than its neighbours for no information at all */}
                  <span className={s.whoMain}>
                    {p.rank && <span className={s.rank} title={rankLabel(p.rank)}>{rankAbbr(p.rank)}</span>}
                    <span className={s.name}>{p.displayName}</span>
                  </span>
                  {/* Somebody whose own times reach no column at all sits empty everywhere —
                      indistinguishable from somebody who has offered nothing. The mark carries
                      their real hours, so the grid never claims they are free. */}
                  {own.length > 0 && (
                    <span className={s.ownTimes}
                      title={fillTemplate(S.ownTimes, { times: own.map((x) => fmtRange(x.from, x.to)).join(' · ') })}>
                      {own.length > 1
                        ? fillTemplate(S.ownTimesMore, { first: fmtRange(own[0].from, own[0].to), n: own.length - 1 })
                        : fmtRange(own[0].from, own[0].to)}
                    </span>
                  )}
                </button>
                {cols.map((b, i) => {
                  const cell = cells[i]
                  const sh = cell.shift
                  const bad = !!sh && conflicts.has(sh.id)
                  const deviating = cell.state === 'deviating' || cell.state === 'mixed'
                  // a derived cell is never «eingeteilt» — assignment is always stored
                  const assigned = isAssignedCell(cell)
                  // the hours this cell shows, clamped to its own column: «05–08» in a watch that
                  // ends at 06:00 is 05–06 as far as this column is concerned
                  const win = bandCellWindow(cell, b)
                  // The tap cycles leer → verfügbar → eingeteilt; right-click NAMES the three
                  // with the current one ticked. Same reason as the Zeitplan bars: a cycle is
                  // right under a thumb and wrong at a desk, where landing on the state you
                  // meant should not require knowing the order.
                  const cellBtn = (
                    <button key={b.id} type="button" disabled={!canEdit}
                      className={cx(s.cell,
                        cell.state !== 'empty' && !assigned && s.cellAvailable,
                        assigned && s.cellConfirmed,
                        (deviating || cell.state === 'mixed') && s.cellDeviating,
                        cell.state === 'mixed' && s.cellMixed, bad && s.cellConflict)}
                      onClick={() => (bandCellNeedsResolve(cell, b)
                        ? setResolve({ person: p, band: b })
                        : onCycleCell(b, p))}
                      title={bad ? S.conflict
                        : deviating && sh
                          ? fillTemplate(S.deviating, {
                            name: p.displayName, from: clock(sh.from), to: clock(sh.to),
                            bandFrom: clock(b.from), bandTo: clock(b.to),
                          })
                          : fillTemplate(S.cellAria, { name: p.displayName, band: bandTitle(b) })}
                      aria-label={fillTemplate(S.cellAria, { name: p.displayName, band: bandTitle(b) })}
                      aria-pressed={cell.state !== 'empty'}>
                      <span className={s.cellLabel}>
                        {bad && <Icon id="warn" />}
                        <span className={s.cellLines}>
                          {cellText(cell, win, b, S).map((line) => <span key={line}>{line}</span>)}
                        </span>
                      </span>
                      {/* The strip: the whole window, drawn. A word can only be true of a window
                          that holds ONE state, and «verfügbar 09–11 · geplant 10–20» inside a
                          07–12 watch holds three (nothing, offered, assigned). Same colours as the
                          Zeitplan lane, transposed — no new vocabulary, and it reads at a glance
                          where a second line of text would not fit at all. */}
                      {cell.segments.length > 0 && cell.state !== 'available' && cell.state !== 'confirmed' && (
                        <span className={s.strip} aria-hidden>
                          {cell.segments.map((seg) => (
                            <i key={seg.from} className={seg.state === 'confirmed' ? s.segConfirmed : s.segAvailable}
                              style={{ left: `${pctOf(seg.from, b)}%`, width: `${pctOf(seg.to, b) - pctOf(seg.from, b)}%` }} />
                          ))}
                        </span>
                      )}
                    </button>
                  )
                  return (
                    <ContextMenu
                      key={b.id}
                      disabled={!canEdit || isPhone}
                      trigger={cellBtn}
                      items={[
                        // «Leer» is not offered: getting back to empty is the tap cycle's job,
                        // which protects a derived cell's own offer and hand-drawn deviating
                        // times. See useBandActions.putCellState.
                        { label: S.available, checked: cell.state === 'available', onClick: () => onPutCellState(b, p, 'available') },
                        { label: S.confirmed, checked: cell.state === 'confirmed', onClick: () => onPutCellState(b, p, 'confirmed') },
                        { label: S.editEntry, separatorBefore: true, onClick: () => setOpenPerson(p.id) },
                      ]}
                    />
                  )
                })}
                <span className={s.pad} aria-hidden />
              </div>
            )
          })}
        </div>
      </div>
      {cols.length > 3 && <p className={s.scrollHint}>{S.scrollHint}</p>}

      {sheet && (
        <BandSheet band={sheet === 'new' ? null : sheet} bands={bands} startedAt={startedAt}
          onCreate={onCreateBand} onSave={onSaveBand} onRemove={onRemoveBand}
          onClose={() => setSheet(null)} />
      )}

      {resolve && (
        <ResolveSheet person={resolve.person} band={resolve.band} bandTitle={bandTitle(resolve.band)}
          cell={bandCell(shifts, resolve.person.id, resolve.band)}
          split={bandSplitPlan(shifts, resolve.person.id, resolve.band)}
          onPick={(state) => onSetCellState(resolve.band, resolve.person, state)}
          onClose={() => setResolve(null)} />
      )}

      {/* The SAME sheet the Zeitplan opens from a name. Adding somebody's own hours — «kann erst ab
          14:00» — is the one thing this grid cannot express in a cell, and having to change tab for
          it made a two-second correction a four-step detour. */}
      {person && (
        <PersonShiftSheet
          person={person}
          shifts={shiftsFor(shifts, person.id)}
          blocks={intervalsOf(attendance[person.id])}
          canEdit={canEdit}
          startedAt={startedAt}
          conflicts={conflicts}
          onAdd={onAddShift}
          onSetTime={onSetShiftTime}
          onToggle={(sh) => onReplaceShift({ ...sh, confirmed: !sh.confirmed })}
          onRemove={onRemoveShift}
          onClose={() => setOpenPerson(null)}
        />
      )}
    </div>
  )
}
