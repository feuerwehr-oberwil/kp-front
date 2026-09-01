import { useRef } from 'react'

/**
 * The app's own horizontal slider — the one control on the drawing/Ebenen surfaces that used to
 * be a native `<input type="range">` (LayerPanel · Deckkraft). Everything else here deliberately
 * avoids native form controls (the `Stepper` instead of a number field, the app's `Menu` instead
 * of a `<select>`), and the native range was the one that came out in the browser's own
 * track-and-thumb, ignored the day/night tokens and gave a gloved finger a 4px-tall target.
 *
 * Touch model: the whole 44px band is the hit area (the painted track is thin), the drag is a
 * pointer capture so it survives leaving the row, `touch-action: none` keeps a drag from
 * scrolling the panel under it, and there is no buzz — a drag is not an arming hold.
 * Colours ride `currentColor`, so the same component reads correctly on the dark Ebenen card and
 * on a light sheet without either surface passing it a palette.
 */
export function Slider({ value, min = 0, max = 100, step = 1, onChange, ariaLabel, valueText }: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
  ariaLabel: string
  /** what the value MEANS, spoken («55 %») — the number alone is not the unit */
  valueText?: string
}) {
  const trackRef = useRef<HTMLSpanElement>(null)
  const clamp = (v: number) => Math.max(min, Math.min(max, v))
  const pct = ((clamp(value) - min) / (max - min)) * 100

  const fromClientX = (clientX: number) => {
    const el = trackRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (!r.width) return
    const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    const next = clamp(min + Math.round((t * (max - min)) / step) * step)
    if (next !== value) onChange(next)
  }

  const nudge = (by: number) => { const next = clamp(value + by); if (next !== value) onChange(next) }

  return (
    <span
      className="uslider" role="slider" tabIndex={0}
      aria-label={ariaLabel} aria-valuemin={min} aria-valuemax={max} aria-valuenow={clamp(value)}
      aria-valuetext={valueText}
      // `data-holdaction`: dragging IS the gesture here, so the app-wide hold tooltip must not
      // claim the press and answer «was ist das» on top of a value the finger is still moving.
      data-holdaction
      onPointerDown={(e) => {
        if (e.button) return
        e.currentTarget.setPointerCapture(e.pointerId)
        fromClientX(e.clientX)
      }}
      onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) fromClientX(e.clientX) }}
      onKeyDown={(e) => {
        const k = e.key
        if (k === 'ArrowLeft' || k === 'ArrowDown') nudge(-step)
        else if (k === 'ArrowRight' || k === 'ArrowUp') nudge(step)
        else if (k === 'PageDown') nudge(-step * 10)
        else if (k === 'PageUp') nudge(step * 10)
        else if (k === 'Home') nudge(min - value)
        else if (k === 'End') nudge(max - value)
        else return
        e.preventDefault()
      }}
    >
      <span className="uslider-track" ref={trackRef}>
        <span className="uslider-fill" style={{ width: `${pct}%` }} />
        <span className="uslider-thumb" style={{ left: `${pct}%` }} />
      </span>
    </span>
  )
}
