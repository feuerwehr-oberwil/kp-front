import { createPortal } from 'react-dom'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { useTimedProgress } from '../lib/nodeHold'
import { HOLD_MS } from '../lib/useHoldEntry'
import type { HoldAnchor, HoldTarget } from '../lib/useHoldEntry'

/** Radius of the charge ring in its 20px viewBox. */
const RING_R = 8
const RING_LEN = 2 * Math.PI * RING_R

/**
 * The «Eintrag» hold's charging cue: a small ring beside the label that fills over HOLD_MS.
 *
 * JS-driven off the press's own start stamp (useTimedProgress — the nodeHold clock), NOT a CSS
 * keyframe: the old width bar animated over .22s while the hold latches at 350ms, so it read
 * «fertig» 130ms early — and under prefers-reduced-motion the global zero-duration rule made it
 * full on the first frame while the timer still ran. Same fix, same reasoning as the
 * node-delete ring (lib/nodeHold): the fill and the thing it promises share one clock.
 */
export function HoldChargeRing({ since }: { since: number }) {
  const progress = useTimedProgress(since, HOLD_MS)
  return (
    <svg className="tb-hold-ring" viewBox="0 0 20 20" aria-hidden>
      <circle className="tb-hold-track" cx="10" cy="10" r={RING_R} />
      <circle
        className="tb-hold-fill"
        cx="10" cy="10" r={RING_R}
        strokeDasharray={RING_LEN}
        strokeDashoffset={RING_LEN * (1 - progress)}
        transform="rotate(-90 10 10)"
      />
    </svg>
  )
}

/**
 * The two slide targets a latched «Eintrag» hold offers: Sprachnotiz and Foto.
 * Rendered by both the TopBar button and the phone FAB.
 *
 * They STACK away from the button along one axis — up from the phone FAB, down from the TopBar
 * button — with Sprachnotiz nearest and Foto beyond it, so the distance the finger travels picks
 * the option. DOM order here is always nearest-first; the CSS reverses the column for `above`.
 * Neither host is cancel: the button itself becomes the ✕ (see useHoldEntry · HoldTarget).
 *
 * ⚠️ PORTALLED to <body>, positioned from the button's measured rect. It used to live inside
 * the button, and every single thing that can go wrong with that did: the button clipped it
 * (`overflow: hidden`, there for the charging cue) so a dark fragment flashed inside the button
 * as the hold latched; the host's `.tb-act-add span { position: relative }` fought the
 * `position: absolute` on specificity; and the top bar's own stacking context boxed it in.
 * Out here it is anchored to the viewport and owned by nobody — there is no ancestor left to
 * clip it, restyle it or stack over it.
 *
 * `data-hold-target` is the hit-test hook: the button owns the pointer capture for the whole
 * gesture, so useHoldEntry finds these with elementFromPoint rather than by pointer events of
 * their own. They must therefore stay HIT-TESTABLE — elementFromPoint skips anything with
 * `pointer-events: none`, which is why the container carries it and the targets undo it.
 */
export function HoldTargets({ hover, placement, anchor }: {
  hover: HoldTarget | null
  placement: 'above' | 'below'
  /** where the host button was when the hold latched */
  anchor: HoldAnchor | null
}) {
  const C = appConfig.copy.journal
  if (!anchor) return null
  // right-aligned to the button: both hosts sit against the right edge of the screen and the
  // targets are wider than either, so they open inward, where there is room.
  const style: React.CSSProperties = {
    position: 'fixed',
    minWidth: anchor.width,
    right: Math.max(8, window.innerWidth - anchor.right),
    ...(placement === 'above'
      ? { bottom: window.innerHeight - anchor.top + 10 }
      : { top: anchor.bottom + 10 }),
  }
  return createPortal(
    <div className={`hold-targets hold-targets-${placement}`} style={style} aria-hidden>
      <span className={`hold-target${hover === 'audio' ? ' on' : ''}`} data-hold-target="audio">
        <Icon id="mic" />{C.record}
      </span>
      <span className={`hold-target${hover === 'photo' ? ' on' : ''}`} data-hold-target="photo">
        <Icon id="cam" />{C.photo}
      </span>
    </div>,
    document.body,
  )
}
