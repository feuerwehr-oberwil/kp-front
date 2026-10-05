import { LoadingStatus } from './ShellLoader'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import type { ChecklistState, ChecklistTemplate, Item, TemplateState } from '../lib/checklists'
import { allEntries, warmTemplates, matchDiveraEntries, searchEntries, templateProgress } from '../lib/checklists'
import { ChecklistRunner } from './ChecklistRunner'
import { ChecklistEntryReader } from './ChecklistReference'
import { cx } from '../lib/cx'
import { EmptyState } from './EmptyState'
import { SearchField } from './SearchField'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { useMediaQuery } from '../lib/useIsPhone'
import s from './Checklists.module.css'

const EMPTY_STATE: TemplateState = { ticks: {}, activeBranch: {} }

/* Where each list was left (05.10.2026, owner: «remember the checklist scroll position on closing
   an open checklist»). Per Einsatz and per list — the open checklist's pane and the picker each
   keep their own offset, so closing a list onto the picker and opening it again lands both where
   the reader was — the chooser above all («to quickly go through potentially similar checklists»:
   back from one list, the neighbouring one is right under the thumb). In memory only: it is a reading position for this session, not a record; a
   reload starts at the top. Module scope because the surface unmounts whenever another tab is
   shown (IncidentWorkspace · mode). */
const scrollMemory = new Map<string, number>()
/** the scroller's offset under `key`: restored when the key (or the element) appears, saved on
 *  every scroll. The returned ref goes on the element that scrolls. */
function useRememberedScroll<T extends HTMLElement>(key: string | null) {
  const ref = useRef<T>(null)
  // what was last restored: only a NEW element or a NEW key puts the offset back — a tick
  // re-renders the pane and must not jump it
  const restored = useRef<{ node: T | null; key: string | null }>({ node: null, key: null })
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || key === null) return
    if (restored.current.node !== node || restored.current.key !== key) {
      node.scrollTop = scrollMemory.get(key) ?? 0
      restored.current = { node, key }
    }
    const save = () => scrollMemory.set(key, node.scrollTop)
    node.addEventListener('scroll', save, { passive: true })
    return () => node.removeEventListener('scroll', save)
  })
  return ref
}

