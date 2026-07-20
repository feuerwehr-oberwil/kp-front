import { useState } from 'react'
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
export function DockInfo({ text, inline }: { text: string; inline?: boolean }) {
  const [open, setOpen] = useState(false)
  const button = (
    <button
      className={cx(s['wb-dock-ibtn'], open && s.on)}
      aria-label={text}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      onBlur={inline ? undefined : () => setOpen(false)}
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
      {open && createPortal(<span className={s['wb-dock-tip']} role="tooltip">{text}</span>, document.body)}
    </span>
  )
}
