// The capture page's accordion card (CaptureApp): head row and, while open, the body. Every
// section of the poster opens and closes through this one shell.

import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'

function AccHead({ open, label, sub, onToggle }: { open: boolean; label: string; sub: string; onToggle: () => void }) {
  return (
    <button type="button" className={`cv-acc-head${open ? ' on' : ''}`} aria-expanded={open} onClick={onToggle}>
      <span className="cv-acc-label">{label}</span>
      <span className="cv-acc-sub">{sub}</span>
      {/* the one fold grammar: the global `.chev`, turned by aria-expanded (29.09.2026) */}
      <Icon id="chevron-down" className="chev" />
    </button>
  )
}

/** One accordion section: `step` is the `data-step` a «noch offen» chip lands on
 *  (CaptureApp · jumpToStep); `sectionRef` lets the page scroll an opened card into view. */
export function AccSection({ open, label, sub, onToggle, step, sectionRef, children }: {
  open: boolean
  label: string
  sub: string
  onToggle: () => void
  step?: string
  sectionRef: (el: HTMLElement | null) => void
  children: ReactNode
}) {
  return (
    <section className="cv-card cv-acc-card" data-step={step} ref={sectionRef}>
      <AccHead open={open} label={label} sub={sub} onToggle={onToggle} />
      {open && <div className="cv-acc-body">{children}</div>}
    </section>
  )
}
