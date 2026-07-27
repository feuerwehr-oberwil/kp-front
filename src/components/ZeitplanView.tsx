import { useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm } from '../lib/format'
import { fmtDayShort, isOtherDay } from '../lib/zeitplanFormat'
import { applyTimeToIso } from '../lib/abschluss'
import { cx } from '../lib/cx'
import { rankAbbr, rankLabel } from '../lib/rank'
import { intervalsOf } from '../lib/attendanceIntervals'
import { useLaneGesture } from '../lib/useLaneGesture'
import {
  SLOT_MS, barGeometry, conflictingShiftIds, coverage, intervalSpan, shiftSpan, shiftsFor, timelineSpan,
} from '../lib/shifts'
import type { AttendanceState, Person, PresenceInterval, Shift } from '../types'
import type { Span } from '../lib/shifts'
import { TimeBlockReadOnly, TimeBlockSheet } from './TimeBlockSheet'
import { timeBlockLabels } from '../lib/timeBlockLabels'
import s from './Zeitplan.module.css'

const HOUR = 3_600_000
/** Width of one hour of axis. CONSTANT on purpose: a longer Zeitraum makes the track longer and
 *  scrollable rather than squeezing more hours into the same space. Scrolling is fine — losing
 *  resolution is not, and the earlier by-total-hours thinning made a wide window look like it had
 *  quietly dropped its clock. The track still flexes UP to fill a wider surface. */
const PX_PER_HOUR = 46
/** An hour label needs about this much room before its neighbour crowds it. */
const LABEL_PX = 90


const clock = (iso?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? hhmm(d) : ''
}

/**
 * Everything about ONE person's time, opened from their row (pencil, or press-and-hold on the
 * lane). Both halves live here — the availability we PLAN (editable) and the presence that
 * actually HAPPENED (read-only: it is the record, and it is ticked in the Anwesenheit list).
 *
 * Built on the SAME sheet the Anwesenheit uses, so the two never drift apart again.
 */
function PersonSheet({ person, shifts, blocks, canEdit, startedAt, conflicts, onAdd, onSetTime, onToggle, onRemove, onClose }: {
  person: Person
  shifts: Shift[]
  blocks: PresenceInterval[]
  canEdit: boolean
  /** incident alarm time — drives the day labels and the «ab Beginn» shortcut */
  startedAt: string | null
  conflicts: Set<string>
  onAdd: (p: Person) => void
  onSetTime: (id: string, patch: { from?: string; to?: string }) => void
  onToggle: (sh: Shift) => void
  onRemove: (id: string, personName: string) => void
  onClose: () => void
}) {
  const Z = appConfig.copy.zeitplan
  const A = appConfig.copy.anwesenheit
  return (
    <TimeBlockSheet
      title={fillTemplate(Z.editTitle, { name: person.displayName })}
      subject={person.displayName}
      sectionTitle={Z.plannedSection}
      emptyLabel={Z.plannedNone}
      note={Z.sheetHint}
      addLabel={canEdit ? Z.addShift : undefined}
      onAdd={canEdit ? () => onAdd(person) : undefined}
      onClose={onClose}
      labels={timeBlockLabels(Z.remove)}
      blocks={shifts.map((sh) => ({
        key: sh.id,
        from: clock(sh.from),
        to: clock(sh.to),
        warn: conflicts.has(sh.id),
        // mirror of onTo: a von typed after the bis means the shift STARTED the previous day,
        // not that it runs backwards — a reversed shift renders as nothing at all
        onFrom: canEdit ? (v) => { const iso = applyTimeToIso(sh.from, v, { prevDayIfAfter: sh.to }); if (iso) onSetTime(sh.id, { from: iso }) } : undefined,
        // a bis before the von means the shift runs past midnight, not backwards
        onTo: canEdit ? (v) => { const iso = applyTimeToIso(sh.to, v, { nextDayIfBefore: sh.from }); if (iso) onSetTime(sh.id, { to: iso }) } : undefined,
        onRemove: canEdit ? () => onRemove(sh.id, person.displayName) : undefined,
        // on a multi-day Einsatz the clock alone does not say which day this shift belongs to
        dayLabel: startedAt && isOtherDay(new Date(sh.from), new Date(startedAt)) ? fmtDayShort(new Date(sh.from)) : undefined,
        onFromStart: canEdit && startedAt && sh.from !== startedAt
          ? () => onSetTime(sh.id, { from: startedAt }) : undefined,
        trailing: (
          <button type="button" className={cx(s.sheetState, sh.confirmed && s.sheetStateOn)}
            disabled={!canEdit} onClick={() => onToggle(sh)} aria-pressed={!!sh.confirmed}
            aria-label={`${person.displayName}: ${fillTemplate(Z.toggleHint, { state: sh.confirmed ? Z.available : Z.confirmed })}`}
            title={fillTemplate(Z.toggleHint, { state: sh.confirmed ? Z.available : Z.confirmed })}>
            {sh.confirmed ? Z.confirmed : Z.available}
          </button>
        ),
      }))}
      extra={
        <TimeBlockReadOnly
          title={Z.actualSection}
          blocks={blocks.map((iv) => ({ from: clock(iv.from), to: iv.to ? clock(iv.to) : undefined }))}
          emptyLabel={Z.actualNone}
          note={Z.actualHint}
          openLabel={A.stillHere}
        />
      }
    />
  )
}

