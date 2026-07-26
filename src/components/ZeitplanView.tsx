import { useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm } from '../lib/format'
import { applyTimeToIso } from '../lib/abschluss'
import { cx } from '../lib/cx'
import { rankAbbr, rankLabel } from '../lib/rank'
import { intervalsOf } from '../lib/attendanceIntervals'
import { Sheet } from '../lib/overlays'
import {
  SLOT_MS, barGeometry, conflictingShiftIds, coverage, intervalSpan, shiftSpan, shiftsFor, timelineSpan,
} from '../lib/shifts'
import type { AttendanceState, Person, PresenceInterval, Shift } from '../types'
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
  onAdd, onSetTime, onRemove, onPrint, onDownload, printOnline,
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
  onSetTime: (id: string, patch: { from?: string; to?: string }) => void
  onRemove: (id: string, personName: string) => void
  /** hand the sheet to the printer / the download — absent when neither is reachable */
  onPrint?: () => void
  onDownload?: () => void
  /** the station relay is configured AND its agent is alive */
  printOnline?: boolean
}) {
  const Z = appConfig.copy.zeitplan // read per-render so the resolved locale applies
  const P = appConfig.copy.printRelay
  const [openPerson, setOpenPerson] = useState<string | null>(null)

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

  return (
    <div className={s.zeitplan}>
      <div className={s.scroll}>
        <div className={s.grid} style={{ ['--track-w' as string]: `${trackW}px` }}>
          {/* head — «Wer» over the name column, the clock over the track, exactly as on paper */}
          <div className={cx(s.row, s.headRow)}>
            <div className={cx(s.who, s.whoHead)}>{Z.who}</div>
            <div className={s.track}>
              {hours.map((h) => <span key={h.at} className={s.tick} style={{ left: pct(h.at) }}>{h.label}</span>)}
              {nowInside && <span className={cx(s.nowLine, s.nowLineHead)} style={{ left: pct(nowMs) }}><em>{Z.now}</em></span>}
            </div>
          </div>

          {people.map((p) => {
            const mine = shiftsFor(shifts, p.id)
            const blocks = intervalsOf(attendance[p.id])
            return (
              <div key={p.id} className={cx(s.row, mine.length > 0 && s.rowPlanned)}>
                <div className={s.who}>
                  <span className={s.whoName}>
                    {p.rank && <span className={s.rank} title={rankLabel(p.rank)}>{rankAbbr(p.rank)}</span>}
                    <span className={s.name}>{p.displayName}</span>
                  </span>
                  {/* One shift edits inline — the common case, and it deserves no extra tap. From
                      the second on, two more chips beside a name turn the row into a puzzle, so
                      they collapse into a single button onto that person's sheet. */}
                  {mine.length > 1 ? (
                    <button type="button" className={cx(s.countBtn, mine.some((x) => conflicts.has(x.id)) && s.countConflict)}
                      onClick={() => setOpenPerson(p.id)}>
                      {fillTemplate(Z.shiftCount, { n: mine.length })}<Icon id="chevron" />
                    </button>
                  ) : mine.length === 1 ? (
                    <ShiftChips sh={mine[0]} name={p.displayName} canEdit={canEdit}
                      conflict={conflicts.has(mine[0].id)} onSetTime={onSetTime} onRemove={onRemove} />
                  ) : null}
                  {canEdit && (
                    <button type="button" className={s.add} title={fillTemplate(Z.addFor, { name: p.displayName })}
                      aria-label={fillTemplate(Z.addFor, { name: p.displayName })}
                      // adding a SECOND shift lands straight in the sheet, where there is room for it
                      onClick={() => { onAdd(p); if (mine.length >= 1) setOpenPerson(p.id) }}>
                      <Icon id="plus" />
                    </button>
                  )}
                </div>
                <div className={cx(s.track, s.lane)}>
                  {/* executed presence first, so a planned outline drawn over it stays readable */}
                  {blocks.map((iv, i) => {
                    const sp = intervalSpan(iv, nowMs)
                    const st = sp && barStyle(sp.from, sp.to)
                    return st ? (
                      <span key={`a${i}`} className={cx(s.bar, s.actual, !iv.to && s.open)} style={st}
                        title={`${Z.actual}: ${clock(iv.from)}–${iv.to ? clock(iv.to) : ''}`} />
                    ) : null
                  })}
                  {mine.map((sh) => {
                    const sp = shiftSpan(sh)
                    const st = sp && barStyle(sp.from, sp.to)
                    return st ? (
                      <span key={sh.id} className={cx(s.bar, s.plannedBar, conflicts.has(sh.id) && s.conflict)} style={st}
                        title={conflicts.has(sh.id) ? Z.conflict : `${Z.planned}: ${clock(sh.from)}–${clock(sh.to)}`} />
                    ) : null
                  })}
                  {nowLine}
                </div>
              </div>
            )
          })}

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

      <div className={s.foot}>
        <p className={s.legend}>
          <span className={cx(s.swatch, s.plannedBar)} /> {Z.planned}
          <span className={cx(s.swatch, s.actual)} /> {Z.actual}
        </p>
        {/* the sheet on paper: hang it at the front, hand it to the relief */}
        {(onDownload || onPrint) && (
          <span className={s.footActions}>
            {onPrint && (
              /* same idiom as the Rapport's «An Stationsdrucker»: a heartbeat dot rather than a
                 hidden button, so the relay is honest about being offline */
              <button type="button" className="btn" onClick={onPrint} title={printOnline ? P.online : P.offline}>
                <span className={`dot print-relay-dot${printOnline ? ' online' : ''}`} aria-hidden />
                {P.send}
              </button>
            )}
            {onDownload && (
              <button type="button" className="btn ghost" onClick={onDownload}>
                <Icon id="doc" />{Z.pdf}
              </button>
            )}
          </span>
        )}
      </div>

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
