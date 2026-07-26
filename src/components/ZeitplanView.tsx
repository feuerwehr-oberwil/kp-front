import { useMemo } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm } from '../lib/format'
import { applyTimeToIso } from '../lib/abschluss'
import { cx } from '../lib/cx'
import { rankAbbr, rankLabel } from '../lib/rank'
import { intervalsOf } from '../lib/attendanceIntervals'
import {
  SLOT_MS, barGeometry, conflictingShiftIds, coverage, intervalSpan, shiftSpan, shiftsFor, timelineSpan,
} from '../lib/shifts'
import type { AttendanceState, Person, Shift } from '../types'
import { TimeField } from './TimeField'
import { EmptyState } from './EmptyState'
import s from './Zeitplan.module.css'

const HOUR = 3_600_000

const clock = (iso?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? hhmm(d) : ''
}

/**
 * Schichtenplanung — the BGV/KKO «Zeitplan» Führungsformular as a live surface: rows are the
 * Mannschaft, columns are time.
 *
 * Two bars share every row. The HOLLOW one is what was planned; the FILLED one is the presence
 * actually recorded (lib/attendanceIntervals). Nothing here writes attendance — the plan is a
 * plan — so the two drift apart on purpose, and seeing that drift is the point: planned until
 * 22:00, actually gone at 20:00. Under the rows, the coverage strip answers the question a wall
 * of bars cannot: where is the hole at 02:00.
 */