/**
 * One person's line: the name, and their own lane of time.
 *
 * The lane is worked directly, the way the paper form is filled in — sweep to record availability,
 * tap a bar to turn it into a plan, drag to move or stretch it, pencil (or press-and-hold) for the
 * sheet. That is why the row carries no «+» and no time chips: they crowded the name out and put
 * every edit two taps away from the thing it edits.
 */
function PersonRow({ person, shifts, blocks, span, nowMs, canEdit, conflicts, nowLine, onAddSpan, onReplace, onOpen }: {
  person: Person
  shifts: Shift[]
  blocks: PresenceInterval[]
  span: Span
  nowMs: number
  canEdit: boolean
  conflicts: Set<string>
  nowLine: React.ReactNode
  onAddSpan: (p: Person, from: number, to: number) => void
  onReplace: (sh: Shift) => void
  onOpen: () => void
}) {
  const Z = appConfig.copy.zeitplan
  const g = useLaneGesture({
    span,
    canEdit,
    onCreate: (from, to) => onAddSpan(person, from, to),
    onToggle: (sh) => onReplace({ ...sh, confirmed: !sh.confirmed }),
    onCommit: onReplace,
    onHold: onOpen,
    // findLast, not find: overlapping bars are painted in order, so the LAST one is the one on
    // top and the one the finger actually pointed at
    shiftAtTime: (t) => [...shifts].reverse().find((x) => {
      const sp = shiftSpan(x)
      return !!sp && t >= sp.from && t < sp.to
    }) ?? null,
  })

  const barStyle = (from: number, to: number) => {
    const b = barGeometry(from, to, span)
    return b ? { left: `${b.left * 100}%`, width: `${b.width * 100}%` } : null
  }
  // while a bar is being dragged it is drawn from the live preview instead of the stored value,
  // so it follows the finger without a workspace write per pointer event
  const shown = shifts.map((sh) => (g.preview?.id === sh.id ? g.preview : sh))

  return (
    <div className={cx(s.row, shifts.length > 0 && s.rowPlanned)}>
      {/* the whole name cell opens the sheet — the pencil inside is the visible cue, not a
          separate control, so there is one target and one label instead of two overlapping ones */}
      <button type="button" className={s.who} onClick={onOpen}
        aria-label={fillTemplate(Z.openFor, { name: person.displayName })}
        title={fillTemplate(Z.openFor, { name: person.displayName })}>
        {person.rank && <span className={s.rank} title={rankLabel(person.rank)}>{rankAbbr(person.rank)}</span>}
        <span className={s.name}>{person.displayName}</span>
        {shifts.length > 0 && (
          <span className={cx(s.count, shifts.some((x) => conflicts.has(x.id)) && s.countConflict)}>
            {shifts.length}
          </span>
        )}
        {/* press-and-hold on the lane opens the same sheet, but a gesture nobody was told about is
            not a way in — this is the one you can see */}
        {canEdit && <span className={s.editBtn} aria-hidden><Icon id="pen" /></span>}
      </button>
      <div className={cx(s.track, s.lane, canEdit && s.laneEditable)}
        aria-label={fillTemplate(Z.planAt, { name: person.displayName })}
        {...g.laneProps(canEdit)}>
        {/* the stretch currently being swept out, so the sweep is visible while it happens */}
        {g.draw && (() => {
          const st = barStyle(g.draw.from, g.draw.to)
          return st ? <span className={cx(s.bar, s.plannedBar, s.drawing)} style={st} aria-hidden /> : null
        })()}
        {/* executed presence first, so a planned outline drawn over it stays readable */}
        {blocks.map((iv, i) => {
          const sp = intervalSpan(iv, nowMs)
          const st = sp && barStyle(sp.from, sp.to)
          return st ? (
            <span key={`a${i}`} className={cx(s.bar, s.actual, !iv.to && s.open)} style={st}
              title={`${Z.actual}: ${clock(iv.from)}–${iv.to ? clock(iv.to) : ''}`} />
          ) : null
        })}
        {shown.map((sh) => {
          const sp = shiftSpan(sh)
          const st = sp && barStyle(sp.from, sp.to)
          if (!st) return null
          const bad = conflicts.has(sh.id)
          const next = sh.confirmed ? Z.available : Z.confirmed
          return (
            <span key={sh.id} className={cx(s.bar, s.plannedBar, sh.confirmed && s.confirmedBar, bad && s.conflict, g.preview?.id === sh.id && s.dragging)}
              style={st} {...(canEdit ? g.barProps(sh, 'move') : {})}
              title={bad ? Z.conflict
                : `${sh.confirmed ? Z.confirmed : Z.available}: ${clock(sh.from)}–${clock(sh.to)} · ${fillTemplate(Z.toggleHint, { state: next })}`}>
              {canEdit && (
                <>
                  <em className={cx(s.handle, s.handleFrom)} title={Z.dragFrom} {...g.barProps(sh, 'from')} />
                  <em className={cx(s.handle, s.handleTo)} title={Z.dragTo} {...g.barProps(sh, 'to')} />
                </>
              )}
            </span>
          )
        })}
        {nowLine}
      </div>
    </div>
  )
}

