// Time-travel replay scrubber (audit-trail sub-phase B, PLAN-audit-trail §6).
//
// A read-only past view: a horizontal slider from incident start → now, a draggable
// handle, play/pause with speed, and clickable event markers on the track. The map
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
  activityMoments, deriveMarkers, findGaps, gapAt, loadReplay, stateAt, stepMoment, vehiclesAt,
  type ReplayBundle, type ReplayMarker, type VehicleAt,
} from '../lib/replay'
import type { Saved } from '../lib/workspace'

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
}

const SPEEDS = [1, 4, 16, 32] as const
const TICK_MS = 250 // playback frame cadence
/** How long the «übersprungen …» note stays up after a jump — long enough to read at a glance,
 *  short enough that it is gone before the next one is due. */
const SKIP_NOTICE_MS = 2500
/** Below this share of the track a gap band is too narrow to hold «2 h 14» without clipping it,
 *  so it keeps the tooltip and nothing else. Measured against the fraction rather than pixels
 *  because the bar is full-width on a phone and ~520 px on the desktop dock. */
const GAP_LABEL_MIN_FRAC = 0.13

const fmtClock = (ms: number) => formatTime(new Date(ms), true)
const MARKER_COLOR: Record<ReplayMarker['kind'], string> = {
  symbol: 'var(--blue)', draw: 'var(--green)', status: 'var(--amber)',
  divera: 'var(--red)', save: 'var(--ink-faint)', other: 'var(--ink-faint)',
}

export function ReplayBar({ incidentId, startedAt, onState, onVehicles, onExit }: Props) {
  const rp = appConfig.copy.replay
  const [bundle, setBundle] = useState<ReplayBundle | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [tMs, setTMs] = useState<number>(() => Date.now())
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(4)
  /** «übersprungen 2 h 14» — set when playback jumps a gap, cleared on a timer. */
  const [skipNotice, setSkipNotice] = useState<string | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  // Load the event range + samples once; default the playhead to the very end (= the
  // live picture) so entering replay shows "now" before the user scrubs back.
  useEffect(() => {
    let alive = true
    const startMs = new Date(startedAt || Date.now()).getTime()
    loadReplay(incidentId, startMs, Date.now())
      .then((b) => { if (alive) { setBundle(b); setTMs(b.endMs) } })
      .catch(() => { if (alive) setLoadError(true) })
    return () => { alive = false }
  }, [incidentId, startedAt])

  // only markers within the active (trimmed) range land on the track — an incident.create that
  // sits before the first real change would otherwise render off the left edge.
  const markers = useMemo(() => (bundle ? deriveMarkers(bundle.events).filter((m) => m.ms >= bundle.startMs && m.ms <= bundle.endMs) : []), [bundle])

  // Every recorded activity — the basis for both the empty stretches and the «next event» step.
  // Wider than `markers`, deliberately: markers drop workspace.save as too dense to draw, but a
  // burst of saves IS activity, and treating it as silence would skip over someone drawing.
  const moments = useMemo(() => (bundle ? activityMoments(bundle.events) : []), [bundle])
  const gaps = useMemo(() => (bundle ? findGaps(moments, bundle.startMs, bundle.endMs) : []), [moments, bundle])
  const alarmMs = useMemo(() => new Date(startedAt || 0).getTime(), [startedAt])

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

  const seekToFraction = useCallback((f: number) => {
    if (!bundle) return
    const clamped = Math.max(0, Math.min(1, f))
    setTMs(bundle.startMs + clamped * (bundle.endMs - bundle.startMs))
  }, [bundle])

  // Step to the next/previous thing that HAPPENED, rather than by a fixed number of seconds.
  // On a sparse timeline a ±10 s nudge usually lands on nothing at all; «next event» is the
  // move an operator actually wants, and the markers stay clickable for a precise seek.
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

  const frac = bundle && bundle.endMs > bundle.startMs
    ? (tMs - bundle.startMs) / (bundle.endMs - bundle.startMs)
    : 1
  const toFrac = (t: number) => (bundle && bundle.endMs > bundle.startMs
    ? Math.max(0, Math.min(1, (t - bundle.startMs) / (bundle.endMs - bundle.startMs)))
    : 0)
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
              <div className={s['replay-fill']} style={{ width: `${frac * 100}%` }} />
              {/* The empty stretches, under the markers: blue track means something happened,
                  pale band means nothing did — so the shape of the incident is readable before
                  pressing play, rather than discovered by scrubbing into it. */}
              {gaps.map((g, i) => {
                const a = toFrac(g.fromMs)
                const b = toFrac(g.toMs)
                if (b <= a) return null
                const span = fmtSpanShort(g.toMs - g.fromMs)
                return (
                  <div
                    key={`gap-${i}`}
                    className={s['replay-gap']}
                    style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }}
                    title={fillTemplate(rp.gapTitle, { span })}
                  >
                    {b - a >= GAP_LABEL_MIN_FRAC && <span className={s['replay-gap-label']}>{span}</span>}
                  </div>
                )
              })}
              {markers.map((m, i) => {
                const mf = bundle.endMs > bundle.startMs ? (m.ms - bundle.startMs) / (bundle.endMs - bundle.startMs) : 0
                if (mf < 0 || mf > 1) return null
                return (
                  <button
                    key={`${m.seq}-${i}`}
                    className={s['replay-marker']}
                    style={{ left: `${mf * 100}%`, background: MARKER_COLOR[m.kind] }}
                    title={`${m.label} · ${fmtClock(m.ms)}`}
                    aria-label={`${m.label} ${fmtClock(m.ms)}`}
                    onClick={(e) => { e.stopPropagation(); setTMs(m.ms); setPlaying(false) }}
                  />
                )
              })}
              <div className={s['replay-handle']} style={{ left: `${frac * 100}%` }} />
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
    </div>
  )
}
