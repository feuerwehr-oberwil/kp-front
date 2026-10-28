import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import s from './DockInfo.module.css'

// Info button for a tool dock — taps open a small popover with usage help (the
// instructions that used to live in the bottom hint bar: tap to place, lock to
// place several, etc.). Tap-toggle rather than hover so it works on a tablet.
//
// `inline`: the help expands IN PLACE inside its container instead of a floating bottom-centre
// tip. Use it where the container is a menu/popover that HAS the room (the compass/views popover) —
// a floating tip there collides with the map + the popover itself. The thin tool docks keep the
// floating tip (they have no room for inline text).
/**
 * THE card a map tool explains itself in: the dark message surface at the bottom-centre of the
 * viewport (on a phone, in the message lane), fixed to the viewport so no dock's transform can
 * drag it off-screen.
 *
 * Shared on purpose. Until review round 7 the ⓘ help below wore this card while «Punkt setzen»'s
 * own instruction was a thin dim pill of its own — two look-alikes a hand's width apart, and the
 * owner read the quiet one as the lesser message (20.10.2026: «different padding and coloration»).
 * One tool, one voice: whoever explains the map does it in here.
 */
export function MapHelpCard({ children, role }: { children: ReactNode; role: 'tooltip' | 'status' }) {
  return <span className={s['wb-dock-tip']} role={role}>{children}</span>
}

export function DockInfo({ text, inline }: { text: string; inline?: boolean }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  // ⚠️ inline, the paragraph opens ABOVE the ⓘ and pushes it down. In a popover that is already
  // at its max-height that pushed the button under the fold with the scroller still at the top –
  // the text was open and the one control that closes it was out of sight (20.09.2026). The
  // button follows its own text; `nearest` moves nothing when it is still visible.
  useLayoutEffect(() => {
    if (inline && open) btnRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [inline, open])
  // The floating tip closes on a press anywhere else. `onBlur` alone never fired on an iPhone:
  // Safari does not focus a tapped button, so there was no focus to lose and the tip stayed up
  // until the ⓘ itself was tapped again (sweep 28.10.2026 #21). A press on the ⓘ is left to its
  // own click, which toggles.
  useEffect(() => {
    if (inline || !open) return
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node && btnRef.current?.contains(e.target))) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [inline, open])
  const button = (
    <button
      ref={btnRef}
      className={cx(s['wb-dock-ibtn'], open && s.on)}
      aria-label={text}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      onBlur={inline ? undefined : () => setOpen(false)}
      // Escape folds the help away and nothing else (S8, 20.10.2026): stopped here, so the
      // surface's own Escape does not also disarm the tool whose dock this is
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) } }}
    >
      <Icon id="info" />
    </button>
  )
  if (inline) {
    return (
      <div className={s['wb-dock-info-inline']}>
        {open && <p className={s['wb-dock-tip-inline']}>{text}</p>}
        {button}
      </div>
    )
  }
  return (
    <span className={s['wb-dock-info']}>
      {button}
      {/* portal to <body>: the tip is `position: fixed` (bottom-centre of the viewport), but the
          dock's own `transform` would otherwise become its containing block and pin it to the dock
          (off-screen, right edge). Rendering at the body root lets fixed resolve to the viewport. */}
      {open && createPortal(<MapHelpCard role="tooltip">{text}</MapHelpCard>, document.body)}
    </span>
  )
}
