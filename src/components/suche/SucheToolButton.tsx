import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { Icon } from '../../lib/icons'

/**
 * The Suche's door (26.09.2026, design «F»): a tool-rail footer button, right beside Ebenen on the
 * Karte and at the end of a plan's rail — the same button on the phone's tool bar and on a
 * tablet's rail. It carries the red count of people still missing in the rail's one badge idiom
 * (05-navrail · `.nav-count.nav-vermisst`). It TOGGLES, like Ebenen: the card it opens stands
 * right beside it, never out of sight.
 */
export function SucheToolButton({ on, count, onClick }: { on: boolean; count: number; onClick: () => void }) {
  const C = appConfig.copy.suche
  const label = count > 0 ? `${C.title} · ${fillTemplate(C.vermisstChip, { n: count })}` : C.title
  return (
    <button type="button" className={`vrail-nbtn vrail-suche${on ? ' on' : ''}`} title={label} aria-label={label} aria-pressed={on} onClick={onClick}>
      <span className="vrail-glyph">
        <Icon id="search" />
        {count > 0 && <span className="nav-live nav-count nav-vermisst" aria-hidden>{count > 99 ? '99+' : count}</span>}
      </span>
      <span className="vrail-label">{C.title}</span>
    </button>
  )
}
