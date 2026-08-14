import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import type { HoldTarget } from '../lib/useHoldEntry'

/**
 * The two slide targets a latched «Eintrag» hold offers: Sprachnotiz (what the hold already
 * started) and Foto. Rendered by both the TopBar button and the phone FAB, positioned by the
 * `placement` its host sits at — the FAB is at the bottom of the screen, the TopBar button at
 * the top, and the targets must never open off-screen.
 *
 * `data-hold-target` is the hit-test hook: the button owns the pointer capture for the whole
 * gesture, so useHoldEntry finds these with elementFromPoint rather than by pointer events of
 * their own. `pointer-events: none` in the CSS for the same reason — nothing here is clicked.
 */
export function HoldTargets({ hover, placement }: { hover: HoldTarget | null; placement: 'above' | 'below' }) {
  const C = appConfig.copy.journal
  return (
    <span className={`hold-targets hold-targets-${placement}`} aria-hidden>
      <span className={`hold-target${hover === 'audio' ? ' on' : ''}`} data-hold-target="audio">
        <Icon id="mic" />{C.record}
      </span>
      <span className={`hold-target${hover === 'photo' ? ' on' : ''}`} data-hold-target="photo">
        <Icon id="cam" />{C.photo}
      </span>
    </span>
  )
}
