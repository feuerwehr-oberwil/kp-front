import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { cx } from '../lib/cx'
import { Icon } from '../lib/icons'
import { IconButton } from './Button'
import type { BuildingInfo } from '../lib/api/building'
import { buildingChips, buildingSources, hasBuildingContent, noteLines, objectCaption, visitLine } from '../lib/buildingCard'
import { RegisterHintBody, RegisterHintButton, RegisterLines, StationNotes } from './BuildingFacts'
import s from './BuildingCard.module.css'

/**
 * «Gebäude» — the building at the Einsatzort (KP Front card F5). Opened from its chip on the Karte
 * and in the plan's chip row (BuildingFloat); `onClose` draws the card's ✕.
 *
 * What must be read comes first, so it stands in view without scrolling when the card opens by
 * itself (lib/buildingFirstOpen; on a phone the card is at most 56vh): the hazard lines (the
 * warn glyph as the bullet AND the word), then the Einsatzobjekt's Sofortmassnahmen and Bemerkungen
 * as text when the station wrote some, with whose notes they are. Below them the register facts
 * as plain bullets with their one line of sources, and the last Objektbesuch. Bullets, not tags
 * (owner, 27.10.2026: «convert this to bullet points instead of the tags»), the Karte panel's own
 * pieces (BuildingFacts), so the two surfaces cannot drift apart.
 * Nothing to say → nothing drawn (lib/buildingCard).
 */
export function BuildingCard({ info, onClose }: { info: BuildingInfo | null; onClose?: () => void }) {
  const [hint, setHint] = useState(false)
  if (!info || !hasBuildingContent(info)) return null
  const C = appConfig.copy.building
  const chips = buildingChips(info)
  const hazards = chips.filter((c) => c.hazard)
  const facts = chips.filter((c) => !c.hazard)
  const sources = buildingSources(info)
  const measures = noteLines(info.object?.measures)
  const remarks = noteLines(info.object?.remarks)
  const caption = measures.length || remarks.length ? objectCaption(info) : ''
  const visit = visitLine(info)
  return (
    <section className={s.card} aria-label={C.title}>
      <div className={s.head}>
        <span className={s.title}><Icon id="floors" />{C.title}</span>
        {chips.length > 0 && <RegisterHintButton className={cx(s.hint, s.hintBtn)} open={hint} onToggle={() => setHint((o) => !o)} />}
        {onClose && (
          <IconButton label={appConfig.copy.closeDialog} className={s.close} onClick={onClose}><Icon id="close" /></IconButton>
        )}
      </div>
      <RegisterLines chips={hazards} />
      <StationNotes measures={measures} remarks={remarks} source={caption} className={s.notes} />
      <RegisterLines chips={facts} className={measures.length || remarks.length ? s.facts : undefined} />
      {hint && <RegisterHintBody className={s.hintBody} textClassName={s.sources}>{sources && <div className={s.sources}>{sources}</div>}</RegisterHintBody>}
      {visit && <p className={s.visit}><Icon id="clipboard" /><span>{visit}</span></p>}
    </section>
  )
}
