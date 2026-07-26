import { useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm } from '../lib/format'
import { applyTimeToIso } from '../lib/abschluss'
import { cx } from '../lib/cx'
import { rankAbbr, rankLabel } from '../lib/rank'
import { intervalsOf } from '../lib/attendanceIntervals'
import { Sheet } from '../lib/overlays'
import { useLaneGesture } from '../lib/useLaneGesture'
import {
  SLOT_MS, barGeometry, conflictingShiftIds, coverage, intervalSpan, shiftAt, shiftSpan, shiftsFor, timelineSpan,
} from '../lib/shifts'
import type { AttendanceState, Person, PresenceInterval, Shift } from '../types'
import type { Span } from '../lib/shifts'
import { TimeField } from './TimeField'
import { EmptyState } from './EmptyState'
import s from './Zeitplan.module.css'

const HOUR = 3_600_000
/** px per hour of axis — wide enough that a half-hour block is still a visible bar */
const PX_PER_HOUR = 68

const clock = (iso?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? hhmm(d) : ''
}

/** von/bis pair for one shift — the same 24h TimeField the Anwesenheit and the Rapport use. */
function ShiftChips({ sh, name, canEdit, conflict, onSetTime, onRemove }: {
  sh: Shift
  name: string
  canEdit: boolean
  conflict: boolean
  onSetTime: (id: string, patch: { from?: string; to?: string }) => void
  onRemove: (id: string, personName: string) => void
}) {
  const Z = appConfig.copy.zeitplan
  return (
    <span className={cx(s.chipPair, conflict && s.chipConflict)}>
      <TimeField
        className={s.time} ariaLabel={`${Z.from} – ${name}`} value={clock(sh.from)} disabled={!canEdit}
        onCommit={(v) => { const iso = v ? applyTimeToIso(sh.from, v) : null; if (iso) onSetTime(sh.id, { from: iso }) }}
      />
      <span className={s.dash}>–</span>
      <TimeField
        className={s.time} ariaLabel={`${Z.to} – ${name}`} value={clock(sh.to)} disabled={!canEdit}
        // a bis before the von means the shift runs past midnight, not backwards
        onCommit={(v) => { const iso = v ? applyTimeToIso(sh.to, v, { nextDayIfBefore: sh.from }) : null; if (iso) onSetTime(sh.id, { to: iso }) }}
      />
      {canEdit && (
        <button type="button" className={s.del} title={Z.remove} aria-label={`${Z.remove} – ${name}`}
          onClick={() => onRemove(sh.id, name)}><Icon id="close" /></button>
      )}
    </span>
  )
}

/**
 * Everything about ONE person's time, opened from their row once a second shift makes the inline
 * chips unreadable. Both halves live here — the availability we PLAN (editable) and the presence
 * that actually HAPPENED (read-only: it is the record, and it is ticked in the Anwesenheit list).
 */
