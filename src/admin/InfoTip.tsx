import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

// A small, dependency-free, accessible "ⓘ" hint. The trigger is a real <button>
// so it's keyboard-focusable and announced; the popover is linked via
// aria-describedby and carries role="tooltip". It opens on hover, keyboard focus
// AND tap (the button toggles on click for touch), closes on blur / mouse-leave /
// Escape / outside-tap. The popover is absolutely positioned and never reflows the
// surrounding layout (no layout shift).
//
// `tone="warn"` tints the trigger amber — used to flag doctrine values that are
// stored but "noch nicht wirksam".
export function InfoTip({
  text,
  label,
  tone = 'default',
}: {
  text: string
  /** Accessible name for the icon-only trigger (e.g. the field it explains). */
  label: string
  tone?: 'default' | 'warn'
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLSpanElement>(null)
  const id = useId()

  // The pop is hard-centered on the trigger; near a viewport edge that centers it
  // off-screen. Measure once per open and shift it back in via --tip-shift (the
  // caret compensates in CSS so it keeps pointing at the trigger).
  useLayoutEffect(() => {
    const el = popRef.current
    if (!open || !el) return
    el.style.setProperty('--tip-shift', '0px')
    const r = el.getBoundingClientRect()
    const mainLeft = wrapRef.current?.closest('.adm-main')?.getBoundingClientRect().left ?? 0
    const leftEdge = mainLeft + 8
    const pad = 8
    const shift = r.left < leftEdge ? leftEdge - r.left
      : r.right > window.innerWidth - pad ? window.innerWidth - pad - r.right : 0
    if (shift) el.style.setProperty('--tip-shift', `${shift}px`)
  }, [open])

  // Esc closes (and returns focus to the trigger via natural focus retention).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    const onDocPointer = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDocPointer, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDocPointer, true)
    }
  }, [open])

  return (
    <span
      ref={wrapRef}
      className="adm-tip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={`adm-tip-trigger${tone === 'warn' ? ' warn' : ''}`}
        aria-label={fillTemplate(appConfig.copy.admin.infoTip.prefix, { label })}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={(e) => {
          // Inside a <label> the click would otherwise focus the wrapped input.
          e.preventDefault()
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <span aria-hidden>ⓘ</span>
      </button>
      <span
        ref={popRef}
        role="tooltip"
        id={id}
        className="adm-tip-pop"
        data-open={open || undefined}
      >
        {text}
      </span>
    </span>
  )
}