export function ZeitplanView({ people, attendance, shifts, canEdit, startedAt, nowMs, onAdd, onSetTime, onRemove }: {
  /** already filtered + ordered by the shared Anwesenheit header, so both views read alike */
  people: Person[]
  attendance: AttendanceState
  shifts: Shift[]
  canEdit: boolean
  startedAt: string | null
  /** ticked by the parent — the «now» line and the growing open bar move with it */
  nowMs: number
  onAdd: (p: Person) => void
  onSetTime: (id: string, patch: { from?: string; to?: string }) => void
  onRemove: (id: string, personName: string) => void
}) {
  const Z = appConfig.copy.zeitplan // read per-render so the resolved locale applies

  const span = useMemo(
    () => timelineSpan(startedAt, shifts, attendance, nowMs),
    [startedAt, shifts, attendance, nowMs],
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
  const nothingPlanned = shifts.length === 0

  return (
    <div className={s.zeitplan}>
      {/* the axis head scrolls together with the rows (one scroll container), so a label always
          sits above its own column */}
      <div className={s.scroll}>
        <div className={s.track} style={{ width: `${Math.max(100, ((span.to - span.from) / HOUR) * 68)}px` }}>
          <div className={s.head}>
            {hours.map((h) => (
              <span key={h.at} className={s.tick} style={{ left: pct(h.at) }}>{h.label}</span>
            ))}
            {nowInside && <span className={cx(s.nowLine, s.nowLineHead)} style={{ left: pct(nowMs) }}><em>{Z.now}</em></span>}
          </div>

          <div className={s.rows}>
            {nowInside && <span className={s.nowLine} style={{ left: pct(nowMs) }} aria-hidden />}
            {people.map((p) => {
              const mine = shiftsFor(shifts, p.id)
              const blocks = intervalsOf(attendance[p.id])
              return (
                <div key={p.id} className={s.lane}>
                  {/* executed presence first, so a planned bar drawn over it stays readable */}
                  {blocks.map((iv, i) => {
                    const sp = intervalSpan(iv, nowMs)
                    const g = sp && barGeometry(sp.from, sp.to, span)
                    if (!g) return null
                    return (
                      <span
                        key={`a${i}`}
                        className={cx(s.bar, s.actual, !iv.to && s.open)}
                        style={{ left: `${g.left * 100}%`, width: `${g.width * 100}%` }}
                        title={`${Z.actual}: ${clock(iv.from)}–${iv.to ? clock(iv.to) : ''}`}
                      />
                    )
                  })}
                  {mine.map((sh) => {
                    const sp = shiftSpan(sh)
                    const g = sp && barGeometry(sp.from, sp.to, span)
                    if (!g) return null
                    return (
                      <span
                        key={sh.id}
                        className={cx(s.bar, s.plannedBar, conflicts.has(sh.id) && s.conflict)}
                        style={{ left: `${g.left * 100}%`, width: `${g.width * 100}%` }}
                        title={conflicts.has(sh.id) ? Z.conflict : `${Z.planned}: ${clock(sh.from)}–${clock(sh.to)}`}
                      />
                    )
                  })}
                </div>
              )
            })}
          </div>

          {/* coverage: planned above, actually there below — the future half of the lower strip
              stays empty on purpose, nobody knows yet who will turn up */}
          <div className={s.coverage} title={Z.coverageHint}>
            {slots.map((c) => (
              <span key={c.at} className={s.cov} style={{ left: pct(c.at), width: `${((SLOT_MS / (span.to - span.from)) * 100).toFixed(3)}%` }}>
                <em className={s.covPlanned} style={{ height: `${(c.planned / peakCover) * 100}%` }} />
                <em className={s.covActual} style={{ height: `${(c.actual / peakCover) * 100}%` }} />
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* the editable side: one row per person, von/bis as the same time chips the Anwesenheit
          uses. Deliberately NOT drag-on-the-axis — with gloves on a moving tablet, typing the
          two times is the reliable move; the bars above are the read-out. */}
      <div className={s.list}>
        {nothingPlanned && (
          <EmptyState icon="clock" title={Z.emptyTitle} sub={Z.emptyHint} />
        )}
        {people.map((p) => {
          const mine = shiftsFor(shifts, p.id)
          return (
            <div key={p.id} className={cx(s.row, mine.length > 0 && s.rowPlanned)}>
              <div className={s.who}>
                {p.rank && <span className={s.rank} title={rankLabel(p.rank)}>{rankAbbr(p.rank)}</span>}
                <span className={s.name}>{p.displayName}</span>
              </div>
              <div className={s.blocks}>
                {mine.map((sh) => (
                  <span key={sh.id} className={cx(s.chipPair, conflicts.has(sh.id) && s.chipConflict)}>
                    <TimeField
                      className={s.time}
                      ariaLabel={`${Z.from} – ${p.displayName}`}
                      value={clock(sh.from)}
                      disabled={!canEdit}
                      onCommit={(v) => {
                        const iso = v ? applyTimeToIso(sh.from, v) : null
                        if (iso) onSetTime(sh.id, { from: iso })
                      }}
                    />
                    <span className={s.dash}>–</span>
                    <TimeField
                      className={s.time}
                      ariaLabel={`${Z.to} – ${p.displayName}`}
                      value={clock(sh.to)}
                      disabled={!canEdit}
                      onCommit={(v) => {
                        // a bis before the von means the shift runs past midnight, not backwards
                        const iso = v ? applyTimeToIso(sh.to, v, { nextDayIfBefore: sh.from }) : null
                        if (iso) onSetTime(sh.id, { to: iso })
                      }}
                    />
                    {canEdit && (
                      <button type="button" className={s.del} title={Z.remove}
                        aria-label={`${Z.remove} – ${p.displayName}`} onClick={() => onRemove(sh.id, p.displayName)}>
                        <Icon id="close" />
                      </button>
                    )}
                  </span>
                ))}
                {canEdit && (
                  <button type="button" className={s.add} title={fillTemplate(Z.addFor, { name: p.displayName })}
                    aria-label={fillTemplate(Z.addFor, { name: p.displayName })} onClick={() => onAdd(p)}>
                    <Icon id="plus" />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <p className={s.legend}>
        <span className={cx(s.swatch, s.plannedBar)} /> {Z.planned}
        <span className={cx(s.swatch, s.actual)} /> {Z.actual}
      </p>
    </div>
  )
}