/**
 * Schichtenplanung — the BGV/KKO «Zeitplan» Führungsformular as a live surface.
 *
 * ONE grid, exactly like the paper form: every name sits at the left of its OWN lane, time runs
 * across the top. (A first cut floated the lanes above a separate name list, and nothing said
 * which bar belonged to whom — which is the entire job of the «Wer» column.) The name column is
 * sticky, so it stays put while the axis scrolls off into the night.
 *
 * Two bars share every lane. The HOLLOW one is what was planned; the FILLED one is the presence
 * actually recorded (lib/attendanceIntervals). Nothing here writes attendance — the plan is a
 * plan — so the two drift apart on purpose, and seeing that drift is the point: planned until
 * 22:00, actually gone at 20:00. Under the lanes, the coverage strip answers the question a wall
 * of bars cannot: where is the hole at 02:00.
 */
export function ZeitplanView({
  people, attendance, shifts, canEdit, startedAt, nowMs,
  onAdd, onAddSpan, onReplace, onSetTime, onRemove, horizonH,
}: {
  /** already filtered + ordered by the shared Anwesenheit header, so both views read alike */
  people: Person[]
  attendance: AttendanceState
  shifts: Shift[]
  canEdit: boolean
  startedAt: string | null
  /** ticked by the parent — the «now» line and the growing open bar move with it */
  nowMs: number
  onAdd: (p: Person) => void
  /** plan exactly the stretch swept out on the grid */
  onAddSpan: (p: Person, from: number, to: number) => void
  /** a whole shift replaced — after a drag, or when its planned/fix state flips */
  onReplace: (sh: Shift) => void
  onSetTime: (id: string, patch: { from?: string; to?: string }) => void
  onRemove: (id: string, personName: string) => void
  /** how many hours the axis shows at once (the Zeitraum control lives in the surface header) */
  horizonH: number
}) {
  const Z = appConfig.copy.zeitplan // read per-render so the resolved locale applies
  const [openPerson, setOpenPerson] = useState<string | null>(null)

  const span = useMemo(
    () => timelineSpan(startedAt, shifts, attendance, nowMs, horizonH),
    [startedAt, shifts, attendance, nowMs, horizonH],
  )
  const conflicts = useMemo(() => conflictingShiftIds(shifts), [shifts])
  const slots = useMemo(() => coverage(shifts, attendance, span, nowMs), [shifts, attendance, span, nowMs])
  const peakCover = Math.max(1, ...slots.map((c) => Math.max(c.planned, c.actual)))

  // hour ticks across the head; the grid itself is half-hourly (SLOT_MS) but labelling every
  // half hour is unreadable on a tablet
  // The label step comes from how much ROOM an hour has, not from how many hours there are — the
  // old by-total thinning meant a wider Zeitraum showed fewer and fewer labels, which reads as the
  // axis losing its clock rather than simply being longer. At a fixed px-per-hour the density is
  // now identical at 6 h and at 96 h. Midnight is always labelled: across several days «03:00»
  // alone never said WHICH night, so it carries the date instead.
  const hours = useMemo(() => {
    const step = Math.max(1, Math.ceil(LABEL_PX / PX_PER_HOUR))
    const out: { at: number; label: string; midnight: boolean }[] = []
    const first = Math.ceil(span.from / HOUR) * HOUR
    for (let at = first; at < span.to; at += HOUR) {
      const d = new Date(at)
      const midnight = d.getHours() === 0
      if (midnight || d.getHours() % step === 0) {
        out.push({ at, label: midnight ? fmtDayShort(d) : hhmm(d), midnight })
      }
    }
    return out
  }, [span])

  const pct = (t: number) => `${(((t - span.from) / Math.max(1, span.to - span.from)) * 100).toFixed(3)}%`
  const nowInside = nowMs >= span.from && nowMs <= span.to
  const trackW = Math.max(320, ((span.to - span.from) / HOUR) * PX_PER_HOUR)
  const nothingPlanned = shifts.length === 0
  // the «now» line repeats per lane rather than spanning the whole grid: with a sticky name column
  // a single full-height rule would slide out from under its own coordinates while scrolling
  const nowLine = nowInside ? <span className={s.nowLine} style={{ left: pct(nowMs) }} aria-hidden /> : null
  // a dashed rule at every midnight: over several days a bar otherwise floats with nothing saying
  // which day it belongs to, and «Tag 2, 03:00» is a different decision from «heute, 03:00»
  const dayLines = hours.filter((h) => h.midnight).map((h) => (
    <span key={`d${h.at}`} className={s.dayLine} style={{ left: pct(h.at) }} aria-hidden />
  ))

  const person = people.find((p) => p.id === openPerson)


  return (
    <div className={s.zeitplan}>
      <div className={s.scroll}>
        <div className={s.grid} style={{ ['--track-w' as string]: `${trackW}px` }}>
          {/* head — «Wer» over the name column, the clock over the track, exactly as on paper */}
          <div className={cx(s.row, s.headRow)}>
            <div className={cx(s.who, s.whoHead)} aria-hidden />
            <div className={s.track}>
              {hours.map((h) => (
              <span key={h.at} className={cx(s.tick, h.midnight && s.tickDay)} style={{ left: pct(h.at) }}>{h.label}</span>
            ))}
              {nowInside && <span className={cx(s.nowLine, s.nowLineHead)} style={{ left: pct(nowMs) }}><em>{Z.now}</em></span>}
            </div>
          </div>

          {people.map((p) => (
            <PersonRow
              key={p.id}
              person={p}
              shifts={shiftsFor(shifts, p.id)}
              blocks={intervalsOf(attendance[p.id])}
              span={span}
              nowMs={nowMs}
              canEdit={canEdit}
              conflicts={conflicts}
              nowLine={<>{dayLines}{nowLine}</>}
              onAddSpan={onAddSpan}
              onReplace={onReplace}
              onOpen={() => setOpenPerson(p.id)}
            />
          ))}

          {/* coverage: planned above, actually there below — the future half of the lower strip
              stays empty on purpose, nobody knows yet who will turn up */}
          <div className={cx(s.row, s.coverageRow)}>
            <div className={cx(s.who, s.whoFoot)} title={Z.coverageHint}>{Z.coverage}</div>
            <div className={cx(s.track, s.coverage)}>
              {slots.map((c) => (
                <span key={c.at} className={s.cov} style={{ left: pct(c.at), width: `${((SLOT_MS / (span.to - span.from)) * 100).toFixed(3)}%` }}>
                  <em className={s.covPlanned} style={{ height: `${(c.planned / peakCover) * 100}%` }} />
                  <em className={s.covActual} style={{ height: `${(c.actual / peakCover) * 100}%` }} />
                </span>
              ))}
              {dayLines}
              {nowLine}
            </div>
          </div>
        </div>
      </div>

      {/* a full EmptyState block here squeezed the grid down to five visible rows — and the grid
          is not empty, it is a ready-to-use form. One line under it says the same thing. */}
      {nothingPlanned && <p className={s.emptyNote}><Icon id="clock" />{Z.emptyTitle}</p>}

      {/* three states, in the order they happen: what somebody OFFERS, what we ASSIGNED from it,
          and what actually HAPPENED. The first two flip on a bar tap; the third comes from the
          Anwesenheit and is never written here. */}
      <p className={s.legend}>
        <span className={cx(s.swatch, s.plannedBar)} /> {Z.available}
        <span className={cx(s.swatch, s.plannedBar, s.confirmedBar)} /> {Z.confirmed}
        <span className={cx(s.swatch, s.actual)} /> {Z.actual}
        <span className={s.legendHint}>{Z.laneHint}</span>
      </p>

      {person && (
        <PersonSheet
          person={person}
          shifts={shiftsFor(shifts, person.id)}
          blocks={intervalsOf(attendance[person.id])}
          canEdit={canEdit}
          startedAt={startedAt}
          conflicts={conflicts}
          onAdd={onAdd}
          onSetTime={onSetTime}
          onToggle={(sh) => onReplace({ ...sh, confirmed: !sh.confirmed })}
          onRemove={onRemove}
          onClose={() => setOpenPerson(null)}
        />
      )}
    </div>
  )
}