function PersonSheet({ person, shifts, blocks, canEdit, conflicts, nowMs, onAdd, onSetTime, onRemove, onClose }: {
  person: Person
  shifts: Shift[]
  blocks: PresenceInterval[]
  canEdit: boolean
  conflicts: Set<string>
  nowMs: number
  onAdd: (p: Person) => void
  onSetTime: (id: string, patch: { from?: string; to?: string }) => void
  onRemove: (id: string, personName: string) => void
  onClose: () => void
}) {
  const Z = appConfig.copy.zeitplan
  return (
    <Sheet open onClose={onClose} fit sheetClassName={s.sheet}
      title={fillTemplate(Z.editTitle, { name: person.displayName })}
      footer={<button type="button" className="ip-btn primary" onClick={onClose}>{Z.done}</button>}
    >
      <div className={s.sheetGroup}>
        <h4 className={s.sheetTitle}>{Z.plannedSection}</h4>
        {shifts.length === 0 && <p className={s.sheetNote}>{Z.plannedNone}</p>}
        {shifts.map((sh) => (
          <div key={sh.id} className={s.sheetRow}>
            <ShiftChips sh={sh} name={person.displayName} canEdit={canEdit}
              conflict={conflicts.has(sh.id)} onSetTime={onSetTime} onRemove={onRemove} />
            {conflicts.has(sh.id) && <span className={s.sheetWarn}><Icon id="warn" />{Z.conflict}</span>}
          </div>
        ))}
        {canEdit && (
          <button type="button" className={cx('btn', 'ghost', s.sheetAdd)} onClick={() => onAdd(person)}>
            <Icon id="plus" />{Z.addShift}
          </button>
        )}
      </div>

      <div className={s.sheetGroup}>
        <h4 className={s.sheetTitle}>{Z.actualSection}</h4>
        {blocks.length === 0 ? (
          <p className={s.sheetNote}>{Z.actualNone}</p>
        ) : (
          <ul className={s.sheetActual}>
            {blocks.map((iv, i) => (
              <li key={i}>
                <b>{clock(iv.from)} – {iv.to ? clock(iv.to) : clock(new Date(nowMs).toISOString())}</b>
                {!iv.to && <em>{Z.stillHere}</em>}
              </li>
            ))}
          </ul>
        )}
        <p className={s.sheetNote}>{Z.actualHint}</p>
      </div>
    </Sheet>
  )
}

