// Time-travel replay scrubber (audit-trail sub-phase B, PLAN-audit-trail §6).
//
// A read-only past view: a horizontal slider from incident start → now, a draggable
// handle, play/pause with speed, and clickable event markers on the track. The map
// renders `state_at(handle)` — this component owns the playhead + the fold, and reports
// the reconstructed `Saved` shape (and interpolated vehicle positions) up to App, which
// swaps it in for the live document while replay is active.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { formatTime } from '../lib/format'
import { appConfig } from '../config/appConfig'
import { Segmented } from './Segmented'
import s from './ReplayBar.module.css'
import {
  deriveMarkers, loadReplay, stateAt, vehiclesAt,
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
const SKIP_BACK_MS = 10_000 // −10 s nudge
const SKIP_FWD_MS = 30_000 // +30 s nudge

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

  const markers = useMemo(() => (bundle ? deriveMarkers(bundle.events) : []), [bundle])

  // Reconstruct + push state whenever the playhead (or bundle) changes. Folds locally —
  // no per-frame server call; snapshots are memoised inside the bundle.
  useEffect(() => {
    if (!bundle) return
    let alive = true
    void stateAt(bundle, tMs).then((ws) => { if (alive) onState(ws) })
    onVehicles(vehiclesAt(bundle.samples, tMs))
    return () => { alive = false }
  }, [bundle, tMs, onState, onVehicles])

  // Playback clock: advance the playhead in wall-clock-scaled steps; stop at the end.
  useEffect(() => {
    if (!playing || !bundle) return
    const id = window.setInterval(() => {
      setTMs((t) => {
        const next = t + TICK_MS * speed
        if (next >= bundle.endMs) { setPlaying(false); return bundle.endMs }
        return next
      })
    }, TICK_MS)
    return () => window.clearInterval(id)
  }, [playing, speed, bundle])

  const seekToFraction = useCallback((f: number) => {
    if (!bundle) return
    const clamped = Math.max(0, Math.min(1, f))
    setTMs(bundle.startMs + clamped * (bundle.endMs - bundle.startMs))
  }, [bundle])

  // step the playhead by a fixed offset, clamped to [start, now]; pausing on a manual nudge
  const skip = useCallback((deltaMs: number) => {
    if (!bundle) return
    setPlaying(false)
    setTMs((t) => Math.max(bundle.startMs, Math.min(bundle.endMs, t + deltaMs)))
  }, [bundle])

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
  const noVehicleData = !!bundle && bundle.samples.length === 0

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
              onClick={() => skip(-SKIP_BACK_MS)}
              title={rp.skipBack}
              aria-label={rp.skipBack}
            >
              <Icon id="skipback" /><span>10</span>
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
              onClick={() => skip(SKIP_FWD_MS)}
              title={rp.skipFwd}
              aria-label={rp.skipFwd}
            >
              <span>30</span><Icon id="skipfwd" />
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
            <div className={s['replay-range']}>
              <span>{fmtClock(bundle.startMs)}</span>
              <span>{rp.now} · {fmtClock(bundle.endMs)}</span>
            </div>
          </div>
        </div>
      )}

      {noVehicleData && (
        <div className={s['replay-note']} title={rp.noVehicleTitle}>
          {rp.noVehicleData}
        </div>
      )}
    </div>
  )
}
