import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'

/**
 * One row of an app menu that PICKS one of several values — the Menu radio's mark on the current
 * one: a TRAILING ✓ in the choice blue, and the word for a screen reader (duck sweep ELEM.7,
 * 17.11.2026). It was a leading blue ✓, `aria-hidden` – the checkbox's slot, which reads «several»,
 * and nothing told a screen reader which row was the pick.
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
      {badge && <span className="de-menu-badge" aria-hidden>{badge}</span>}
      <span>{label}</span>
      <span className={`de-menu-tick${on ? ' on' : ''}`} aria-hidden><Icon id="check" /></span>
      {on && <span className="sr-only">{appConfig.copy.drawingEditor.menuPicked}</span>}
    </>
  )
}