/**
 * One person's line: the name, and their own lane of time.
 *
 * The lane is worked directly, the way the paper form is filled in — tap to plan, tap a bar to
 * drop it, drag to move or stretch it, press and hold for the sheet (see lib/useLaneGesture).
 * That is why the row carries no «+» and no time chips any more: they crowded the name out and
 * put every edit two taps away from the thing it edits.
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
      <button type="button" className={s.who} onClick={onOpen}
        aria-label={fillTemplate(Z.openFor, { name: person.displayName })}
        title={fillTemplate(Z.openFor, { name: person.displayName })}>
        {person.rank && <span className={s.rank} title={rankLabel(person.rank)}>{rankAbbr(person.rank)}</span>}
        <span className={s.name}>{person.displayName}</span>
        {shifts.length > 1 && (
          <span className={cx(s.count, shifts.some((x) => conflicts.has(x.id)) && s.countConflict)}>
            {shifts.length}
          </span>
        )}
      </button>
      <div className={cx(s.track, s.lane, canEdit && s.laneEditable)}
        aria-label={fillTemplate(Z.planAt, { name: person.displayName })}
        {...g.laneProps(canEdit)}>
        {/* executed presence first, so a planned outline drawn over it stays readable */}
        {blocks.map((iv, i) => {
          const sp = intervalSpan(iv, nowMs)
          const st = sp && barStyle(sp.from, sp.to)
          return st ? (
            <span key={`a${i}`} className={cx(s.bar, s.actual, !iv.to && s.open)} style={st}
              title={`${Z.actual}: ${clock(iv.from)}–${iv.to ? clock(iv.to) : ''}`} />
          ) : null
        })}
        {/* the stretch currently being swept out, so the sweep is visible while it happens */}
        {g.draw && (() => {
          const st = barStyle(g.draw.from, g.draw.to)
          return st ? <span className={cx(s.bar, s.plannedBar, s.drawing)} style={st} aria-hidden /> : null
        })()}
        {shown.map((sh) => {
          const sp = shiftSpan(sh)
          const st = sp && barStyle(sp.from, sp.to)
          if (!st) return null
          const bad = conflicts.has(sh.id)
          const next = sh.confirmed ? Z.tentative : Z.confirmed
          return (
            <span key={sh.id} className={cx(s.bar, s.plannedBar, sh.confirmed && s.confirmedBar, bad && s.conflict, g.preview?.id === sh.id && s.dragging)}
              style={st} {...(canEdit ? g.barProps(sh, 'move') : {})}
              title={bad ? Z.conflict
                : `${sh.confirmed ? Z.confirmed : Z.tentative}: ${clock(sh.from)}–${clock(sh.to)} · ${fillTemplate(Z.toggleHint, { state: next })}`}>
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
  onAdd, onAddSpan, onReplace, onSetTime, onRemove, horizonH, onHorizon,
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
  /** how many hours the axis shows at once, and the control to change it */
  horizonH: number
  onHorizon: (h: number) => void
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
  const hours = useMemo(() => {
    const out: { at: number; label: string }[] = []
    const first = Math.ceil(span.from / HOUR) * HOUR
    for (let at = first; at < span.to; at += HOUR) out.push({ at, label: hhmm(new Date(at)) })
    return out
  }, [span])

  const pct = (t: number) => `${(((t - span.from) / Math.max(1, span.to - span.from)) * 100).toFixed(3)}%`
  const nowInside = nowMs >= span.from && nowMs <= span.to
  const trackW = Math.max(320, ((span.to - span.from) / HOUR) * PX_PER_HOUR)
  const nothingPlanned = shifts.length === 0
  // the «now» line repeats per lane rather than spanning the whole grid: with a sticky name column
  // a single full-height rule would slide out from under its own coordinates while scrolling
  const nowLine = nowInside ? <span className={s.nowLine} style={{ left: pct(nowMs) }} aria-hidden /> : null

  const person = people.find((p) => p.id === openPerson)

  const barStyle = (from: number, to: number) => {
    const g = barGeometry(from, to, span)
    return g ? { left: `${g.left * 100}%`, width: `${g.width * 100}%` } : null
  }

  const HORIZONS = [6, 12, 24, 48]
  const step = (dir: 1 | -1) => {
    const i = HORIZONS.indexOf(horizonH)
    const next = HORIZONS[Math.min(HORIZONS.length - 1, Math.max(0, (i < 0 ? 1 : i) + dir))]
    onHorizon(next)
  }

  return (
    <div className={s.zeitplan}>
      {/* how far the axis reaches. Scrolling pans through time; this changes how much of it fits
          on screen at once, which is the other half of «where is the hole tonight». */}
      <div className={s.horizon}>
        <span className={s.horizonLabel}>{Z.horizon}</span>
        <button type="button" className={s.zoomBtn} onClick={() => step(-1)}
          disabled={horizonH <= HORIZONS[0]} aria-label={Z.zoomIn}><Icon id="minus" /></button>
        <b className={s.horizonValue}>{horizonH} h</b>
        <button type="button" className={s.zoomBtn} onClick={() => step(1)}
          disabled={horizonH >= HORIZONS[HORIZONS.length - 1]} aria-label={Z.zoomOut}><Icon id="plus" /></button>
      </div>
      <div className={s.scroll}>
        <div className={s.grid} style={{ ['--track-w' as string]: `${trackW}px` }}>
          {/* head — «Wer» over the name column, the clock over the track, exactly as on paper */}
          <div className={cx(s.row, s.headRow)}>
            <div className={cx(s.who, s.whoHead)} aria-hidden />
            <div className={s.track}>
              {hours.map((h) => <span key={h.at} className={s.tick} style={{ left: pct(h.at) }}>{h.label}</span>)}
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
              nowLine={nowLine}
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
              {nowLine}
            </div>
          </div>
        </div>
      </div>

      {nothingPlanned && <EmptyState icon="clock" title={Z.emptyTitle} sub={Z.emptyHint} />}

      <p className={s.legend}>
        <span className={cx(s.swatch, s.plannedBar)} /> {Z.planned}
        <span className={cx(s.swatch, s.actual)} /> {Z.actual}
        <span className={s.legendHint}>{Z.laneHint}</span>
      </p>

      {person && (
        <PersonSheet
          person={person}
          shifts={shiftsFor(shifts, person.id)}
          blocks={intervalsOf(attendance[person.id])}
          canEdit={canEdit}
          conflicts={conflicts}
          nowMs={nowMs}
          onAdd={onAdd}
          onSetTime={onSetTime}
          onRemove={onRemove}
          onClose={() => setOpenPerson(null)}
        />
      )}
    </div>
  )
}
