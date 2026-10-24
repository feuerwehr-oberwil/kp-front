import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import type { ChecklistTemplate, DeviceGroup, RefEntry } from '../lib/checklists'
import { ListCard, ListRow } from './ListRow'
import { DeviceTile } from './DeviceManuals'
import s from './Checklists.module.css'

// The Checkliste lists' groups and rows – ONE implementation for the two places that list the
// station's checklists, Stichworte and Anleitungen (20.10.2026, Karte Haus round 3 · point 4,
// owner: «the landing is the reference»): the Karte's Checkliste surface (ChecklistLibrary) and the
// Einsatz Checkliste rail (ChecklistsView). Each host keeps its ORDER and its own facts – the
// landing reads («3 Phasen», search reasons), the Einsatz ticks («40%» at a list's end, Aufgaben
// first, Anleitungen last) – but a group, a row and a device look the same in both.
//
// The groups are THE `ListGroup` (components/ListRow) in the host's look.
// `look`: 'card' on a phone (groups on white cards, 56px rows, the devices as thumbnail rows), 'rail'
// in a list column beside a document (compact rows on the column's ground, devices as rows).

export type RailLook = 'card' | 'rail'

/** a template's row: the empty boxes (an Aufgaben list), the Rapport glyph or the document (an Anleitung) */
export function TemplateRow({ template, title, sub, end, on, onOpen }: {
  template: ChecklistTemplate
  /** default: the template's title (the library passes it with the search hit marked) */
  title?: ReactNode
  sub?: ReactNode
  end?: ReactNode
  on?: boolean
  onOpen: () => void
}) {
  return (
    <ListRow lead={<Icon id={template.kind === 'rapport' ? 'history' : template.kind === 'manual' ? 'doc' : 'tasks'} />} title={title ?? template.title}
      sub={sub} end={end} on={on} onClick={onOpen} />
  )
}

/** a Stichwort row: its category dot (the hazard colour) as the lead */
export function EntryRow({ entry, title, sub, on, onOpen }: {
  entry: RefEntry; title?: ReactNode; sub?: ReactNode; on?: boolean; onOpen: () => void
}) {
  const lead = <span className={cx(s['cl-ref-lead'], entry.hazardColor && s[`hz-${entry.hazardColor}`])}><i className={s['cl-ref-chip']} /></span>
  return <ListRow lead={lead} title={title ?? entry.title} sub={sub} on={on} onClick={onOpen} />
}

/** The devices of an «Anleitungen» group: thumbnail rows in both looks – on the phone's white
 *  card as on the tablet's list column (owner 20.10.2026: «the iPad view … rows, and the image is
 *  the icon on the left»; it was two photo cards per row). */
export function DeviceList({ groups, look, isOn, onOpen }: {
  groups: DeviceGroup[]
  look: RailLook
  isOn?: (g: DeviceGroup) => boolean
  onOpen: (g: DeviceGroup) => void
}) {
  const tiles = groups.map((g) => (
    <DeviceTile key={g.device} group={g} on={isOn?.(g)} onOpen={() => onOpen(g)} />
  ))
  return <ListCard look={look}>{tiles}</ListCard>
}
