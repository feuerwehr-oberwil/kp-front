import { useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm } from '../lib/format'
import { applyTimeToIso, isoOnDay } from '../lib/abschluss'
import { cx } from '../lib/cx'
import { rankAbbr, rankLabel } from '../lib/rank'
import { fmtCount, fmtDayShort, incidentDays, isOtherDay } from '../lib/zeitplanFormat'
import {
  bandCellState, bandCounts, conflictingShiftIds, draftBand, freehandShifts, shiftInBand, sortBands,
} from '../lib/shifts'
import type { Person, Shift, ShiftBand } from '../types'
import { Sheet } from '../lib/overlays'
import { TimeField } from './TimeField'
import { EmptyState } from './EmptyState'
import s from './BandGrid.module.css'

const clock = (iso: string): string => {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? hhmm(d) : ''
}

/** «07:00–12:00» → «07–12» where both ends sit on the hour; the grid head has room for one line. */
function fmtRange(from: string, to: string): string {
  const a = new Date(from)
  const b = new Date(to)
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return ''
  const short = (d: Date) => (d.getMinutes() === 0 ? String(d.getHours()).padStart(2, '0') : hhmm(d))
  return `${short(a)}–${short(b)}`
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
  const days = incidentDays(startedAt, Math.max(openedAt, Date.parse(to) || 0))
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
              if (iso) setFrom(iso)
            }} />
          {startedAt && isOtherDay(new Date(from), new Date(startedAt)) && (
            <span className={s.day}>{fmtDayShort(new Date(from))}</span>
          )}
        </span>
        <span className={s.sep} aria-hidden>–</span>
        <span className={s.field}>
          <span className={s.fieldLabel}>{appConfig.copy.zeitplan.to}</span>
          <TimeField ariaLabel={`${appConfig.copy.zeitplan.to} – ${subject}`} value={clock(to)} days={days}
            onCommit={(v, day) => {
              if (!v) return
              // «Nacht 22–06»: a bis before the von runs past midnight, it does not run backwards
              const iso = day ? isoOnDay(day, v) : applyTimeToIso(to, v, { nextDayIfBefore: from })
              if (iso) setTo(iso)
            }} />
          {isOtherDay(new Date(to), new Date(from)) && <span className={s.day}>{fmtDayShort(new Date(to))}</span>}
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
 * Membership is STORED (Shift.bandId), never derived from matching times. Everything that reads
 * odd about this grid follows from that one rule: a new band is empty for everybody, including
 * people who already hold exactly its hours freihändig; a shift dragged off the band's times on
 * the axis stays in its column, hatched, showing its real hours; and deleting a band leaves every
 * one of its shifts standing.
 */
