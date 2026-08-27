import { useState } from 'react'
import type { LngLat } from '../types'
import type { ProfileResult } from '../lib/profile'
import { pathLengthM, polygonAreaM2, fmtDistance, fmtArea, hoseCount } from '../lib/geo'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { ProfileChart, ProfileStats } from './ProfileChart'
import s from './MeasurePanel.module.css'

export function MeasurePanel({ mode, coords, profile, profileLoading, metrics, showProfile = true, blocked = false, hint, onAdopt, onCalibrate, calibrateLabel, recalibrateLabel, scaleNote }: {
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
  /** turn the measurement into a real, drawn object — the measured points become the nodes of a
   *  line (line mode) or of a Fläche (area mode). Absent ⇒ the action is hidden: a read-only
   *  surface measures but never draws, and so does one whose measurement is still just a hint. */
  onAdopt?: () => void
  /** Plan only: start (or redo) the scale calibration straight from the panel. Absent when the
   *  scale is DERIVED from the Kartenverknüpfung — see `scaleNote`. */
  onCalibrate?: () => void
  calibrateLabel?: string
  recalibrateLabel?: string
  /** Where these metres come from, when it is not a calibration anybody made here. A quiet
   *  reading in place of the button, so a sheet that is already tied to the map does not offer
   *  «Neu kalibrieren» — which reads as «this is not calibrated» on a plan that is. */
  scaleNote?: string
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
          {/* «Als Linie übernehmen» — the measured path becomes a drawn line, with the measured
              points as its nodes. Without it the only way to KEEP a Strecke was to draw it a
              second time by hand over the top of the one just measured. */}
          {onAdopt && (
            <button type="button" className={cx('ip-btn', 'ghost', s['mp-adopt-btn'])} onClick={onAdopt}>
              <Icon id="pen" />{C.adoptLine}
            </button>
          )}
          {hasProfile && profileOpen && (profileLoading ? (
            <div className={s['mp-prof-msg']}>{C.profileLoading}</div>
          ) : profile ? (
            <>
              <div className={s['mp-prof-title']}>{C.profile}</div>
              <ProfileChart p={profile} />
              <ProfileStats p={profile} />
            </>
          ) : (
            <div className={s['mp-prof-msg']}>{C.profileNone}</div>
          ))}
        </>
      ) : (
        <>
          <div className={s['mp-stat-row']}>
            <div className={s['mp-stat']}><span className={s['mp-k']}>{C.area}</span><b className={s['mp-v']}>{fmtArea(areaM2)}</b></div>
            <div className={s['mp-stat']}><span className={s['mp-k']}>{C.perimeter}</span><b className={s['mp-v']}>{fmtDistance(perimeterM)}</b></div>
          </div>
          {/* «Als Fläche übernehmen» — the twin of the line adopt: the measured ring becomes a
              drawn Fläche, so an outline that was just paced out can be KEPT instead of traced a
              second time by hand over the top of the measurement. */}
          {onAdopt && (
            <button type="button" className={cx('ip-btn', 'ghost', s['mp-adopt-btn'])} onClick={onAdopt}>
              <Icon id="area" />{C.adoptArea}
            </button>
          )}
        </>
      )}
      {onCalibrate ? (
        <button type="button" className={cx('ip-btn', blocked ? 'primary' : 'ghost', s['mp-cal-btn'])} onClick={onCalibrate}>
          <Icon id="measure" />{blocked ? calibrateLabel : recalibrateLabel}
        </button>
      ) : scaleNote ? (
        <div className={s['mp-cal-note']} role="status"><Icon id="measure" />{scaleNote}</div>
      ) : null}
    </div>
  )
}
