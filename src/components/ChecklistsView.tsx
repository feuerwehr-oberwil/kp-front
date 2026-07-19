import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import type { ChecklistState, ChecklistTemplate, Item, TemplateState } from '../lib/checklists'
import { allEntries, loadTemplates, matchDiveraEntry, searchEntries, templateProgress } from '../lib/checklists'
import { ChecklistRunner } from './ChecklistRunner'
import { ChecklistEntryReader } from './ChecklistReference'
import { cx } from '../lib/cx'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { useIsPhone } from '../lib/useIsPhone'
import s from './Checklists.module.css'

const EMPTY_STATE: TemplateState = { ticks: {}, activeBranch: {} }

// The Checkliste surface: a left rail with the action checklists (FU, Lagerapport) and —
// directly below, not behind a tab — the searchable EL tactical Stichworte. The main pane
// renders the selection: an action checklist runs as a checkable phase list; a Stichwort
// opens its reading view (with inline diagrams). Ticking/branch are lifted to App.
export function ChecklistsView({
  checklists, canTick, divera, onTick, onBranch, onAction,
}: {
  checklists: ChecklistState
  canTick: boolean
  divera: { title?: string; type?: string }
  onTick: (template: ChecklistTemplate, item: Item) => void
  onBranch: (templateId: string, phaseId: string, branchId: string) => void
  onAction: (item: Item, a: NonNullable<Item['action']>) => void
}) {
  const CL = appConfig.copy.checklists
  // Templates are fetched from the reference registry (offline-cached, bundled fallback) — async,
  // so start empty and fill on resolve. loadTemplates never throws, so no error branch is needed.
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([])
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let alive = true
    loadTemplates().then((t) => {
      if (alive) {
        setTemplates(t)
        setReady(true)
      }
    })
    return () => {
      alive = false
    }
  }, [])

  const actionTemplates = useMemo(() => templates.filter((t) => t.kind !== 'reference'), [templates])
  const referenceTemplates = useMemo(() => templates.filter((t) => t.kind === 'reference'), [templates])
  const entries = useMemo(() => allEntries(templates), [templates])
  const autoMatch = useMemo(() => matchDiveraEntry(templates, divera), [templates, divera])

  // selection is either an action template or a tactical entry; defaults once templates arrive
  const [sel, setSel] = useState<{ kind: 'tpl' | 'entry'; id: string } | null>(null)
  useEffect(() => {
    if (sel || !ready) return
    if (actionTemplates[0]) setSel({ kind: 'tpl', id: actionTemplates[0].id })
    else if (entries[0]) setSel({ kind: 'entry', id: entries[0].id })
  }, [sel, ready, actionTemplates, entries])

  // phone: the picker rail collapses to a single toggle row once something is picked, so the
  // checklist/playbook text gets the full screen height; tapping the row reopens the list
  const isPhone = useIsPhone()
  const [railOpen, setRailOpen] = useState(true)
  const pick = (v: { kind: 'tpl' | 'entry'; id: string }) => { setSel(v); if (isPhone) setRailOpen(false) }

  const [query, setQuery] = useState('')
  const results = useMemo(() => searchEntries(entries, query), [entries, query])
  // the search at the top of the rail filters every group uniformly — action lists by title,
  // reference entries by title/keyword — so Aufgaben, Taktik and Grundlagen are peer groups.
  const q = query.trim().toLowerCase()
  const actionResults = q ? actionTemplates.filter((t) => t.title.toLowerCase().includes(q)) : actionTemplates
  const noMatches = !actionResults.length && !results.length

  const activeTemplate = sel?.kind === 'tpl' ? actionTemplates.find((t) => t.id === sel.id) ?? null : null
  const activeEntry = sel?.kind === 'entry' ? entries.find((e) => e.id === sel.id) ?? null : null
  // the reference template that owns the open entry — drives its diagram asset URLs
  const activeEntryTemplateId =
    sel?.kind === 'entry' ? templates.find((t) => (t.entries ?? []).some((e) => e.id === sel.id))?.id ?? null : null

  if (ready && !templates.length) {
    return (
      <div className={s['cl-surface']}>
        <div className={cx(s['cl-placeholder'], s['cl-placeholder-full'])}>
          <Icon id="check" />
          <p>{CL.none}</p>
        </div>
      </div>
    )
  }

  const selTitle = activeTemplate?.title ?? activeEntry?.title ?? CL.railLabel

  return (
    <div className={s['cl-surface']}>
      {isPhone && !railOpen ? (
        <button className={s['cl-rail-toggle']} onClick={() => setRailOpen(true)} aria-expanded={false} aria-label={CL.showList}>
          <Icon id="search" />
          <span>{selTitle}</span>
          <Icon id="chevron-down" />
        </button>
      ) : (
      <nav className={s['cl-rail']} aria-label={CL.railLabel}>
        <div className={cx(s['cl-search'], s['cl-rail-search'])}>
          <Icon id="search" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={CL.searchPlaceholder} aria-label={CL.searchAria} />
        </div>
        {autoMatch && (
          <button className={s['cl-rail-hint']} onClick={() => pick({ kind: 'entry', id: autoMatch.id })}>
            <Icon id="flag" /><span>{fillTemplate(CL.matching, { title: autoMatch.title })}</span>
          </button>
        )}
        {/* every group is a peer below the search: the checkable Aufgaben, then each reference
            template (Taktik-Stichworte, Grundlagen-Infos). One scroll region. */}
        <div className={s['cl-rail-groups']}>
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
          {noMatches && <p className={s['cl-empty-hint']}>{CL.noMatches}</p>}
        </div>
      </nav>
      )}

      <main className={s['cl-main']}>
        {activeTemplate ? (
          <ChecklistRunner
            template={activeTemplate}
            state={checklists[activeTemplate.id] ?? EMPTY_STATE}
            canTick={canTick}
            onToggle={(item) => onTick(activeTemplate, item)}
            onBranch={(phaseId, branchId) => onBranch(activeTemplate.id, phaseId, branchId)}
            onAction={onAction}
          />
        ) : (
          <ChecklistEntryReader entry={activeEntry} templateId={activeEntryTemplateId} />
        )}
      </main>
    </div>
  )
}
