import { createPortal } from 'react-dom'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { useTimedProgress } from '../lib/nodeHold'
import { HOLD_MS } from '../lib/useHoldEntry'
import { fullViewHeight } from '../lib/iosKeyboard'
import type { HoldAnchor, HoldTarget } from '../lib/useHoldEntry'

/** Radius of the charge ring in its 20px viewBox. */
const RING_R = 8
const RING_LEN = 2 * Math.PI * RING_R

/**
 * A hold's charging cue: a small ring around the held glyph that fills over the hold's window –
 * the «Eintrag» hold (HOLD_MS), and every `useLongPress` handle (its `held`: the Plan / Seite
 * chooser, the compass, the Trupp crown). The host wraps glyph + ring in a `position: relative`
 * box (`.tb-act-ic`), so nothing reflows under the finger.
 *
 * JS-driven off the press's own start stamp (useTimedProgress — the nodeHold clock), NOT a CSS
 * keyframe: the old width bar animated over .22s while the hold latches at 350ms, so it read
 * «fertig» 130ms early — and under prefers-reduced-motion the global zero-duration rule made it
 * full on the first frame while the timer still ran. Same fix, same reasoning as the
 * node-delete ring (lib/nodeHold): the fill and the thing it promises share one clock.
 */
export function HoldChargeRing({ since, ms = HOLD_MS }: { since: number; ms?: number }) {
  const progress = useTimedProgress(since, ms)
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
 * The chooser a held «Eintrag» opens: Sprachnotiz and Foto. Rendered by both the TopBar button
 * and the phone FAB. It STAYS until one is tapped (lib/useHoldEntry, 21.09.2026) — they were
 * slide targets answered by the release, which «Foto» cannot be on an iPhone.
 *
 * They STACK away from the button along one axis — up from the phone FAB, down from the TopBar
 * button — with Sprachnotiz nearest and Foto beyond it. DOM order here is always nearest-first;
 * the CSS reverses the column for `above`. The button itself is the ✕ that closes the chooser.
 *
 * ⚠️ PORTALLED to <body>, positioned from the button's measured rect. It used to live inside
 * the button, and every single thing that can go wrong with that did: the button clipped it
 * (`overflow: hidden`, there for the charging cue) so a dark fragment flashed inside the button
 * as the hold latched; the host's `.tb-act-add span { position: relative }` fought the
 * `position: absolute` on specificity; and the top bar's own stacking context boxed it in.
 * Out here it is anchored to the viewport and owned by nobody.
 *
 * ⚠️ …but still inside the host button's REACT tree, so a press or a click on a target bubbles
 * into the button's own hold handlers unless it is stopped here. `data-hold-target` is how the
 * hook tells «inside the chooser» from «somewhere else» when a press closes it.
 */
export function HoldTargets({ placement, anchor, onPick }: {
  placement: 'above' | 'below'
  /** where the host button was when the hold latched */
  anchor: HoldAnchor | null
  onPick: (t: HoldTarget) => void
}) {
  const C = appConfig.copy.journal
  if (!anchor) return null
  // right-aligned to the button: both hosts sit against the right edge of the screen and the
  // targets are wider than either, so they open inward, where there is room. `bottom` from the
  // fixed frame's full height (lib/iosKeyboard · fullViewHeight), which the installed app's
  // collapsed innerHeight is not.
  const style: React.CSSProperties = {
    position: 'fixed',
    minWidth: anchor.width,
    right: Math.max(8, window.innerWidth - anchor.right),
    ...(placement === 'above'
      ? { bottom: fullViewHeight() - anchor.top + 10 }
      : { top: anchor.bottom + 10 }),
  }
  const target = (t: HoldTarget, icon: string, label: string) => (
    <button type="button" className="hold-target" data-hold-target={t}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onPick(t) }}>
      <Icon id={icon} />{label}
    </button>
  )
  return createPortal(
    <div className={`hold-targets hold-targets-${placement}`} style={style} role="menu">
      {target('audio', 'mic', C.record)}
      {target('photo', 'cam', C.photo)}
    </div>,
    document.body,
  )
}
