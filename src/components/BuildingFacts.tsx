import type { ReactNode } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import type { BuildingChip } from '../lib/buildingCard'
import { externalMapLinks } from '../lib/deploymentConfig'
import { useOnline } from '../lib/useOnline'
import s from './BuildingFacts.module.css'

// What a building says, drawn ONE way wherever it is shown: the Karte's panel (karte/KartePanel ·
// «Gebäude laut Register», the station's word) and the Einsatz's «Gebäude» card (BuildingCard).
// Both read the same `lib/buildingCard` data; they had two tag recipes and two note layouts
// (reuse audit, 19.10.2026). The callers decide WHICH facts and notes, and where they stand; both
// draw the facts as bullet lines since 27.10.2026 (they were tags).

/** The register facts (`buildingChips`) as a bullet list, one fact a line, read like the
 *  station's notes (owner, 27.10.2026: «bullet points instead of the tags» – the Karte panel and the
 *  Einsatz's Gebäude card alike), the size and weight of the Sofortmassnahmen, one step quieter in
 *  colour (owner, 12.11.2026: the register out-shouted the station's word). The caller orders them
 *  (hazards first); a hazard's bullet IS the warn glyph, and its line keeps full ink – a known
 *  hazard never fades with the rest. */
export function RegisterLines({ chips, className }: { chips: BuildingChip[]; className?: string }) {
  if (!chips.length) return null
  return (
    <ul className={cx(s.lines, s.facts, className)}>
      {chips.map((c) => (
        <li key={c.key} className={cx(c.hazard && s.hazardLine)} title={c.title}>
          {c.hazard && <Icon id="warn" />}{c.text}
        </li>
      ))}
    </ul>
  )
}

/** «Gebäude» as a section of its own under the same head as the Sofortmassnahmen (`.head`), the
 *  register lines under it – the Einsatz's Gebäude card reads «first Sofortmassnahmen, then
 *  Gebäude» (owner, 27.10.2026: «a clear two-step thing»). */
export function RegisterSection({ title, chips, className, end, below }: {
  title: string; chips: BuildingChip[]; className?: string
  /** controls on the heading's row, at its right end («Register-Hinweis», the card's ✕) */
  end?: ReactNode
  /** what opens right under the heading's row (the «Register-Hinweis» body) */
  below?: ReactNode
}) {
  if (!chips.length) return null
  return (
    <div className={cx(s.notes, className)}>
      <Head end={end}>{title}</Head>
      {below}
      <RegisterLines chips={chips} />
    </div>
  )
}

/** The station's own word about the object – Sofortmassnahmen and Bemerkungen, both in full ink
 *  (owner, 12.11.2026: the Bemerkungen were dimmed while the register beside them was bright),
 *  each under its head – then, only where the caller has one, a caption (`source`: the
 *  Gebäude card's «… · in der Nähe (120 m)»; no «Modul 1» source line since 27.10.2026). Lines come
 *  from `noteLines`; nothing to say → nothing drawn. */
export function StationNotes({ measures, remarks, source, className, end }: {
  measures: string[]; remarks: string[]; source?: string; className?: string
  /** controls on the FIRST heading's row, at its right end (the Gebäude card's ✕) */
  end?: ReactNode
}) {
  if (!measures.length && !remarks.length) return null
  const C = appConfig.copy.building
  return (
    <div className={cx(s.notes, className)}>
      {measures.length > 0 && (
        <>
          <Head end={end}>{C.measures}</Head>
          <ul className={s.lines}>{measures.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </>
      )}
      {remarks.length > 0 && (
        <>
          <Head end={measures.length ? undefined : end}>{C.remarks}</Head>
          <ul className={s.lines}>{remarks.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </>
      )}
      {source && <p className={s.source}>{source}</p>}
    </div>
  )
}

/** A section heading; with `end`, a row – the heading, then controls at its right end, so a card
 *  needs no head row of its own (owner, 27.10.2026: an empty «Register-Hinweis ✕» row was wasted). */
function Head({ children, end }: { children: ReactNode; end?: ReactNode }) {
  if (!end) return <div className={s.head}>{children}</div>
  return <div className={s.headRow}><div className={s.head}>{children}</div>{end}</div>
}

/** «Register-Hinweis» — a tap-to-open disclosure, never a `title=` tooltip: a finger gets nothing
 *  out of a tooltip (owner, 20.10.2026 · s17, on the Einsatz's Gebäude card). The label and what
 *  it opens are two pieces, because the label sits in a head row and the body stands under it.
 *  Each surface hands in its own classes and keeps its own rhythm; the markup, the copy and the
 *  aria contract are ONE. */
export function RegisterHintButton({ open, onToggle, className }: { open: boolean; onToggle: () => void; className?: string }) {
  const C = appConfig.copy.building
  return (
    <button type="button" className={className} aria-expanded={open} onClick={onToggle}>
      <Icon id="info" />{C.hint}<Icon id="chevron-down" className="chev" />
    </button>
  )
}

/** What «Register-Hinweis» opens: where the facts come from, and the caller's source/Stand line
 *  (`children`) — hidden until it is asked for. */
export function RegisterHintBody({ className, textClassName, children }: { className?: string; textClassName?: string; children?: ReactNode }) {
  const C = appConfig.copy.building
  return (
    <div className={className} data-testid="register-hint">
      <div className={textClassName}>{C.hintTitle}</div>
      {children}
    </div>
  )
}

/** The station's map links (`map.externalLinks`, /admin › Station & Karte: label + URL template
 *  with {E}/{N}) for one place, as quiet buttons at the FOOT of the Einsatz's Gebäude card and the
 *  Karte's object panel (M10, 13.11.2026 – the «Datenquellen» sheet that held them had no door).
 *  Each opens the template filled for `at` in a new tab. A station with none configured, or a place
 *  with no coordinate, draws nothing at all. Offline they stay where they are, disabled, with
 *  «Nur mit Netz» under them: a page on the open web cannot load, and a link that silently
 *  fails at 3am costs a try. */
export function GeoLinks({ at, className }: { at: readonly [number, number] | null | undefined; className?: string }) {
  const online = useOnline()
  const C = appConfig.copy.building
  const links = at ? externalMapLinks(at[0], at[1]) : []
  if (!links.length) return null
  return (
    <div className={cx(s.geo, className)} role="group" aria-label={C.geoLinks} data-section="geo-links">
      <div className={s.geoRow}>
        {links.map((l) => online
          ? <a key={l.label} className="ip-btn" href={l.href} target="_blank" rel="noopener noreferrer">{l.label}<Icon id="external" /></a>
          : <button key={l.label} type="button" className="ip-btn" disabled>{l.label}<Icon id="external" /></button>)}
      </div>
      {!online && <p className={s.geoOff}>{C.geoLinksOffline}</p>}
    </div>
  )
}
