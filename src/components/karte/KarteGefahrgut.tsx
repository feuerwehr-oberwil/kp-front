// «Karte & Objekte» — Gefahrgut as a tool of its own: a UN number looked up WITHOUT placing a
// Gefahrentafel. The readout is the Gefahrentafel's own (UnHazardSection: ADR, Kemler, ERG,
// source), and its rings are temporary map overlays that die with this card — nothing is placed,
// nothing is stored (lib/karte/session). Offline: the ADR/ERG tables are on the device.

import { appConfig } from '../../config/appConfig'
import { Icon } from '../../lib/icons'
import type { ErgRingMode } from '../../lib/ergRings'
import { lookupErg } from '../../lib/erg'
import { IconButton } from '../Button'
import { UnHazardSection } from '../UnHazardSection'
import type { LngLat } from '../../types'
import s from './Karte.module.css'

export function KarteGefahrgut({ un, onUn, mode, onMode, center, onClose }: {
  un: string
  onUn: (v: string) => void
  mode: ErgRingMode
  onMode: (m: ErgRingMode) => void
  /** where the rings stand — null until the map is tapped (or a place is selected) */
  center: LngLat | null
  onClose: () => void
}) {
  const C = appConfig.copy.karte
  return (
    <section className={s.toolCard} aria-label={C.tools.erg}>
      <div className={s.toolHead}>
        <h3>{C.tools.erg}</h3>
        <IconButton label={appConfig.copy.closeDialog} variant="secondary" onClick={onClose}><Icon id="close" /></IconButton>
      </div>
      <div className={s.toolBody}>
        <label className={s.fieldLabel} htmlFor="karte-un">{C.ergUn}</label>
        <input
          id="karte-un" className={s.field} inputMode="numeric" autoComplete="off" maxLength={4}
          placeholder={C.ergPlaceholder} value={un} onChange={(e) => onUn(e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
        {!un && <div className={s.src}>{C.ergOffline}</div>}
        {un && (
          <UnHazardSection un={un} ringMode={mode} onRingMode={onMode} ergCoord={center ?? undefined} />
        )}
        {un && mode !== 'off' && !!lookupErg(un)?.tih?.length && <div className={s.src}>{center ? C.ergCenter : C.ergCenterFirst}</div>}
      </div>
    </section>
  )
}
