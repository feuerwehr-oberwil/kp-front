import { Icon } from '../lib/icons'
import type { DeviceGroup } from '../lib/checklists'
import { deviceCover, deviceUpdated, fmtDay } from '../lib/checklists'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { cx } from '../lib/cx'
import m from './ManualReader.module.css'

// The Anleitungen as DEVICES (19.10.2026): one tile per Gerät – its picture, its name, and
// «n Kapitel» or the single Anleitung's title – and one page per Gerät listing its chapters.
// ONE implementation for both places that show them: the Karte's Checkliste surface
// (ChecklistLibrary – cards on a phone, rows in the tablet's list column) and the Einsatz
// Checkliste rail (ChecklistsView – rows, still the last group there). A device with one
// Anleitung has no page: its tile opens the Anleitung (the caller decides, `onOpen`).

/** what a device tile says under the name: «11 Kapitel», or the one Anleitung's title */
function deviceSubtitle(group: DeviceGroup): string {
  return group.manuals.length > 1
    ? fillTemplate(appConfig.copy.checklists.chapters, { n: group.manuals.length })
    : group.manuals[0]?.title ?? ''
}

/** One device as a tappable tile. `card` = the phone library's photo card (2 per row), `row` =
 *  a list row with a thumbnail (the Einsatz rail, the tablet's list column). */
export function DeviceTile({ group, variant, on, onOpen }: {
  group: DeviceGroup
  variant: 'card' | 'row'
  /** the device (or one of its chapters) is what the document pane shows */
  on?: boolean
  onOpen: () => void
}) {
  const cover = deviceCover(group)
  return (
    <button type="button" className={cx(m[`dv-${variant}`], on && m.on)} onClick={onOpen} aria-current={on || undefined}>
      <span className={m['dv-pic']} aria-hidden="true">
        {cover ? <img src={cover} alt="" loading="lazy" decoding="async" /> : <Icon id="doc" />}
      </span>
      <span className={m['dv-text']}>
        <span className={m['dv-name']}>{group.device}</span>
        <span className={m['dv-sub']}>{deviceSubtitle(group)}</span>
      </span>
      {variant === 'row' && <Icon id="chevron" />}
    </button>
  )
}

/** A device's page: its picture, its name, «n Kapitel · Stand …», and the chapters numbered in
 *  the manifest's order. A chapter opens the Anleitung (`onChapter`). */
export function DevicePage({ group, onChapter }: { group: DeviceGroup; onChapter: (manualId: string) => void }) {
  const CL = appConfig.copy.checklists
  const cover = deviceCover(group)
  const updated = deviceUpdated(group)
  const meta = [
    fillTemplate(CL.chapters, { n: group.manuals.length }),
    updated ? fillTemplate(CL.manualUpdated, { date: fmtDay(updated) }) : null,
  ].filter(Boolean).join(' · ')
  return (
    <article className={m['dv-page']}>
      {cover && <img className={m['dv-hero']} src={cover} alt="" decoding="async" />}
      <header className={m['dv-head']}>
        <h2>{group.device}</h2>
        <p>{meta}</p>
      </header>
      <ol className={m['dv-chapters']} aria-label={group.device}>
        {group.manuals.map((t, i) => (
          <li key={t.id}>
            <button type="button" className={m['dv-chapter']} onClick={() => onChapter(t.id)}>
              <span className={m['dv-num']} aria-hidden="true">{i + 1}</span>
              <span className={m['dv-chapter-title']}>{t.title}</span>
              <Icon id="chevron" />
            </button>
          </li>
        ))}
      </ol>
    </article>
  )
}
