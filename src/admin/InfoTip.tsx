import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

// A small, dependency-free, accessible "ⓘ" hint. The trigger is a real <button>
// so it's keyboard-focusable and announced; the popover is linked via
// aria-describedby and carries role="tooltip". The popover is absolutely positioned
// and never reflows the surrounding layout (no layout shift) — which is what lets it
// carry the explanatory copy that used to sit under the field as prose.
//
// ⚠️ HOVER AND PIN ARE TWO STATES, not one. They were one `open` boolean, and on a
// touch device that made the ⓘ unopenable: a tap synthesises mouseenter → open, and
// the click that follows toggled the SAME flag back to closed. So the pointer's hover
// and the click/tap's pin are tracked separately and the pop is open while either is
// true. A tap therefore opens (and pins) it; a second tap, Escape or a tap anywhere
// outside closes it; a mouse leaving a pinned pop leaves it standing.
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
  // hovered: the pointer is over the trigger. pinned: a click/tap — or keyboard focus — is
  // holding it open. Either one shows the pop; both have to go for it to close.
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const open = hovered || pinned
  const wrapRef = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLSpanElement>(null)
  // ⚠️ Did a pointer put the focus here? A pointer press focuses the button BEFORE it clicks it,
  // so pinning on focus too would have the click immediately un-pin what the press just pinned —
  // the same one-flag bug in a second costume. Keyboard focus still pins; a pointer's does not,
  // because its click is one event away and says so itself.
  const pointerFocus = useRef(false)
  // Which side of the trigger the pop opens on. 'up' is the default — a hint reads better above
  // the thing it explains — and the measurement below flips it when there is no room up there.
  const [place, setPlace] = useState<'up' | 'down'>('up')
  const id = useId()

  // Placement, measured once per open, in two axes:
  //   · horizontal — the pop is hard-centered on the trigger, which near an edge centers it
  //     off-screen. --tip-shift pulls it back in (the caret compensates in CSS so it keeps
  //     pointing at the trigger).
  //   · vertical — `data-place`. Opening upward unconditionally meant the FIRST card of a page
  //     drew its pop straight over the h1 and the lede (Alarmgruppen's tip is three lines). The
  //     ceiling is the top of the scrolling content column, not just the viewport: above it sits
  //     the admin header, which the pop must not disappear under either.
  useLayoutEffect(() => {
    const el = popRef.current
    const wrap = wrapRef.current
    if (!open || !el || !wrap) return
    const pad = 8
    el.style.setProperty('--tip-shift', '0px')
    const r = el.getBoundingClientRect()
    const main = wrap.closest('.adm-main')?.getBoundingClientRect()
    const leftEdge = (main?.left ?? 0) + pad
    const shift = r.left < leftEdge ? leftEdge - r.left
      : r.right > window.innerWidth - pad ? window.innerWidth - pad - r.right : 0
    if (shift) el.style.setProperty('--tip-shift', `${shift}px`)
    // r.height is the same whichever side it is on, so this reading holds for both.
    const ceiling = Math.max(main?.top ?? 0, 0) + pad
    setPlace(wrap.getBoundingClientRect().top - r.height - pad < ceiling ? 'down' : 'up')
  }, [open])

  // Esc closes (and returns focus to the trigger via natural focus retention).
  useEffect(() => {
    if (!open) return
    const close = () => { setPinned(false); setHovered(false) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    const onDocPointer = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        close()
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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={`adm-tip-trigger${tone === 'warn' ? ' warn' : ''}`}
        aria-label={fillTemplate(appConfig.copy.admin.infoTip.prefix, { label })}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={(e) => {
          // ⚠️ Inside a settings row the whole row is a <label>, so without this the click
          // would focus the control the row wraps instead of opening the hint.
          e.preventDefault()
          e.stopPropagation()
          // The pin alone flips — a mouse user's `hovered` is true here, and toggling one
          // shared flag is what made this untappable on an iPad.
          setPinned((p) => !p)
        }}
        onPointerDown={() => { pointerFocus.current = true }}
        onFocus={() => { if (!pointerFocus.current) setPinned(true) }}
        onBlur={() => { pointerFocus.current = false; setPinned(false) }}
      >
        <span aria-hidden>ⓘ</span>
      </button>
      <span
        ref={popRef}
        role="tooltip"
        id={id}
        className="adm-tip-pop"
        data-place={place}
        data-open={open || undefined}
      >
        {text}
      </span>
    </span>
  )
}
