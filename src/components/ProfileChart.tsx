import { useMemo } from 'react'
import type { ProfileResult } from '../lib/profile'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import s from './MeasurePanel.module.css'

const W = 300, H = 96, PAD = 4 // chart geometry

/**
 * Elevation-profile sparkline: distance → x, altitude → y (inverted), scaled to the profile's own
 * min/max so small undulations stay visible. Shared by the Messen tool's panel and the line
 * editor's Höhenprofil section, which is why it lives outside MeasurePanel — it keeps that file's
 * stylesheet (the `.mp-*` classes are sized off `width: 100%`, so it fits the narrower ctx dock).
 */
export function ProfileChart({ p }: { p: ProfileResult }) {
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

/** Aufstieg / Abstieg / Tiefster–Höchster under the chart. */
export function ProfileStats({ p }: { p: ProfileResult }) {
  const C = appConfig.copy.measure // read per-render so the resolved locale applies
  return (
    <div className={cx(s['mp-stat-row'], s['mp-prof-stats'])}>
      <div className={s['mp-stat']}><span className={s['mp-k']}><Icon id="arrow" />{C.ascent}</span><b className={cx(s['mp-v'], s.up)}>+{Math.round(p.gain)} m</b></div>
      <div className={s['mp-stat']}><span className={s['mp-k']}><Icon id="arrow" />{C.descent}</span><b className={cx(s['mp-v'], s.down)}>−{Math.round(p.loss)} m</b></div>
      <div className={s['mp-stat']}><span className={s['mp-k']}>{C.min} / {C.max}</span><b className={s['mp-v']}>{Math.round(p.min)} / {Math.round(p.max)} m</b></div>
    </div>
  )
}
