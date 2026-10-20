import { useEffect } from 'react'
import { Icon } from '../lib/icons'
import { heldPicture, holdPicture } from '../lib/heldPictures'
import type { DeviceGroup } from '../lib/checklists'
import { deviceCover, deviceUpdated, fmtDay } from '../lib/checklists'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { ListRow } from './ListRow'
import m from './ManualReader.module.css'

// The Anleitungen as DEVICES (19.10.2026): one tile per Gerät – its picture, its name, and
// «n Kapitel» or the single Anleitung's title – and one page per Gerät listing its chapters.
// ONE implementation for both places that show them: the Karte's Checkliste surface
// (ChecklistLibrary – rows on a phone's card and in the tablet's list column) and the Einsatz
// Checkliste rail (ChecklistsView – rows, still the last group there). A device with one
// Anleitung has no page: its tile opens the Anleitung (the caller decides, `onOpen`).

/** what a device tile says under the name: «11 Kapitel», or the one Anleitung's title */
function deviceSubtitle(group: DeviceGroup): string {
  return group.manuals.length > 1
    ? fillTemplate(appConfig.copy.checklists.chapters, { n: group.manuals.length })
    : group.manuals[0]?.title ?? ''
}

/** hold a device picture's bytes for the next mount (lib/heldPictures) */
const useHeld = (url: string | null) => useEffect(() => { if (url) holdPicture(url) }, [url])

/** One device as THE list row with its picture as the lead (the Einsatz rail, the tablet's list
 *  column, the phone's card). `on` lights the row: the device (or one of its chapters) is what
 *  the document pane shows. */
export function DeviceTile({ group, on, onOpen }: {
  group: DeviceGroup
  /** the device (or one of its chapters) is what the document pane shows */
  on?: boolean
  onOpen: () => void
}) {
  const cover = deviceCover(group)
  useHeld(cover)
  // ⚠️ A held copy, and neither `loading="lazy"` nor `decoding="async"` (review round 2,
  // 19.10.2026): the cards popped in on every open of the Checkliste surface (lib/heldPictures,
  // e2e/checkliste-pictures.mjs). A station has a handful of devices; nothing to save by deferring.
  const pic = (
    <span className={m['dv-pic']} aria-hidden="true">
      {cover ? <img src={heldPicture(cover)} alt="" /> : <Icon id="doc" />}
    </span>
  )
  return <ListRow className={m['dv-row']} lead={pic} title={group.device} sub={deviceSubtitle(group)} on={on} onClick={onOpen} />
}

/** A device's page: its picture, its name, «n Kapitel · Stand …», and the chapters numbered in
 *  the manifest's order. A chapter opens the Anleitung (`onChapter`). */
export function DevicePage({ group, onChapter }: { group: DeviceGroup; onChapter: (manualId: string) => void }) {
  const CL = appConfig.copy.checklists
  const cover = deviceCover(group)
  useHeld(cover)
  const updated = deviceUpdated(group)
  const meta = [
    fillTemplate(CL.chapters, { n: group.manuals.length }),
    updated ? fillTemplate(CL.manualUpdated, { date: fmtDay(updated) }) : null,
  ].filter(Boolean).join(' · ')
  return (
    <article className={m['dv-page']}>
      {cover && <img className={m['dv-hero']} src={heldPicture(cover)} alt="" />}
      <header className={m['dv-head']}>
        <h2>{group.device}</h2>
        <p>{meta}</p>
      </header>
      {/* the chapters: THE list row, numbered – a place in a list, the reader's step number outlined */}
      <ol className={m['dv-chapters']} aria-label={group.device}>
        {group.manuals.map((t, i) => (
          <li key={t.id}>
            <ListRow lead={<span className={m['dv-num']} aria-hidden="true">{i + 1}</span>} title={t.title} onClick={() => onChapter(t.id)} />
          </li>
        ))}
      </ol>
    </article>
  )
}
