import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import type { AttendanceState, Person, PresenceInterval, Shift } from '../types'
import { cx } from '../lib/cx'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { applyTimeToIso } from '../lib/abschluss'
import { rankAbbr, rankLabel, rankOrder } from '../lib/rank'
import { intervalsOf, isPresent } from '../lib/attendanceIntervals'
import { fmtDayShort, isOtherDay } from '../lib/zeitplanFormat'
import { loadPrefs, savePrefs } from '../lib/prefs'
import { CaptureUsageChip, type CaptureUsage } from './CaptureUsageChip'
import { Segmented } from './Segmented'
import { TimeBlockSheet } from './TimeBlockSheet'
import { timeBlockLabels } from '../lib/timeBlockLabels'
import { EmptyState } from './EmptyState'
import { ZeitplanView } from './ZeitplanView'
import s from './Anwesenheit.module.css'

/** Zeitraum stops for the Zeitplan axis, in hours — from one watch to a four-day deployment. */
const HORIZONS = [3, 6, 9, 12, 18, 24, 36, 48, 72, 96]

/** sentinel value for the «Alle» segment of the rank filter (no real rank uses it) */
const RANK_ALL = '__all__'

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
function PresenceSheet({ person, blocks, canEdit, startedAt, onSetTimes, onBack, onClose }: {
  person: Person
  blocks: PresenceInterval[]
  canEdit: boolean
  /** incident alarm time — drives the day labels and the «ab Beginn» shortcut */
  startedAt?: string | null
  onSetTimes?: (personId: string, patch: { from?: string; to?: string }, index?: number) => void
  onBack: () => void
  onClose: () => void
}) {
  const A = appConfig.copy.anwesenheit
  const open = blocks.length > 0 && !blocks[blocks.length - 1].to
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
      blocks={blocks.map((iv, i) => ({
        key: String(i),
        from: toHM(iv.from),
        to: iv.to ? toHM(iv.to) : undefined,
        openLabel: A.stillHere,
        // mirror of onTo: a von typed after the bis means the block STARTED the previous day
        onFrom: canEdit && onSetTimes ? (v) => { const iso = applyTimeToIso(iv.from, v, { prevDayIfAfter: iv.to }); if (iso) onSetTimes(person.id, { from: iso }, i) } : undefined,
        // on a multi-day Einsatz the clock alone does not say which day this block belongs to
        dayLabel: startedAt && isOtherDay(new Date(iv.from), new Date(startedAt)) ? fmtDayShort(new Date(iv.from)) : undefined,
        onFromStart: canEdit && onSetTimes && startedAt && iv.from !== startedAt
          ? () => onSetTimes(person.id, { from: startedAt }, i) : undefined,
        onTo: canEdit && onSetTimes && iv.to ? (v) => { const iso = applyTimeToIso(iv.to!, v, { nextDayIfBefore: iv.from }); if (iso) onSetTimes(person.id, { to: iso }, i) } : undefined,
      }))}
    />
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
  onMarkPresent, onMarkLeft, onClear, onJumpToTrupp, onReload, onSetTimes, captureUsage,
  shifts, startedAt, onAddShift, onAddShiftSpan, onReplaceShift, onSetShiftTime, onRemoveShift,
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
  /** QR self-reporting in use — «QR: N Einträge · zuletzt HH:MM» chip (informational) */
  captureUsage?: CaptureUsage | null
  /** Schichtenplanung — the second view of this same Mannschaft (see ZeitplanView) */
  shifts?: Shift[]
  startedAt?: string | null
  onAddShift?: (p: Person) => void
  /** plan exactly the stretch swept out on the grid */
  onAddShiftSpan?: (p: Person, from: number, to: number) => void
  /** a whole shift replaced after a drag */
  onReplaceShift?: (sh: Shift) => void
  onSetShiftTime?: (id: string, patch: { from?: string; to?: string }) => void
  onRemoveShift?: (id: string, personName: string) => void
  /** print / download the Zeitplan-Führungsformular (rendered server-side) */
  onPrintZeitplan?: (people: Person[]) => void
  onDownloadZeitplan?: (people: Person[]) => void
  zeitplanPrintOnline?: boolean
}) {
  const [q, setQ] = useState('')
  const [rankFilter, setRankFilter] = useState<string | null>(null)
  // Anwesenheit and Zeitplan are two readings of the SAME filtered, ordered Mannschaft — the
  // search + rank filter above apply to both, so a name sits in the same place in either view.
  const [view, setView] = useState<'list' | 'plan'>(() => loadPrefs().anwesenheitView ?? 'list')
  const pickView = (v: 'list' | 'plan') => { setView(v); savePrefs({ ...loadPrefs(), anwesenheitView: v }) }
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
  useEffect(() => {
    if (view !== 'plan') return
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [view])
  // person whose time chip is open as an inline <input type="time">
  const [editing, setEditing] = useState<string | null>(null)
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

  const blocksPerson = people.find((p) => p.id === blocksFor)
  const empty = !people.length
  const planAvailable = !!shifts && !!onAddShift && !!onAddShiftSpan && !!onReplaceShift && !!onSetShiftTime && !!onRemoveShift
  const showPlan = planAvailable && view === 'plan'

  return (
    <div className={s.surface}>
      <header className={s.head}>
        <div className={s.headTitles}>
          <h2>{A.title}</h2>
          <p>{fillTemplate(A.summary, { present: counts.present, left: counts.left, total: counts.total })}</p>
        </div>
        <div className={s.headActions}>
          <CaptureUsageChip usage={captureUsage} />
          {/* the Zeitplan's paper output belongs with the other surface actions, not buried under
              the grid — same place the Mittel view keeps its own controls */}
          {showPlan && onPrintZeitplan && (
            <button className="btn" onClick={() => onPrintZeitplan(rows)}
              title={zeitplanPrintOnline ? appConfig.copy.printRelay.online : appConfig.copy.printRelay.offline}>
              <span className={`dot print-relay-dot${zeitplanPrintOnline ? ' online' : ''}`} aria-hidden />
              {appConfig.copy.printRelay.send}
            </button>
          )}
          {showPlan && onDownloadZeitplan && (
            <button className="btn ghost" onClick={() => onDownloadZeitplan(rows)}>
              <Icon id="doc" />{appConfig.copy.zeitplan.pdf}
            </button>
          )}
          {/* the two readings of this Mannschaft. Only offered where a Zeitplan can actually be
              edited/read — the surface is inert without the shift slice wired up. */}
          {!empty && planAvailable && (
            <Segmented<'list' | 'plan'> ariaLabel={A.viewLabel} value={view} onChange={pickView}
              options={[{ value: 'list', label: A.viewList }, { value: 'plan', label: A.viewPlan }]} />
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
          {view === 'list' && (
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
              <button type="button" className={s.zoomBtn} onClick={() => stepHorizon(1)}
                disabled={horizonH >= HORIZONS[HORIZONS.length - 1]} aria-label={appConfig.copy.zeitplan.zoomOut}><Icon id="plus" /></button>
            </div>
          )}
        </div>
      )}

      {!empty && ranksPresent.length > 1 && (
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
            // the time this row shows belongs to the CURRENT block: its arrival while anwesend,
            // its departure once gegangen — tap the chip to correct a wrong auto-stamped time.
            // Someone who came back is on their second block, so the chip follows them there.
            const blocks = intervalsOf(a)
            const bi = blocks.length - 1
            const cur = blocks[bi]
            const timeIso = left ? cur?.to : present ? cur?.from : undefined
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
                {timeIso && (editing === p.id && onSetTimes ? (
                  <input
                    type="time"
                    className={s.timeInput}
                    autoFocus
                    value={toHM(timeIso)}
                    aria-label={A.editTime}
                    onChange={(e) => {
                      const iso = e.target.value
                        ? applyTimeToIso(timeIso, e.target.value, left ? { nextDayIfBefore: cur?.from } : undefined)
                        : null
                      if (iso) onSetTimes(p.id, left ? { to: iso } : { from: iso }, bi)
                    }}
                    onBlur={() => setEditing(null)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  />
                ) : (
                  <button
                    type="button"
                    className={cx(s.timeChip, left && s.timeChipLeft)}
                    disabled={!canEdit || !onSetTimes}
                    title={A.editTime}
                    aria-label={`${A.editTime} – ${p.displayName}`}
                    onClick={() => setEditing(p.id)}
                  >
                    {left ? `${A.weg} ${toHM(timeIso)}` : toHM(timeIso)}
                  </button>
                ))}
                {/* Rückkehr — the tap cycle's third step CLEARS the row (frei), and it must keep
                    doing that (it is the only way back from a mis-tick). So coming back gets its
                    own control: it opens a NEW block instead of reopening the closed one. */}
                {canEdit && blocks.length > 0 && (
                  /* opens the person's blocks. Gated on `left` before, which locked out exactly
                     the person this sheet was built for — somebody who came BACK is present, and
                     their earlier blocks were then unreachable. */
                  <button
                    type="button"
                    className={s.backBtn}
                    title={fillTemplate(A.openBlocks, { name: p.displayName })}
                    aria-label={fillTemplate(A.openBlocks, { name: p.displayName })}
                    onClick={() => setBlocksFor(p.id)}
                  >
                    <Icon id={left ? 'plus' : 'clock'} />
                  </button>
                )}
                {/* someone with more than one block: say so, else the single chip reads as the
                    whole story when it is only the latest block */}
                {blocks.length > 1 && (
                  <button type="button" className={s.blocks} onClick={() => setBlocksFor(p.id)}
                    title={fillTemplate(A.blockCount, { n: blocks.length })}
                    aria-label={fillTemplate(A.openBlocks, { name: p.displayName })}>
                    {blocks.length}×
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {blocksPerson && (
        <PresenceSheet
          person={blocksPerson}
          blocks={intervalsOf(attendance[blocksPerson.id])}
          canEdit={canEdit}
          startedAt={startedAt}
          onSetTimes={onSetTimes}
          /* stays open: the new block appears in the list you are looking at, so a mis-tap is
             seen and can be corrected on the spot */
          onBack={() => onMarkPresent(blocksPerson)}
          onClose={() => setBlocksFor(null)}
        />
      )}
    </div>
  )
}
