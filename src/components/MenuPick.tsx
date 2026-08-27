import { Icon } from '../lib/icons'

/**
 * One row of an app menu that PICKS one of several values — a leading tick on the current one.
 *
 * Shared on purpose: the line editor's «Gehört zu Trupp …» (DrawEditor), the map marker's
 * «Atemschutz-Trupp» (MapMarkers) and the plan chip's twin of it (Whiteboard) are the same
 * control asked from three places, and three private copies of the row is how they drift apart.
 * Never a native `<select>` — see AGENTS.md.
 */
export function MenuPick({ label, on }: { label: string; on: boolean }) {
  return (
    <>
      <span className={`de-menu-tick${on ? ' on' : ''}`} aria-hidden><Icon id="check" /></span>
      <span>{label}</span>
    </>
  )
}
