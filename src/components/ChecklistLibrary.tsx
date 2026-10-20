import { useEffect, useMemo, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'
import { fillTemplate } from '../lib/format'
import { useMediaQuery } from '../lib/useIsPhone'
import type { ChecklistTemplate, DeviceGroup, HitReason, RefEntry } from '../lib/checklists'
import { chapterOf, deviceOf, isTickable, manualGroups, readingPoints, searchLibrary, snippet, warmTemplates } from '../lib/checklists'
import { EmptyState } from './EmptyState'
import { LoadingStatus } from './ShellLoader'
import { ChecklistReader } from './ChecklistRunner'
import { ChecklistEntryReader } from './ChecklistReference'
import { ManualReader } from './ManualReader'
import { DevicePage } from './DeviceManuals'
import { BackRow, ListGroup } from './ListRow'
import { DeviceList, EntryRow, TemplateRow } from './ChecklistRail'
import { useRememberedScroll } from '../lib/rememberedScroll'
import s from './Checklists.module.css'
import l from './ChecklistLibrary.module.css'

// The station's checklists and Anleitungen to READ without an Einsatz – the «Checkliste» surface
// of Karte & Objekte (KarteApp, 19.10.2026). Read-only: nothing is ticked, nothing is stored on
// the server. `query` is the search typed into the Karte's top bar while this surface is shown.
//
// Contract between the Karte (which hosts it) and the library (which owns everything inside):
// the Karte passes the query and nothing else; the library keeps its own selection – per tab in
// sessionStorage, so Karte ↔ Checkliste and back lands on the same page. The Karte also owns the
// FRAME (the Einsatz surfaces' `.shell`, under its bar): the library's root fills it and never
// positions itself (`.lib`), or it would be inset twice.
//
// «Geräte first» (owner pick): the devices with their pictures, then the checklists «zum Lesen»,
// then the Einsatzwissen – each reference template's Stichworte as a group of its own (Taktik ·
// Stichworte, Grundlagen · Infos), top level on a phone too (owner, review round 2: «don't fold
// einsatzwissen … just requiring some more scrolling»). A device opens its chapter
// page, a chapter the Anleitung with «Kapitel k von n» (DeviceManuals, ManualReader – the same
// pieces the Einsatz rail shows). The search goes over everything (lib/checklists ·
// searchLibrary). Phone (≤ 760px, the Einsatz rail's breakpoint): list ↔ page with a back row.
// Tablet: a list column beside the document, the Einsatz Checkliste's layout.

/** What is open: a device page (id = device name), an Anleitung, a checklist to read or a
 *  Stichwort. */
type LibSel = { kind: 'device' | 'manual' | 'tpl' | 'entry'; id: string }
/** a selection resolved against the loaded templates */
type Open =
  | { kind: 'device'; group: DeviceGroup }
  | { kind: 'manual'; manual: ChecklistTemplate }
  | { kind: 'tpl'; template: ChecklistTemplate }
  | { kind: 'entry'; entry: RefEntry; template: ChecklistTemplate }
/** an open page's stable key – its scroll memory and the lit row in the list column */
const keyOf = (o: Open) =>
  `${o.kind}:${o.kind === 'device' ? o.group.device : o.kind === 'manual' ? o.manual.id : o.kind === 'entry' ? o.entry.id : o.template.id}`

const SEL_KEY = 'kp.lib.sel'
function readSel(): LibSel | null {
  try { return JSON.parse(sessionStorage.getItem(SEL_KEY) ?? 'null') as LibSel | null } catch { return null }
}
function writeSel(v: LibSel | null) {
  try { sessionStorage.setItem(SEL_KEY, JSON.stringify(v)) } catch { /* the place is a convenience */ }
}

/** `text` with every occurrence of `q` marked – the search hit in a result's title */
function Marked({ text, q }: { text: string; q: string }) {
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1
  if (at < 0) return <>{text}</>
  return <>{text.slice(0, at)}<mark className={l.hit}>{text.slice(at, at + q.length)}</mark><Marked text={text.slice(at + q.length)} q={q} /></>
}

/** a hit's reason, as the words under or beside its title */
function reasonText(why: HitReason, q: string): string | null {
  if (!why) return null
  return 'keyword' in why ? fillTemplate(appConfig.copy.checklists.hitKeyword, { k: why.keyword }) : `«${snippet(why.text, q)}»`
}

export function ChecklistLibrary({ query }: { query: string }) {
  const CL = appConfig.copy.checklists
  const narrow = useMediaQuery('(max-width: 760px)')

  // the templates: already warm when an Einsatz was open this session, otherwise started HERE –
  // which also starts the step pictures' offline prefetch (warmManualImages), since the Karte
  // home never opened the Einsatz surface that used to start it
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([])
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let alive = true
    const apply = (t: ChecklistTemplate[]) => { if (alive) { setTemplates(t); setReady(true) } }
    const { list, newer } = warmTemplates()
    void list.then(apply)
    void newer?.then(apply)
    return () => { alive = false }
  }, [])

  const devices = useMemo(() => manualGroups(templates, ''), [templates])
  const manuals = useMemo(() => templates.filter((t) => t.kind === 'manual'), [templates])
  const checklists = useMemo(() => templates.filter(isTickable), [templates])
  const references = useMemo(() => templates.filter((t) => t.kind === 'reference'), [templates])
  const q = query.trim()
  const hits = useMemo(() => searchLibrary(templates, q), [templates, q])

  const [stored, setStored] = useState<LibSel | null>(readSel)
  const setSel = (v: LibSel | null) => { setStored(v); writeSel(v) }
  // a new search on a phone shows its results: the open page would hide them (adjusted while
  // rendering, React's «state from a changed prop» – not in an effect, which would paint once more)
  const [searched, setSearched] = useState(q)
  if (q !== searched) {
    setSearched(q)
    if (narrow && q) { setStored(null); writeSel(null) }
  }

  const find = (v: LibSel | null): Open | null => {
    if (!v) return null
    switch (v.kind) {
      case 'device': { const group = devices.find((d) => d.device === v.id); return group ? { kind: 'device', group } : null }
      case 'manual': { const manual = manuals.find((x) => x.id === v.id); return manual ? { kind: 'manual', manual } : null }
      case 'tpl': { const template = checklists.find((x) => x.id === v.id); return template ? { kind: 'tpl', template } : null }
      case 'entry': {
        for (const template of references) {
          const entry = template.entries?.find((x) => x.id === v.id)
          if (entry) return { kind: 'entry', entry, template }
        }
        return null
      }
      default: return null // a kind of an older build (the phone's folded Einsatzwissen, «ref»)
    }
  }
  // a remembered place whose content is gone since counts as none
  const open = ready ? find(stored) : null
  // the tablet always shows a document: the first device, when nothing was picked
  const first = devices[0]
  const shown = open ?? (!narrow && first ? find(first.manuals.length > 1 ? { kind: 'device', id: first.device } : { kind: 'manual', id: first.manuals[0].id }) : null)

  /** open a device: its page, or straight its one Anleitung */
  const openDevice = (g: DeviceGroup) => setSel(g.manuals.length > 1 ? { kind: 'device', id: g.device } : { kind: 'manual', id: g.manuals[0].id })
  const chapter = shown?.kind === 'manual' ? chapterOf(devices, shown.manual.id) : null
  const litDevice = shown?.kind === 'device' ? shown.group.device : shown?.kind === 'manual' ? deviceOf(shown.manual) : null
  const isOn = (kind: LibSel['kind'], id: string) =>
    !narrow && !!shown && (kind === 'device' ? litDevice === id : keyOf(shown) === `${kind}:${id}`)

  const listRef = useRememberedScroll<HTMLElement>(`lib|list|${q ? 'q' : ''}`)
  const docKey = shown ? `lib|${keyOf(shown)}` : null
  const docRef = useRememberedScroll<HTMLElement>(docKey)

  if (ready && !templates.length) {
    return <div className={l.lib}><EmptyState className="empty-fill" icon="check" title={CL.none} /></div>
  }
  if (!ready) {
    return <div className={l.lib}><div className="workspace-loading"><LoadingStatus>{appConfig.copy.loading}</LoadingStatus></div></div>
  }

  // ---- the lists (ChecklistRail: the same groups and rows as the Einsatz rail) ----
  const look = narrow ? 'card' : 'rail'
  const results = (
    <>
      {hits.manuals.length > 0 && (
        <ListGroup label={CL.groupManuals} look={look}>
          {hits.manuals.map(({ item: t, why }) => (
            <TemplateRow key={t.id} template={t} title={<Marked text={t.title} q={q} />}
              sub={[deviceOf(t), reasonText(why, q)].filter(Boolean).join(' · ')}
              on={isOn('manual', t.id)} onOpen={() => setSel({ kind: 'manual', id: t.id })} />
          ))}
        </ListGroup>
      )}
      {hits.checklists.length > 0 && (
        <ListGroup label={CL.groupChecklists} look={look}>
          {hits.checklists.map(({ item: t, why }) => (
            <TemplateRow key={t.id} template={t} title={<Marked text={t.title} q={q} />} sub={reasonText(why, q)}
              on={isOn('tpl', t.id)} onOpen={() => setSel({ kind: 'tpl', id: t.id })} />
          ))}
        </ListGroup>
      )}
      {hits.references.map(({ template, entries }) => (
        <ListGroup key={template.id} label={template.title} look={look}>
          {entries.map(({ item: e, why }) => (
            <EntryRow key={e.id} entry={e} title={<Marked text={e.title} q={q} />} sub={reasonText(why, q)}
              on={isOn('entry', e.id)} onOpen={() => setSel({ kind: 'entry', id: e.id })} />
          ))}
        </ListGroup>
      ))}
      {!hits.manuals.length && !hits.checklists.length && !hits.references.length
        ? <p className="no-hits">{fillTemplate(appConfig.copy.noHits, { q })}</p>
        : <p className={l.hint}><Icon id="info" />{CL.searchEverything}</p>}
    </>
  )

  const home = (
    <>
      {devices.length > 0 && (
        <ListGroup label={CL.groupManuals} end={String(manuals.length)} look={look} bare>
          <DeviceList groups={devices} look={look} isOn={(g) => isOn('device', g.device)} onOpen={openDevice} />
        </ListGroup>
      )}
      {checklists.length > 0 && (
        <ListGroup label={CL.groupChecklists} end={CL.readOnlyTag} look={look}>
          {checklists.map((t) => (
            <TemplateRow key={t.id} template={t}
              end={narrow ? fillTemplate(CL.phases, { n: (t.phases ?? []).length }) : null}
              on={isOn('tpl', t.id)} onOpen={() => setSel({ kind: 'tpl', id: t.id })} />
          ))}
        </ListGroup>
      )}
      {/* the Einsatzwissen: each template's Stichworte as a group, as in the Einsatz rail */}
      {references.map((t) => (
        <ListGroup key={t.id} label={t.title} look={look}>
          {(t.entries ?? []).map((e) => (
            <EntryRow key={e.id} entry={e} on={isOn('entry', e.id)} onOpen={() => setSel({ kind: 'entry', id: e.id })} />
          ))}
        </ListGroup>
      ))}
    </>
  )

  // ---- the document ----
  const doc = (() => {
    if (!shown) return null
    switch (shown.kind) {
      case 'device': return <DevicePage group={shown.group} onChapter={(id) => setSel({ kind: 'manual', id })} />
      case 'manual': return (
        <ManualReader
          manual={shown.manual}
          chapter={chapter && {
            ...chapter,
            onGo: (id) => setSel({ kind: 'manual', id }),
          }}
        />
      )
      case 'tpl': return <ChecklistReader template={shown.template} />
      case 'entry': return <ChecklistEntryReader entry={shown.entry} template={shown.template} />
    }
  })()

  if (!narrow) {
    return (
      <div className={l.lib}>
        <nav ref={listRef} className={cx(s['cl-rail'], l.column)} aria-label={appConfig.copy.modes.checklists}>
          {q ? results : home}
        </nav>
        <main ref={docRef} className={s['cl-main']}>
          {/* a chapter's way back names its device («‹ TLF», owner 19.10.2026: the device name in
              the meta line alone was no clear way back) */}
          {shown?.kind === 'manual' && chapter && (
            <BackRow className={s['cl-doc-back']} label={chapter.group.device} onClick={() => setSel({ kind: 'device', id: chapter.group.device })} />
          )}
          {doc}
        </main>
      </div>
    )
  }

  // ---- phone: the list, or one page with a way back ----
  if (!open) {
    return (
      <div className={l.lib}>
        <main ref={listRef} className={cx(s['cl-main'], l.home)} aria-label={appConfig.copy.modes.checklists}>{q ? results : home}</main>
      </div>
    )
  }
  // one step up: a chapter goes back to its device; everything else to the list (or to the search
  // it was found by)
  const up: LibSel | null = open.kind === 'manual' && chapter ? { kind: 'device', id: chapter.group.device } : null
  const pageTitle =
    open.kind === 'device' ? null
    : open.kind === 'manual' ? open.manual.title
    : open.kind === 'entry' ? open.entry.title
    : open.template.title
  // the back row always names where it goes – «‹ TLF», «‹ Checkliste» (owner 19.10.2026: a
  // chapter's way back to its device must be obvious); the page's own title stands under it
  const upLabel = up?.kind === 'device' ? up.id : appConfig.copy.modes.checklists
  return (
    <div className={l.lib}>
      <BackRow label={upLabel} onClick={() => setSel(up)} />
      {/* the device page names itself under its picture */}
      {pageTitle !== null && (
        <div className={l.pageHead}>
          <h2 className={l.pageTitle}>{pageTitle}</h2>
          {open.kind === 'entry' && open.entry.hazardColor && (
            <span className={cx(s['cl-head-hz'], s[`hz-${open.entry.hazardColor}`])}>
              <i className={s['cl-ref-chip']} />{CL.hazardLabels[open.entry.hazardColor] ?? open.entry.hazardColor}
            </span>
          )}
          {open.kind === 'tpl' && <span className={l.backEnd}>{fillTemplate(CL.points, { n: readingPoints(open.template) })}</span>}
        </div>
      )}
      <main ref={docRef} className={cx(s['cl-main'], open.kind === 'device' && l.home)}>{doc}</main>
    </div>
  )
}
