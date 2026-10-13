import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { IconButton } from './Button'
import type { BuildingInfo } from '../lib/api/building'
import { buildingChips, buildingSources, hasBuildingContent, noteLines, objectCaption, visitLine, type BuildingChip } from '../lib/buildingCard'
import s from './BuildingCard.module.css'

/**
 * «Gebäude» — the building at the Einsatzort (KP Front card F5). Opened from its chip on the Karte
 * and in the plan's chip row (BuildingFloat); `onClose` draws the card's ✕.
 *
 * What must be read comes first, so it stands in view without scrolling when the card opens by
 * itself (lib/buildingFirstOpen; on a phone the card is at most 56vh): the hazard tags (the card
 * pill's look, the warn glyph AND the word), then the Einsatzobjekt's Sofortmassnahmen and
 * Bemerkungen as text when the station wrote some, with whose notes they are. Below them the
 * register facts as plain tags with their one line of sources, and the last Objektbesuch.
 * Nothing to say → nothing drawn (lib/buildingCard).
 */
export function BuildingCard({ info, onClose }: { info: BuildingInfo | null; onClose?: () => void }) {
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
        {chips.length > 0 && <span className={s.hint} title={C.hintTitle}><Icon id="info" />{C.hint}</span>}
        {onClose && (
          <IconButton label={appConfig.copy.closeDialog} className={s.close} onClick={onClose}><Icon id="close" /></IconButton>
        )}
      </div>
      <Tags chips={hazards} />
      {measures.length > 0 && <Notes label={C.measures} lines={measures} strong />}
      {remarks.length > 0 && <Notes label={C.remarks} lines={remarks} />}
      {caption && <p className={s.sources}>{caption}</p>}
      <Tags chips={facts} className={measures.length || remarks.length ? s.facts : undefined} />
      {sources && <p className={s.sources}>{sources}</p>}
      {visit && <p className={s.visit}><Icon id="clipboard" /><span>{visit}</span></p>}
    </section>
  )
}

function Tags({ chips, className }: { chips: BuildingChip[]; className?: string }) {
  if (!chips.length) return null
  return (
    <ul className={className ? `${s.chips} ${className}` : s.chips}>
      {chips.map((c) => (
        <li key={c.key} className={c.hazard ? `${s.chip} ${s.hazard}` : s.chip} title={c.title}>
          {c.hazard && <Icon id="warn" />}<span>{c.text}</span>
        </li>
      ))}
    </ul>
  )
}

function Notes({ label, lines, strong = false }: { label: string; lines: string[]; strong?: boolean }) {
  return (
    <div className={strong ? `${s.notes} ${s.measures}` : s.notes}>
      <div className={s.notesLabel}>{label}</div>
      <ul className={s.lines}>
        {lines.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
    </div>
  )
}