export function BandGrid({
  people, shifts, bands, canEdit, startedAt, onCreateBand, onSaveBand, onRemoveBand, onCycleCell,
}: {
  /** already filtered + ordered by the shared Anwesenheit header, so all three views read alike */
  people: Person[]
  shifts: Shift[]
  bands: ShiftBand[]
  canEdit: boolean
  startedAt: string | null
  onCreateBand: (label: string, from: string, to: string) => void
  /** rename + re-time in one commit; the re-time asks about dragging assigned people along */
  onSaveBand: (id: string, label: string, from: string, to: string) => void
  onRemoveBand: (id: string) => void
  onCycleCell: (band: ShiftBand, person: Person) => void
}) {
  const S = appConfig.copy.schichten
  /** null = closed · 'new' = the create sheet · a band = its edit sheet */
  const [sheet, setSheet] = useState<'new' | ShiftBand | null>(null)
  const cols = useMemo(() => sortBands(bands), [bands])
  const conflicts = useMemo(() => conflictingShiftIds(shifts), [shifts])

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
      <div className={s.scroll}>
        {/* --bands drives the grid's own width: at three columns it is exactly the port and the
            cells share it out; from the fourth the minimum cell width wins and the surface scrolls
            sideways instead of squeezing cells under the thumb floor. */}
        <div className={s.grid} style={{ ['--bands' as string]: cols.length }}>
          <div className={cx(s.row, s.headRow)}>
            <div className={cx(s.who, s.whoHead)}>{S.who}</div>
            {cols.map((b) => {
              const c = bandCounts(shifts, b)
              return (
                <button key={b.id} type="button" className={s.band} disabled={!canEdit}
                  onClick={() => setSheet(b)} title={bandTitle(b)}
                  aria-label={`${bandTitle(b)} · ${fillTemplate(S.countsAria, { available: fmtCount(c.available), planned: fmtCount(c.confirmed) })}`}>
                  <b>{bandTitle(b)}</b>
                  {/* only when the label is a real name — otherwise the head would say its own
                      hours twice */}
                  {b.label.trim() && <i>{fmtRange(b.from, b.to)}</i>}
                  {/* The two numbers the Deckung curve exists for once time is continuous. There is
                      deliberately no target beside them: a Soll/Ist column invites filling a
                      number rather than asking who can actually come. */}
                  <span className={s.counts}>
                    <span className={s.cntAvailable}>{fmtCount(c.available)}</span>
                    <span className={s.cntConfirmed}>{fmtCount(c.confirmed)}</span>
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
            const own = freehandShifts(shifts, p.id)
            return (
              <div key={p.id} className={s.row}>
                <div className={s.who}>
                  {/* rank + name are ONE line, always: they identify the same person, and on a
                      112px phone column a bare wrap put the badge above the name and made that
                      row a head taller than its neighbours for no information at all */}
                  <span className={s.whoMain}>
                    {p.rank && <span className={s.rank} title={rankLabel(p.rank)}>{rankAbbr(p.rank)}</span>}
                    <span className={s.name}>{p.displayName}</span>
                  </span>
                  {/* Somebody who drew 09–14 on the axis belongs to no column, so every cell of
                      theirs is empty — indistinguishable from somebody who has offered nothing at
                      all. The mark carries the real time, so the grid never claims they are free. */}
                  {own.length > 0 && (
                    <span className={s.ownTimes}
                      title={fillTemplate(S.ownTimes, { times: own.map((x) => fmtRange(x.from, x.to)).join(' · ') })}>
                      {own.length > 1
                        ? fillTemplate(S.ownTimesMore, { first: fmtRange(own[0].from, own[0].to), n: own.length - 1 })
                        : fmtRange(own[0].from, own[0].to)}
                    </span>
                  )}
                </div>
                {cols.map((b) => {
                  const sh = shiftInBand(shifts, p.id, b.id)
                  const state = bandCellState(sh, b)
                  const bad = !!sh && conflicts.has(sh.id)
                  const deviating = state === 'deviating'
                  return (
                    <button key={b.id} type="button" disabled={!canEdit}
                      className={cx(s.cell,
                        (state === 'available' || (deviating && !sh?.confirmed)) && s.cellAvailable,
                        (state === 'confirmed' || (deviating && sh?.confirmed)) && s.cellConfirmed,
                        deviating && s.cellDeviating, bad && s.cellConflict)}
                      onClick={() => onCycleCell(b, p)}
                      title={bad ? S.conflict
                        : deviating && sh
                          ? fillTemplate(S.deviating, {
                            name: p.displayName, from: clock(sh.from), to: clock(sh.to),
                            bandFrom: clock(b.from), bandTo: clock(b.to),
                          })
                          : fillTemplate(S.cellAria, { name: p.displayName, band: bandTitle(b) })}
                      aria-label={fillTemplate(S.cellAria, { name: p.displayName, band: bandTitle(b) })}
                      aria-pressed={state !== 'empty'}>
                      {bad && <Icon id="warn" />}
                      {/* A deviating cell says its OWN hours: that is the whole information it
                          carries. An on-band cell has nothing to add beyond its state, so it says
                          the state — the words the Zeitplan uses for the same two things. */}
                      {deviating && sh
                        ? fmtRange(sh.from, sh.to)
                        : state === 'confirmed' ? S.confirmed : state === 'available' ? S.available : ''}
                    </button>
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
    </div>
  )
}
