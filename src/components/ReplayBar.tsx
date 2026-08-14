// Time-travel replay scrubber (audit-trail sub-phase B, PLAN-audit-trail §6).
//
// A read-only past view: a horizontal slider from incident start → now, a draggable
// handle, play/pause with speed, and the Verlauf as a lane of ticks under it. The map
// renders `state_at(handle)` — this component owns the playhead + the fold, and reports
// the reconstructed `Saved` shape (and interpolated vehicle positions) up to App, which
// swaps it in for the live document while replay is active.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { fillTemplate, fmtElapsedHM, fmtSpanShort, formatTime } from '../lib/format'
import { appConfig } from '../config/appConfig'
import { Segmented } from './Segmented'
import s from './ReplayBar.module.css'
import {
  activityMoments, findGaps, fractionAtTime, gapAt, journalMoments, layoutTrack,
  loadReplay, momentAt, segmentsFromGaps, stateAt, stepMoment, timeAtFraction, vehiclesAt,
  type ReplayBundle, type VehicleAt,
} from '../lib/replay'
import type { Saved } from '../lib/workspace'
import type { TimelineEvent } from '../types'

interface Props {
  incidentId: string
  /** incident start (ISO) — slider domain start */
  startedAt: string
  /** reconstructed workspace at the playhead → App renders this instead of live `doc` */
  onState: (ws: Saved | null) => void
  /** interpolated vehicle positions at the playhead (empty when no samples) */
  onVehicles: (v: VehicleAt[]) => void
  /** leave replay → back to live */
  onExit: () => void
  /**
   * The incident's Verlauf — the lane under the track, the caption, and the activity signal
   * that decides where the gaps are.
   * ⚠️ Handed in from the workspace, NOT reconstructed from the past blob. It used to be read
   * out of `stateAt(endMs).timeline`, which since the journal moved to its own append-only
   * store returns the FROZEN LEGACY ECHO — empty on every incident created since (see
   * journalStore · blobTimeline). So the replay believed the Einsatz had no Verlauf at all:
   * no lane, no caption, and gap detection blind to the one kind of activity an operator
   * means by «da ist etwas passiert». The Verlauf is append-only, so the live list IS the
   * finished list — there is nothing to reconstruct.
   */
  journal?: TimelineEvent[]
  /** open the Verlauf at one row — the caption's «im Verlauf» */
  onShowEntry?: (rowId: string) => void
  /**
   * The playhead, for the Verlauf's benefit: rows after it are the future and render dimmed.
   * ⚠️ Fired only when the playhead CROSSES a Verlauf row, not on every frame. At 4× the clock
   * ticks four times a second and this lifts state into App, which re-renders the whole
   * workspace — the shape of the battery bug this app has had once already (see the media-queue
   * commit storm). Row crossings happen a few dozen times in an Einsatz.
   */
  onPlayhead?: (ms: number) => void
  /** hand the seek up so the Verlauf's rows can set the moment (see IncidentWorkspace) */
  seekRef?: React.MutableRefObject<((ms: number) => void) | null>
}

const SPEEDS = [1, 4, 16, 32] as const
const TICK_MS = 250 // playback frame cadence
/** How long the «übersprungen …» note stays up after a jump — long enough to read at a glance,
 *  short enough that it is gone before the next one is due. */
const SKIP_NOTICE_MS = 2500
/** The slice of the track each break gets, whatever its real duration. Wide enough to read as
 *  an interruption and to hold a hit target, narrow enough that the work keeps the bar. */
const GAP_FRAC = 0.07
/** A break narrower than this cannot hold «1 h 32 min» without running into its neighbours —
 *  measured against the longest label the formatter produces, plus a little air. */
const BREAK_LABEL_MIN_PX = 64
/** Ticks closer together than this merge into one — a 3px tick 2px from its neighbour is not a
 *  target, and a row of them is a picket fence rather than a scale. */
const TICK_MIN_GAP_PX = 8

const fmtClock = (ms: number) => formatTime(new Date(ms), true)

