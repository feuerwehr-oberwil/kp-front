import { useMemo } from 'react'
import { labelledNodes, profileNodes, type ProfileResult } from '../lib/profile'
import { fmtDistance } from '../lib/geo'
import type { LngLat } from '../types'
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
export function ProfileChart({ p, path }: {
  p: ProfileResult
  /** the measured path itself – its nodes are marked on the profile (lib/profile · profileNodes) */
  path?: LngLat[]
}) {
  const { line, fill } = useMemo(() => {
    const maxDist = p.points[p.points.length - 1].dist || 1
    const span = Math.max(1, p.max - p.min)
    const x = (d: number) => PAD + (d / maxDist) * (W - 2 * PAD)
    const y = (a: number) => PAD + (1 - (a - p.min) / span) * (H - 2 * PAD)
    const pts = p.points.map((q) => `${x(q.dist).toFixed(1)},${y(q.alt).toFixed(1)}`)
    return { line: `M${pts.join(' L')}`, fill: `M${x(0).toFixed(1)},${(H - PAD).toFixed(1)} L${pts.join(' L')} L${x(maxDist).toFixed(1)},${(H - PAD).toFixed(1)} Z` }
  }, [p])
  // The tapped nodes: a guide and a dot on the profile, and under the axis the SAME cumulative
  // distance the map writes beside that node – so «the dip after 120 m» is a place one can point
  // at, and the unlabelled first tap is the left edge. ⚠️ The dots and labels are HTML over the
  // chart, in per cent: the SVG is stretched (preserveAspectRatio none), which would turn a
  // <circle> into an ellipse and squash any <text>.
  const nodes = useMemo(() => (path ? profileNodes(p, path) : []), [p, path])
  const labelled = useMemo(() => labelledNodes(nodes), [nodes])
  const span = Math.max(1, p.max - p.min)
  const left = (frac: number) => `${((PAD + frac * (W - 2 * PAD)) / W) * 100}%`
  const top = (alt: number) => `${((PAD + (1 - (alt - p.min) / span) * (H - 2 * PAD)) / H) * 100}%`
  return (
    <div className={s['mp-chart-wrap']}>
      <div className={s['mp-chart-plot']}>
        <svg className={s['mp-chart']} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <path d={fill} className={s['mp-chart-fill']} />
          {nodes.map((n, i) => {
            const x = PAD + n.frac * (W - 2 * PAD)
            return <line key={i} x1={x} x2={x} y1={PAD} y2={H - PAD} className={s['mp-chart-guide']} />
          })}
          <path d={line} className={s['mp-chart-line']} />
        </svg>
        {nodes.map((n, i) => (
          <span key={i} className={cx(s['mp-chart-node'], (i === 0 || i === nodes.length - 1) && s.end)}
            style={{ left: left(n.frac), top: top(n.alt) }} aria-hidden />
        ))}
      </div>
      {nodes.length > 0 && (
        <div className={s['mp-chart-axis']} aria-hidden>
          {nodes.map((n, i) => labelled.has(i) && (
            <span key={i} className={cx(s['mp-chart-tick'], i === 0 && s.first, i === nodes.length - 1 && s.last)}
              style={{ left: left(n.frac) }}>{fmtDistance(n.dist)}</span>
          ))}
        </div>
      )}
    </div>
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
