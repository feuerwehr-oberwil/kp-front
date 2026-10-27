import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { Icon } from '../lib/icons'
import { IconButton } from './Button'
import type { BuildingInfo } from '../lib/api/building'
import { buildingChips, buildingSources, hasBuildingContent, noteLines, objectCaption, visitLine } from '../lib/buildingCard'
import { RegisterHintBody, RegisterHintButton, RegisterSection, StationNotes } from './BuildingFacts'
import s from './BuildingCard.module.css'

/**
 * «Gebäude» — the building at the Einsatzort (KP Front card F5). Opened from its chip on the Karte
 * and in the plan's chip row (BuildingFloat); `onClose` draws the card's ✕.
 *
 * Two steps, one heading style (owner, 27.10.2026: «a clear two-step thing: first
 * "Sofortmassnahmen" then "Gebäude"»): the Einsatzobjekt's Sofortmassnahmen and Bemerkungen when
 * the station wrote some (named only when they are a neighbour's, `objectCaption`), then «Gebäude»
 * – the hazard lines first (the warn glyph as the bullet), then the register facts, all one size
 * and weight – then the last Objektbesuch. The head row holds only «Register-Hinweis» and ✕. The
 * pieces are the Karte panel's own (BuildingFacts), so the two surfaces cannot drift apart.
 * Nothing to say → nothing drawn (lib/buildingCard).
 */
export function BuildingCard({ info, onClose }: { info: BuildingInfo | null; onClose?: () => void }) {
  const [hint, setHint] = useState(false)
  if (!info || !hasBuildingContent(info)) return null
  const C = appConfig.copy.building
  const chips = buildingChips(info)
  // the hazards first inside «Gebäude», then the facts
  const lines = [...chips.filter((c) => c.hazard), ...chips.filter((c) => !c.hazard)]
  const sources = buildingSources(info)
  const measures = noteLines(info.object?.measures)
  const remarks = noteLines(info.object?.remarks)
  const caption = measures.length || remarks.length ? objectCaption(info) : ''
  const visit = visitLine(info)
  return (
    <section className={s.card} aria-label={C.title}>
      {/* no «Gebäude» title up here: the word heads the register's section below; the card keeps
          it as its accessible name (owner, 27.10.2026) */}
      <div className={s.head}>
        {chips.length > 0 && <RegisterHintButton className={cx(s.hint, s.hintBtn)} open={hint} onToggle={() => setHint((o) => !o)} />}
        {onClose && (
          <IconButton label={appConfig.copy.closeDialog} className={s.close} onClick={onClose}><Icon id="close" /></IconButton>
        )}
      </div>
      <StationNotes measures={measures} remarks={remarks} source={caption} />
      <RegisterSection title={C.title} chips={lines} className={measures.length || remarks.length ? s.facts : undefined} />
      {hint && <RegisterHintBody className={s.hintBody} textClassName={s.sources}>{sources && <div className={s.sources}>{sources}</div>}</RegisterHintBody>}
      {visit && <p className={s.visit}><Icon id="clipboard" /><span>{visit}</span></p>}
    </section>
  )
}
