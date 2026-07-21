import { useMemo, useState } from 'react'
import type { LngLat } from '../types'
import type { ProfileResult } from '../lib/profile'
import { pathLengthM, polygonAreaM2, fmtDistance, fmtArea, hoseCount } from '../lib/geo'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import s from './MeasurePanel.module.css'

const W = 300, H = 96, PAD = 4 // chart geometry

// Sparkline path + filled area for the elevation profile. Distance → x, altitude →
// y (inverted), scaled to the profile's own min/max so small undulations stay visible.
function Chart({ p }: { p: ProfileResult }) {
  const { line, fill } = useMemo(() => {
    const maxDist = p.points[p.points.length - 1].dist || 1
    const span = Math.max(1, p.max - p.min)
    const x = (d: number) => PAD + (d / maxDist) * (W - 2 * PAD)
    const y = (a: number) => PAD + (1 - (a - p.min) / span) * (H - 2 * PAD)
    const pts = p.points.map((q) => `${x(q.dist).toFixed(1)},${y(q.alt).toFixed(1)}`)
    return { line: `M${pts.join(' L')}`, fill: `M${x(0).toFixed(1)},${(H - PAD).toFixed(1)} L${pts.join(' L')} L${x(maxDist).toFixed(1)},${(H - PAD).toFixed(1)} Z` }
  }, [p])
  return (
    <svg className={s['mp-chart']} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={fill} className={s['mp-chart-fill']} />
      <path d={line} className={s['mp-chart-line']} />
    </svg>
  )
}

export function MeasurePanel({ mode, coords, profile, profileLoading, metrics, showProfile = true, blocked = false, hint, onCalibrate, calibrateLabel, recalibrateLabel }: {
  mode: 'line' | 'area'
  coords: LngLat[]
  profile: ProfileResult | null
  profileLoading: boolean
  /** pre-computed distance/area (e.g. the Plan's calibrated metres); falls back to geodesic
   *  computation from `coords` when absent (the Lage map). */
  metrics?: { lengthM: number; areaM2: number; perimeterM: number }
  /** hide the elevation-profile section — a Plan sheet has no height data. */
  showProfile?: boolean
  /** force the hint (e.g. "calibrate first") regardless of point count. */
  blocked?: boolean
  /** override the not-enough-points hint text. */
  hint?: string
  /** Plan only: start (or redo) the scale calibration straight from the panel. */
  onCalibrate?: () => void
  calibrateLabel?: string
  recalibrateLabel?: string
}) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.measure
  const lengthM = metrics ? metrics.lengthM : pathLengthM(coords)
  // area mode closes the ring for perimeter; needs 3+ points to be meaningful
  const areaM2 = metrics ? metrics.areaM2 : mode === 'area' ? polygonAreaM2(coords) : 0
  const perimeterM = metrics ? metrics.perimeterM : mode === 'area' && coords.length >= 3 ? lengthM + (coords[0] && coords.length ? pathLengthM([coords[coords.length - 1], coords[0]]) : 0) : 0

  const enough = mode === 'line' ? coords.length >= 2 : coords.length >= 3
  // #1: keep the panel slim — the Höhenprofil (chart + gain/loss) is collapsed by default and
  // opens on the ↕ toggle, so the summary bar barely covers the map.
  const [profileOpen, setProfileOpen] = useState(false)
  const hasProfile = showProfile && (profileLoading || !!profile)

  return (
    <div className={s['measure-panel']}>
      {blocked || !enough ? (
        <div className={s['mp-hint']}>{blocked && hint ? hint : mode === 'line' ? C.hintLine : C.hintArea}</div>
      ) : mode === 'line' ? (
        <>
          <div className={s['mp-stat-row']}>
            <div className={s['mp-stat']}><span className={s['mp-k']}>{C.distance}</span><b className={s['mp-v']}>{fmtDistance(lengthM)}</b></div>
            <div className={s['mp-stat']}><span className={s['mp-k']}>{C.hoses} à {appConfig.drawing.hoseLengthM} m</span><b className={s['mp-v']}>{hoseCount(lengthM)}</b></div>
            {hasProfile && (
              <button type="button" className={cx(s['mp-prof-toggle'], profileOpen && s['mp-prof-open'])}
                aria-expanded={profileOpen} aria-label={C.profile} onClick={() => setProfileOpen((o) => !o)}>
                <Icon id="chevron-down" />
              </button>
            )}
          </div>
          {hasProfile && profileOpen && (profileLoading ? (
            <div className={s['mp-prof-msg']}>{C.profileLoading}</div>
          ) : profile ? (
            <>
              <div className={s['mp-prof-title']}>{C.profile}</div>
              <Chart p={profile} />
              <div className={cx(s['mp-stat-row'], s['mp-prof-stats'])}>
                <div className={s['mp-stat']}><span className={s['mp-k']}><Icon id="arrow" />{C.ascent}</span><b className={cx(s['mp-v'], s.up)}>+{Math.round(profile.gain)} m</b></div>
                <div className={s['mp-stat']}><span className={s['mp-k']}><Icon id="arrow" />{C.descent}</span><b className={cx(s['mp-v'], s.down)}>−{Math.round(profile.loss)} m</b></div>
                <div className={s['mp-stat']}><span className={s['mp-k']}>{C.min} / {C.max}</span><b className={s['mp-v']}>{Math.round(profile.min)} / {Math.round(profile.max)} m</b></div>
              </div>
            </>
          ) : (
            <div className={s['mp-prof-msg']}>{C.profileNone}</div>
          ))}
        </>
      ) : (
        <div className={s['mp-stat-row']}>
          <div className={s['mp-stat']}><span className={s['mp-k']}>{C.area}</span><b className={s['mp-v']}>{fmtArea(areaM2)}</b></div>
          <div className={s['mp-stat']}><span className={s['mp-k']}>{C.perimeter}</span><b className={s['mp-v']}>{fmtDistance(perimeterM)}</b></div>
        </div>
      )}
      {onCalibrate && (
        <button type="button" className={cx('btn', blocked ? 'primary' : 'ghost', s['mp-cal-btn'])} onClick={onCalibrate}>
          <Icon id="measure" />{blocked ? calibrateLabel : recalibrateLabel}
        </button>
      )}
    </div>
  )
}
