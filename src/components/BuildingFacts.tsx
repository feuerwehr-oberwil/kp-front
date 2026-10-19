import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import type { BuildingChip } from '../lib/buildingCard'
import s from './BuildingFacts.module.css'

// What a building says, drawn ONE way wherever it is shown: the Karte's panel (karte/KartePanel ·
// «Gebäude laut Register», the station's word) and the Einsatz's «Gebäude» card (BuildingCard).
// Both read the same `lib/buildingCard` data; they had two tag recipes and two note layouts
// (reuse audit, 19.10.2026). The callers decide WHICH chips and notes, and where they stand.

/** One row of read-only register tags (`buildingChips`, split by the caller into hazards and
 *  facts). A hazard is the amber tag WITH the warn glyph and its word, never colour alone. */
export function RegisterTags({ chips, className }: { chips: BuildingChip[]; className?: string }) {
  if (!chips.length) return null
  return (
    <ul className={cx(s.tags, className)}>
      {chips.map((c) => (
        <li key={c.key} className={cx(s.tag, c.hazard && s.hazard)} title={c.title}>
          {c.hazard && <Icon id="warn" />}<span>{c.text}</span>
        </li>
      ))}
    </ul>
  )
}

/** The station's own word about the object – Sofortmassnahmen (read first, full ink) and
 *  Bemerkungen (quieter), each under its head – then whose notes they are (`source`). Lines come
 *  from `noteLines`; nothing to say → nothing drawn. */
export function StationNotes({ measures, remarks, source, className }: { measures: string[]; remarks: string[]; source?: string; className?: string }) {
  if (!measures.length && !remarks.length) return null
  const C = appConfig.copy.building
  return (
    <div className={cx(s.notes, className)}>
      {measures.length > 0 && (
        <>
          <div className={s.head}>{C.measures}</div>
          <ul className={s.lines}>{measures.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </>
      )}
      {remarks.length > 0 && (
        <>
          <div className={s.head}>{C.remarks}</div>
          <ul className={cx(s.lines, s.quiet)}>{remarks.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </>
      )}
      {source && <p className={s.source}>{source}</p>}
    </div>
  )
}
