import { appConfig } from '../../config/appConfig'
import { fillTemplate } from '../../lib/format'
import { Icon } from '../../lib/icons'

/**
 * The Suche's door (26.09.2026, design «F»): a tool-rail footer button, right beside Ebenen on the
 * Karte and at the end of a plan's rail — the same button on the phone's tool bar and on a
 * tablet's rail. It TOGGLES, like Ebenen: the card it opens stands right beside it, never out of
 * sight. It carries NO count (29.09.2026, sweep K1): the top bar's red «vermisst» chip is the
 * alarm on every surface, and a second red «1» 500px away read as a second problem. The tile is
 * the door; its lit state says the card is open. The count still names it for a screen reader.
 */
export function SucheToolButton({ on, count, onClick }: { on: boolean; count: number; onClick: () => void }) {
  const C = appConfig.copy.suche
  const label = count > 0 ? `${C.title} · ${fillTemplate(C.vermisstChip, { n: count })}` : C.title
  return (
    <button type="button" className={`vrail-nbtn vrail-suche${on ? ' on' : ''}`} title={label} aria-label={label} aria-pressed={on} onClick={onClick}>
      <span className="vrail-glyph"><Icon id="search" /></span>
      <span className="vrail-label">{C.title}</span>
    </button>
  )
}
