import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import type { BuildingInfo } from '../lib/api/building'
import { buildingChips, buildingSources, hasBuildingContent, noteLines, objectCaption, visitLine } from '../lib/buildingCard'
import s from './BuildingCard.module.css'

/**
 * «Gebäude» — the building at the Einsatzort, under the Einsatz card in the incident menu
 * (IncidentSwitcher · buildingSlot), on tablet and phone alike. KP Front card F5.
 *
 * Read-only tags (the card pill's look), hazards first with the warn glyph AND the word, then
 * one line of sources; the Einsatzobjekt's Sofortmassnahmen / Bemerkungen as text when the station
 * wrote some; the last Objektbesuch. Nothing to say → nothing drawn (lib/buildingCard).
 */
export function BuildingCard({ info }: { info: BuildingInfo | null }) {
  if (!info || !hasBuildingContent(info)) return null
  const C = appConfig.copy.building
  const chips = buildingChips(info)
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
      </div>
      {chips.length > 0 && (
        <ul className={s.chips}>
          {chips.map((c) => (
            <li key={c.key} className={c.hazard ? `${s.chip} ${s.hazard}` : s.chip} title={c.title}>
              {c.hazard && <Icon id="warn" />}<span>{c.text}</span>
            </li>
          ))}
        </ul>
      )}
      {sources && <p className={s.sources}>{sources}</p>}
      {measures.length > 0 && <Notes label={C.measures} lines={measures} strong />}
      {remarks.length > 0 && <Notes label={C.remarks} lines={remarks} />}
      {caption && <p className={s.sources}>{caption}</p>}
      {visit && <p className={s.visit}><Icon id="clipboard" /><span>{visit}</span></p>}
    </section>
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
