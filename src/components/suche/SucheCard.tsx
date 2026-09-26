import { useEffect, useMemo, useRef } from 'react'
import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import { sucheHeadLine, sucheOrte } from '../../lib/suche'
import { SuchePanel, type SuchePanelProps } from './SuchePanel'
import s from './Suche.module.css'

/**
 * The Suche's card (26.09.2026, the owner's design «F»): built like the Ebenen panel and standing
 * where it stands — `.layers-card`, beside the tool rail on a tablet, above the tool bar on a
 * phone — with its head (small-caps title, icon, ✕) and its way out (the ✕, a tap beside it, the
 * other map popups). It opens over the surface you are on and never takes you anywhere else.
 * Step 1 had a dock on the tablet, a peek · half · full sheet on the phone, a Gebäude | Karte
 * switch and two tabs — seven controls before the first missing person.
 */
export function SucheCard({ onClose, picking, onGone, ...panel }: SuchePanelProps & {
  onClose: () => void
  /** a pick is waiting for its tap on the surface: the card steps aside, keeping its form */
  picking?: boolean
  /** the card went away (✕, a tool, another popup): a pick it asked for goes with it */
  onGone?: () => void
}) {
  const C = appConfig.copy.suche
  const gone = useRef(onGone)
  useEffect(() => { gone.current = onGone })
  useEffect(() => () => gone.current?.(), [])
  const o = useMemo(() => sucheOrte(panel.doc, panel.floorName), [panel.doc, panel.floorName])
  const line = sucheHeadLine(o)
  return (
    <section className={`layers-card ${s.card}`} aria-label={C.title} data-suche-card data-picking={picking || undefined}>
      <div className={`lc-title ${s.head}`}>
        <Icon id="search" />{C.title}
        {line && <span className={s.headLine} data-hot={o.missing > 0 || undefined}>{line}</span>}
        <button type="button" className="lc-x" aria-label={C.close} title={C.close} onClick={onClose}><Icon id="close" /></button>
      </div>
      <SuchePanel key={panel.focus?.nonce ?? 0} {...panel} />
    </section>
  )
}
