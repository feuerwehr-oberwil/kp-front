import { Icon } from '../lib/icons'

/**
 * One row of an app menu that PICKS one of several values — a leading tick on the current one.
 *
 * Shared on purpose: the line editor's «Typ» and «Gehört zu Trupp …» (DrawEditor), the map marker's
 * «Atemschutz-Trupp» (MapMarkers) and the plan chip's twin of it (Whiteboard) are the same
 * control asked from three places, and three private copies of the row is how they drift apart.
 * Never a native `<select>` — see docs/ui-conventions.md · Editor sheets.
 */
export function MenuPick({ label, on, badge }: {
  label: string
  on: boolean
  /** a short code shown before the word – the FKS letter of a line's «Typ» (DrawEditor) */
  badge?: string
}) {
  return (
    <>
      <span className={`de-menu-tick${on ? ' on' : ''}`} aria-hidden><Icon id="check" /></span>
      {badge && <span className="de-menu-badge" aria-hidden>{badge}</span>}
      <span>{label}</span>
    </>
  )
}