// The Checkliste surface: a left rail with the action checklists (FU, Lagerapport) and —
// directly below, not behind a tab — the searchable EL tactical Stichworte. The main pane
// renders the selection: an action checklist runs as a checkable phase list; a Stichwort
// opens its reading view (with inline diagrams). Ticking/branch are lifted to App.
export function ChecklistsView({
  checklists, canTick, divera, onTick, onBranch, onAction, offersAction, scrollKey = '',
}: {
  checklists: ChecklistState
  canTick: boolean
  divera: { title?: string; type?: string }
  onTick: (template: ChecklistTemplate, item: Item) => void
  onBranch: (templateId: string, phaseId: string, branchId: string) => void
  onAction: (item: Item, a: NonNullable<Item['action']>) => void
  offersAction?: (a: NonNullable<Item['action']>) => boolean
  /** whose reading positions these are — the Einsatz id; each list's scroll offset is kept
   *  under it (scrollMemory above) */
  scrollKey?: string
}) {
  const CL = appConfig.copy.checklists
  // Templates are fetched from the reference registry (offline-cached, bundled fallback) — async,
  // so start empty and fill on resolve. loadTemplates never throws, so no error branch is needed.
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([])
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let alive = true
    const apply = (t: ChecklistTemplate[]) => {
      if (alive) {
        setTemplates(t)
        setReady(true)
      }
    }
    // already loading or loaded since the Einsatz opened (lib/checklists · warmTemplates); a
    // list older than a few minutes is shown at once and replaced when its reload lands
    const { list, newer } = warmTemplates()
    void list.then(apply)
    void newer?.then(apply)
    return () => {
      alive = false
    }
  }, [])

  const actionTemplates = useMemo(() => templates.filter((t) => t.kind !== 'reference'), [templates])
  const referenceTemplates = useMemo(() => templates.filter((t) => t.kind === 'reference'), [templates])
  const entries = useMemo(() => allEntries(templates), [templates])
  const autoMatches = useMemo(() => matchDiveraEntries(templates, divera), [templates, divera])

  // selection is either an action template or a tactical entry; defaults once templates arrive
  const [sel, setSel] = useState<{ kind: 'tpl' | 'entry'; id: string } | null>(null)
  useEffect(() => {
    if (sel || !ready) return
    if (actionTemplates[0]) setSel({ kind: 'tpl', id: actionTemplates[0].id })
    else if (entries[0]) setSel({ kind: 'entry', id: entries[0].id })
  }, [sel, ready, actionTemplates, entries])

  // The picker rail collapses to a single toggle row once something is picked, so the
  // checklist/playbook text gets the full height; tapping the row reopens the list.
  //
  // ⚠️ 760px, not `useIsPhone` (600px). The rail is a FIXED 248px, so between 601 and ~730 it kept
  // its full width while the runner column shrank to ~276px — measured at 640px (iPad Split View,
  // half) six of eight task texts overflowed their box and painted over the Plan/Journal chip.
  // Phones were never the problem; the band just above them was, and the collapse mechanism that
  // fixes it already existed and simply stopped 160px short.
  const railNarrow = useMediaQuery('(max-width: 760px)')
  const [railOpen, setRailOpen] = useState(true)
  const pick = (v: { kind: 'tpl' | 'entry'; id: string }) => { setSel(v); if (railNarrow) setRailOpen(false) }

  const [query, setQuery] = useState('')
  const results = useMemo(() => searchEntries(entries, query), [entries, query])
  // the search at the top of the rail filters every group uniformly — action lists by title,
  // reference entries by title/keyword — so Aufgaben, Taktik and Grundlagen are peer groups.
  const q = query.trim().toLowerCase()
  const actionResults = q ? actionTemplates.filter((t) => t.title.toLowerCase().includes(q)) : actionTemplates
  const noMatches = ready && !actionResults.length && !results.length

  const activeTemplate = sel?.kind === 'tpl' ? actionTemplates.find((t) => t.id === sel.id) ?? null : null
  const activeEntry = sel?.kind === 'entry' ? entries.find((e) => e.id === sel.id) ?? null : null
  // the reference template that owns the open entry — drives its diagram asset URLs
  const activeEntryTemplateId =
    sel?.kind === 'entry' ? templates.find((t) => (t.entries ?? []).some((e) => e.id === sel.id))?.id ?? null : null

  const railRef = useRememberedScroll<HTMLElement>(`${scrollKey}|rail`)
  const mainRef = useRememberedScroll<HTMLElement>(sel ? `${scrollKey}|${sel.kind}:${sel.id}` : null)

  if (ready && !templates.length) {
    return (
      <div className={s['cl-surface']}>
        <EmptyState className="empty-fill" icon="check" title={CL.none} />
      </div>
    )
  }

  const selTitle = activeTemplate?.title ?? activeEntry?.title ?? CL.railLabel
  const activeProgress = activeTemplate ? templateProgress(activeTemplate, checklists[activeTemplate.id] ?? EMPTY_STATE) : null

  return (
    <div className={s['cl-surface']}>
      {railNarrow && !railOpen ? (
        <button className={s['cl-rail-toggle']} onClick={() => setRailOpen(true)} aria-expanded={false} aria-label={CL.showList}>
          {/* what is open, in the rail's own glyph — not a 🔍 (05.10.2026, owner: «remove the search
              icon … when having a checklist opened»): the row is the list's name and the way back
              to the chooser, and the magnifier promised a search it only reached one tap later.
              The chooser it opens still starts with the search field. A Stichwort carries its
              category chip below instead. */}
          {activeTemplate && <Icon id={activeTemplate.kind === 'rapport' ? 'history' : 'check'} />}
          {activeEntry && !activeEntry.hazardColor && <Icon id="doc" />}
          <span className={s['cl-rail-toggle-title']}>{selTitle}</span>
          {/* the open list's «n/m» — here, in a row that stands anyway, instead of a progress row
              of its own under it (05.10.2026, owner: «don't need a progress indicator. Occupies
              too much space»; ChecklistRunner) */}
          {activeProgress && activeProgress.total > 0 && (
            <span className={s['cl-rail-toggle-prog']}>{activeProgress.done}/{activeProgress.total}</span>
          )}
          {/* the Stichwort's category as a word in the head (27.09.2026, owner-r2-5): it was a
              filled «BRAND» pill inside the document card, over a title the chooser had just
              shown — the card is gone on a phone (Checklists.module.css), so its two facts moved
              up here: the title is the chooser's, the category is this chip. */}
          {activeEntry?.hazardColor && (
            <span className={cx(s['cl-head-hz'], s[`hz-${activeEntry.hazardColor}`])}>
              <i className={s['cl-ref-chip']} />{CL.hazardLabels[activeEntry.hazardColor] ?? activeEntry.hazardColor}
            </span>
          )}
          <Icon id="chevron-down" />
        </button>
      ) : (
      <nav ref={railRef} className={cx(s['cl-rail'], railNarrow && railOpen && s['cl-rail-full'])} aria-label={CL.railLabel}>
        <SearchField className={s['cl-rail-search']} value={query} onChange={setQuery} placeholder={CL.searchPlaceholder} aria-label={CL.searchAria} />
        {/* ⚠️ ALL matches, not the best one (31.08.). «VU Strasse» is Verkehrsunfall AND
            E-Autobrand AND Ölspur — which of them this Einsatz is cannot be read off the
            Stichwort, and showing only the longest keyword match made the app look certain
            about something it does not know. Most specific first (lib/checklists). */}
        {autoMatches.length > 0 && (
          <div className={s['cl-rail-hints']}>
            {autoMatches.map((m) => (
              <button key={m.id} className={s['cl-rail-hint']} onClick={() => pick({ kind: 'entry', id: m.id })}>
                <Icon id="flag" /><span>{fillTemplate(CL.matching, { title: m.title })}</span>
              </button>
            ))}
          </div>
        )}
        {/* every group is a peer below the search: the checkable Aufgaben, then each reference
            template (Taktik-Stichworte, Grundlagen-Infos). One scroll region. */}
        <div className={s['cl-rail-groups']}>
          {!ready && !templates.length && <div className="workspace-loading"><LoadingStatus>{appConfig.copy.loading}</LoadingStatus></div>}
          {actionResults.length > 0 && (
            <div className={s['cl-rail-group']}>
              <div className={s['cl-rail-label']}>{CL.groupTasks}</div>
              {actionResults.map((t) => {
                const pr = templateProgress(t, checklists[t.id] ?? EMPTY_STATE)
                return (
                  <button
                    key={t.id}
                    className={cx(s['cl-rail-item'], sel?.kind === 'tpl' && sel.id === t.id && s.on)}
                    onClick={() => pick({ kind: 'tpl', id: t.id })}
                  >
                    <Icon id={t.kind === 'rapport' ? 'history' : 'check'} />
                    <span className={s['cl-rail-title']}>{t.title}</span>
                    {pr.total > 0 && <span className={s['cl-rail-prog']}>{pr.pct}%</span>}
                  </button>
                )
              })}
            </div>
          )}
          {referenceTemplates.map((rt) => {
            const rtResults = searchEntries(rt.entries ?? [], query)
            if (!rtResults.length) return null
            return (
              <div key={rt.id} className={s['cl-rail-group']}>
                <div className={s['cl-rail-label']}>{rt.title}</div>
                {rtResults.map((e) => (
                  <button
                    key={e.id}
                    className={cx(s['cl-rail-entry'], sel?.kind === 'entry' && sel.id === e.id && s.on, e.hazardColor && s[`hz-${e.hazardColor}`])}
                    onClick={() => pick({ kind: 'entry', id: e.id })}
                  >
                    <span className={s['cl-ref-chip']} />
                    <span className={s['cl-rail-entry-title']}>{e.title}</span>
                  </button>
                ))}
              </div>
            )
          })}
          {noMatches && <p className="no-hits">{fillTemplate(appConfig.copy.noHits, { q: query.trim() })}</p>}
        </div>
      </nav>
      )}

      {/* #4: on a phone, while the list is open show ONLY the list (no small preview underneath).
          Opening an item collapses the list to the toggle row and gives the checklist the screen. */}
      {!(railNarrow && railOpen) && (
        <main ref={mainRef} className={s['cl-main']}>
          {activeTemplate ? (
            <ChecklistRunner
              template={activeTemplate}
              state={checklists[activeTemplate.id] ?? EMPTY_STATE}
              canTick={canTick}
              onToggle={(item) => onTick(activeTemplate, item)}
              onBranch={(phaseId, branchId) => onBranch(activeTemplate.id, phaseId, branchId)}
              onAction={onAction}
              offersAction={offersAction}
            />
          ) : (
            <ChecklistEntryReader entry={activeEntry} templateId={activeEntryTemplateId} />
          )}
        </main>
      )}
    </div>
  )
}