export function ReplayBar({ incidentId, startedAt, onState, onVehicles, onExit, onShowEntry, onPlayhead, seekRef, journal = [] }: Props) {
  const rp = appConfig.copy.replay
  const [bundle, setBundle] = useState<ReplayBundle | null>(null)
  const [loadError, setLoadError] = useState(false)
  // start of the incident, not "now" — otherwise the first frame before the bundle loads is
  // the live picture and the playhead visibly jumps left the moment it arrives
  const [tMs, setTMs] = useState<number>(() => new Date(startedAt || Date.now()).getTime())
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(4)
  /** «übersprungen 2 h 14» — set when playback jumps a gap, cleared on a timer. */
  const [skipNotice, setSkipNotice] = useState<string | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  /** the track's px width — the break labels need it to know whether they FIT (see below) */
  const [trackW, setTrackW] = useState(0)

  // Load the event range + samples once, and park the playhead at the START of the incident.
  // It used to open at the end — the live picture — which is the one frame the operator has
  // just been looking at, and made «Abspielen» a button that did nothing until you first
  // dragged the handle all the way left. This is a Wiedergabe: it begins at the beginning.
  useEffect(() => {
    let alive = true
    const startMs = new Date(startedAt || Date.now()).getTime()
    loadReplay(incidentId, startMs, Date.now())
      .then((b) => { if (alive) { setBundle(b); setTMs(b.startMs) } })
      .catch(() => { if (alive) setLoadError(true) })
    return () => { alive = false }
  }, [incidentId, startedAt])


  const moments = useMemo(() => (bundle ? activityMoments(bundle.events, journal) : []), [bundle, journal])
  // The Verlauf as points on the axis: the lane under the track, and the line under the bar.
  const jrMoments = useMemo(() => journalMoments(journal), [journal])
  const current = useMemo(() => momentAt(jrMoments, tMs), [jrMoments, tMs])

  // ⚠️ Report the playhead upward only when it CROSSES a row, never per frame — `current.id`
  // is the dependency, not `tMs`. The Verlauf only needs to know which rows are still the
  // future, and that answer changes a few dozen times in an Einsatz rather than four times a
  // second. Lifting tMs itself would re-render the whole workspace on every tick.
  const seenId = useRef<string | null>(null)
  useEffect(() => {
    const id = current?.id ?? null
    if (id === seenId.current) return
    seenId.current = id
    onPlayhead?.(current ? current.ms : (bundle?.startMs ?? 0))
  }, [current, bundle, onPlayhead])

  // the Verlauf's rows seek this bar (see IncidentWorkspace) — same imperative-handle pattern
  // the Plan's fit/history already use
  useEffect(() => {
    if (!seekRef) return
    seekRef.current = (ms: number) => { setPlaying(false); setTMs(ms) }
    return () => { seekRef.current = null }
  }, [seekRef])
  // No recorded activity → no claims about where the silence is. That happens while the Verlauf
  // is still loading, and for real on an incident whose journal rows carry no absolute date, and
  // the honest answer in both cases is a plain linear track. Asserting "the whole incident is one
  // gap" produced a full-width bar with a stub break glued to the end, labelled with the entire
  // elapsed time — technically derivable, and useless.
  const gaps = useMemo(
    () => (bundle && moments.length ? findGaps(moments, bundle.startMs, bundle.endMs) : []),
    [moments, bundle],
  )
  const segments = useMemo(() => (bundle ? segmentsFromGaps(gaps, bundle.startMs, bundle.endMs) : []), [gaps, bundle])
  // The segmented layout only earns its keep when there is at least one stretch of activity to
  // give the room to. An incident with a single recorded moment in two days produces gaps and no
  // segments, and laying THAT out means a bar made entirely of breaks — nothing to scrub, nothing
  // to read. Fall back to one plain linear rail, which is at least a usable scrubber.
  const pieces = useMemo(() => (
    bundle && segments.length
      ? layoutTrack(segments, gaps, GAP_FRAC)
      : bundle
        ? layoutTrack([{ fromMs: bundle.startMs, toMs: bundle.endMs }], [], GAP_FRAC)
        : []
  ), [segments, gaps, bundle])
  const alarmMs = useMemo(() => new Date(startedAt || 0).getTime(), [startedAt])

  /**
   * The lane's ticks, with anything closer together than a finger MERGED into one.
   * ⚠️ Not cosmetic. An Einsatz writes far more lines than it places symbols, and the axis is
   * compressed into the stretches where work happened — so the raw ticks collapse into a solid
   * picket fence that says nothing and cannot be hit: a 3px tick 2px from its neighbour is not
   * a target. Merged, the lane stays honest (a cluster still sits where its rows are) and every
   * tick is reachable; the count rides in the title, and stepping through them is what
   * «Nächstes Ereignis» is for.
   */
  const jrTicks = useMemo(() => {
    const out: { id: string; frac: number; ms: number; count: number; text: string; on: boolean }[] = []
    for (const m of jrMoments) {
      const frac = fractionAtTime(pieces, m.ms)
      if (frac < 0 || frac > 1) continue
      const last = out[out.length - 1]
      const merged = last && trackW > 0 && (frac - last.frac) * trackW < TICK_MIN_GAP_PX
      if (merged) {
        last.count += 1
        if (current?.id === m.id) last.on = true
        continue
      }
      out.push({ id: m.id, frac, ms: m.ms, count: 1, text: m.text, on: current?.id === m.id })
    }
    return out
  }, [jrMoments, pieces, trackW, current])

  // Reconstruct + push state whenever the playhead (or bundle) changes. Folds locally —
  // no per-frame server call; snapshots are memoised inside the bundle.
  useEffect(() => {
    if (!bundle) return
    let alive = true
    void stateAt(bundle, tMs).then((ws) => { if (alive) onState(ws) })
    onVehicles(vehiclesAt(bundle.samples, tMs))
    return () => { alive = false }
  }, [bundle, tMs, onState, onVehicles])

  // Playback clock: advance the playhead in wall-clock-scaled steps, but jump the stretches
  // where nothing was recorded. Time stays proportional WHILE things happen — a burst still
  // reads as a burst — and only the silence is cut, which is the part nobody can learn
  // anything from. An incident nobody closed used to mean sitting through hours of it.
  useEffect(() => {
    if (!playing || !bundle) return
    const id = window.setInterval(() => {
      setTMs((t) => {
        const next = t + TICK_MS * speed
        if (next >= bundle.endMs) { setPlaying(false); return bundle.endMs }
        const gap = gapAt(gaps, next)
        if (!gap) return next
        // Land on the far edge — the next thing that actually happened — and say what was
        // skipped, so the jump is visible rather than a mysterious lurch of the clock.
        setSkipNotice(fmtSpanShort(gap.toMs - gap.fromMs))
        return gap.toMs
      })
    }, TICK_MS)
    return () => window.clearInterval(id)
  }, [playing, speed, bundle, gaps])

  // Clear the skip note on a timer rather than on the next tick (which is 250 ms away and would
  // make it unreadable). Re-arms whenever a new jump replaces it.
  useEffect(() => {
    if (!skipNotice) return
    const id = window.setTimeout(() => setSkipNotice(null), SKIP_NOTICE_MS)
    return () => window.clearTimeout(id)
  }, [skipNotice])

  // Measure the track so the break labels can decide whether they fit. The guard is for jsdom
  // (no ResizeObserver) — the same pattern ToolRail/NavRail already use.
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const measure = () => setTrackW(el.offsetWidth)
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [bundle])

  // Fraction → time goes through the layout, not the raw range: the axis is only linear
  // INSIDE a segment. Dropping the handle on a break lands on the moment it ends.
  const seekToFraction = useCallback((f: number) => {
    if (!bundle) return
    const t = timeAtFraction(pieces, f)
    if (t != null) setTMs(t)
  }, [bundle, pieces])

  // Step to the next/previous thing that HAPPENED, rather than by a fixed number of seconds.
  // On a sparse timeline a ±10 s nudge usually lands on nothing at all; «next event» is the
  // move an operator actually wants, and the lane's ticks stay clickable for a precise seek.
  const stepEvent = useCallback((dir: 1 | -1) => {
    if (!bundle) return
    setPlaying(false)
    setTMs((t) => stepMoment(moments, t, dir) ?? (dir === 1 ? bundle.endMs : bundle.startMs))
  }, [bundle, moments])

  const onTrackPointer = (e: React.PointerEvent) => {
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    seekToFraction((e.clientX - rect.left) / rect.width)
    setPlaying(false)
  }
  const onTrackDrag = (e: React.PointerEvent) => {
    if (e.buttons !== 1) return
    onTrackPointer(e)
  }

  const frac = bundle ? fractionAtTime(pieces, tMs) : 1
  // Deliberately NO "keine Fahrzeugdaten" note. It used to render whenever bundle.samples was
  // empty — which is every replay, on every station, because the Traccar→sample capture job was
  // never wired (see replay.ts). So it announced the absence of something nobody asked for and
  // then reassured that the Lage and the statuses replay, which they always do. An operator can
  // act on none of that. When vehicle capture actually exists, an incident that HAD vehicles but
  // no trace is worth saying — until then this line is noise.

  return (
    <div className={s.replay} role="region" aria-label={rp.region}>
      <div className={s['replay-banner']}>
        <span className={s['replay-dot']} />
        <b>{rp.banner}</b>
        <span className={s['replay-sub']}>{rp.subtitle}</span>
        <button className={s['replay-exit']} onClick={onExit}>
          <Icon id="close" /> {rp.backToLive}
        </button>
      </div>

      {loadError ? (
        <div className={s['replay-empty']}>{rp.loadFailed}</div>
      ) : !bundle ? (
        <div className={s['replay-empty']}>{rp.loading}</div>
      ) : (
        <div className={s['replay-controls']}>
          {/* transport: −10 s / play-pause / +30 s, then speed, with the live clock at the end */}
          <div className={s['replay-transport']} role="group" aria-label={rp.transport}>
            <button
              className={s['replay-skip']}
              onClick={() => stepEvent(-1)}
              title={rp.skipBack}
              aria-label={rp.skipBack}
            >
              <Icon id="skipback" />
            </button>
            <button
              className={s['replay-play']}
              onClick={() => setPlaying((p) => !p)}
              title={playing ? rp.pause : appConfig.copy.play}
              aria-label={playing ? rp.pause : appConfig.copy.play}
            >
              <Icon id={playing ? 'pause' : 'play'} />
            </button>
            <button
              className={s['replay-skip']}
              onClick={() => stepEvent(1)}
              title={rp.skipFwd}
              aria-label={rp.skipFwd}
            >
              <Icon id="skipfwd" />
            </button>
          </div>

          <Segmented<(typeof SPEEDS)[number]> ariaLabel={rp.speed} value={speed} onChange={setSpeed}
            options={SPEEDS.map((sp) => ({ value: sp, label: `${sp}×` }))} />

          {/* the track + its end labels share a column; the current time rides ABOVE the
              handle as a bubble so it never crowds the track or the start label */}
          <div className={s['replay-scrub']}>
            <div className={s['replay-time']} style={{ left: `${Math.max(7, Math.min(93, frac * 100))}%` }}>{fmtClock(tMs)}</div>
            <div
              ref={trackRef}
              className={s['replay-track']}
              onPointerDown={onTrackPointer}
              onPointerMove={onTrackDrag}
              role="slider"
              aria-label={rp.timepoint}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(frac * 100)}
            >
              {/* Abschnitte: one rail per stretch that HAS activity, sized by its real duration,
                  with a fixed narrow break between them. The bar is therefore linear inside a
                  segment and broken between them — drawn as a real interruption rather than a
                  texture, because a distorted axis has to be obvious rather than deduced. */}
              {pieces.map((p, i) => (
                p.kind === 'gap' ? (
                  <div
                    key={`p-${i}`}
                    className={s['replay-break']}
                    style={{ left: `${p.leftFrac * 100}%`, width: `${p.widthFrac * 100}%` }}
                    title={fillTemplate(rp.gapTitle, { span: fmtSpanShort(p.toMs - p.fromMs) })}
                  />
                ) : (
                  <div
                    key={`p-${i}`}
                    className={s['replay-seg']}
                    style={{ left: `${p.leftFrac * 100}%`, width: `${p.widthFrac * 100}%` }}
                  >
                    {/* played portion of THIS segment */}
                    <div
                      className={s['replay-segfill']}
                      style={{ width: `${Math.max(0, Math.min(1, (tMs - p.fromMs) / Math.max(1, p.toMs - p.fromMs))) * 100}%` }}
                    />
                  </div>
                )
              ))}
              <div className={s['replay-handle']} style={{ left: `${frac * 100}%` }} />
            </div>
            {/* ── Die Verlaufsspur ──
                The ONLY thing marked on this axis. The rail carried a coloured dot per audit
                event too — «Symbol gesetzt», «Zeichnung», Status, Divera — and freehand drawing
                alone emits one per stroke, so a busy minute was a smear of overlapping circles
                that could neither be read nor aimed at. The rail now says one thing and says it
                clearly: filled = worked, broken = nothing happened. What was written is the one
                thing worth a mark of its own, and it gets its own lane rather than joining a
                crowd. A tick, not a dot: it reads as a moment on a scale, and the one the
                playhead stands in is the only one that carries colour. */}
            {jrTicks.length > 0 && (
              <div className={s['replay-lane']} role="group" aria-label={rp.laneLabel}>
                {jrTicks.map((t) => {
                  const label = t.count > 1
                    ? `${fmtClock(t.ms)} · ${fillTemplate(rp.laneEntries, { n: t.count })}`
                    : `${fmtClock(t.ms)} · ${t.text}`
                  return (
                    <button
                      key={t.id}
                      className={`${s['replay-jr']} ${t.on ? s['replay-jr-on'] : ''}`}
                      style={{ left: `${t.frac * 100}%` }}
                      title={label}
                      aria-label={label}
                      onClick={(e) => { e.stopPropagation(); setTMs(t.ms); setPlaying(false) }}
                    />
                  )
                })}
              </div>
            )}
            {/* The break durations live OFF the rail, in their own row underneath: the track
                stays purely graphical, and a long label can never squeeze the thing it
                describes. Each sits centred under its own break. */}
            {/* ⚠️ Only the breaks WIDE ENOUGH to hold their label get one. Breaks share at most
                half the bar between them (layoutTrack), so on an Einsatz with fifteen of them
                each slice is ~40px — and fifteen «1 h 32 min» centred on 40px slices printed a
                solid unreadable band of overlapping text right under the track. A label that
                cannot be read is not information, it is noise sitting on the scrubber. The
                duration stays on the break's own `title`, and the break itself is still drawn,
                so nothing is lost except the pile-up. */}
            <div className={s['replay-breaks']} aria-hidden="true">
              {pieces.filter((p) => p.kind === 'gap' && p.widthFrac * trackW >= BREAK_LABEL_MIN_PX).map((p, i) => (
                <span
                  key={`bl-${i}`}
                  className={s['replay-breaklabel']}
                  style={{ left: `${(p.leftFrac + p.widthFrac / 2) * 100}%` }}
                >
                  {fmtSpanShort(p.toMs - p.fromMs)}
                </span>
              ))}
            </div>
            {/* The middle slot carries the Einsatzuhr, and the skip note takes it over while a
                jump is being announced. Deliberately NOT in the time bubble above: that bubble
                is pinned to the handle (up to 93%), so a variable-width note rides off the right
                edge exactly when the playhead is near the end — which is where a forgotten-close
                gap always sits. Here it is fixed, centred, and cannot collide with anything. */}
            <div className={s['replay-range']}>
              <span>{fmtClock(bundle.startMs)}</span>
              {skipNotice ? (
                <span className={s['replay-skipnote']}>{fillTemplate(rp.skipped, { span: skipNotice })}</span>
              ) : Number.isFinite(alarmMs) && alarmMs > 0 && tMs >= alarmMs ? (
                // «how far in», the number that gets said out loud in a debrief — the absolute
                // times on either side answer «when».
                <span className={s['replay-elapsed']}>{fillTemplate(rp.sinceAlarm, { span: fmtElapsedHM(tMs - alarmMs) })}</span>
              ) : <span className={s['replay-elapsed']} />}
              <span>{rp.now} · {fmtClock(bundle.endMs)}</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Untertitel ──
          The Verlauf line the playhead is standing in, running along under the bar the way
          subtitles run under a film. It answers the question the whole replay is asked — «was
          war da los?» — without making the operator hunt for the row in a list, and while it
          PLAYS it reads like a narration of the Einsatz.
          ⚠️ One line, ellipsised, never wrapping: it sits under a bar that floats over the map,
          and a caption that grew to three lines would cover the thing it is describing. The
          whole text is one tap away («im Verlauf»), which is also where the ones it cannot show
          are — several rows in the same minute leave only the last one here. */}
      {bundle && (
        <div className={s['replay-caption']}>
          {current ? (<>
            <span className={s['replay-caption-t']}>{fmtClock(current.ms)}</span>
            <span className={s['replay-caption-tx']} title={current.text}>{current.text}</span>
            {onShowEntry && (
              <button className={s['replay-caption-go']} onClick={() => onShowEntry(current.id)}>
                {rp.captionOpen}
              </button>
            )}
          </>) : (
            /* ⚠️ The row STAYS, empty. The playhead parks at the incident's start, where nothing
               has been written yet — and a caption that appeared only once you passed the first
               entry both read as broken («where are the subtitles?») and grew the bar by its own
               height at that moment, shoving the controls upward on a bottom-anchored bar. One
               reserved row costs nothing and holds the bar still. The wording is true both
               before the first entry and on an Einsatz that never got one. */
            <span className={`${s['replay-caption-tx']} ${s['replay-caption-none']}`}>{rp.captionNone}</span>
          )}
        </div>
      )}
    </div>
  )
}
