import { Fragment, useEffect, useState } from 'react'
import { Icon } from '../../lib/icons'
import { toast, confirmDialog } from '../../lib/ui'
import { ApiError } from '../../lib/api'
import { filterIncidents, historyGroupKey, monthLabel } from '../../lib/historyGroups'
import { getLocaleId } from '../../config/copy'
import { appConfig } from '../../config/appConfig'
import { shortAddress } from '../../lib/deploymentConfig'
import { EmptyState } from '../EmptyState'
import {
  deleteIncident,
  listIncidents,
  reactivateIncident,
  type IncidentMeta,
} from '../../lib/incidents'
import { Modal, fmtWhen } from './_shared'

// --- History (Phase 5) --------------------------------------------------------------
const statusLabel = (i: IncidentMeta): string => {
  const h = appConfig.copy.history
  return i.is_archived ? h.statusArchived : i.status === 'offen' ? h.statusOpen : i.status === 'in_arbeit' ? h.statusInProgress : i.status
}
const statusKey = (i: IncidentMeta): string => (i.is_archived ? 'arch' : i.status === 'in_arbeit' ? 'work' : 'open')

// All incidents in one list with a status badge — active and archived together, so you can
// switch to any of them. Clicking opens it (archived → read-only); a reactivate restores
// edit. Open incidents get the «Abschliessen» action HERE (not in the switcher menu — the
// dropdown carries no destructive actions; the caller confirms + archives).
export function HistoryPanel({ onClose, onOpen, onArchive }: {
  onClose: () => void
  onOpen: (id: string, readOnly: boolean) => void
  /** confirm + archive an open incident (editors only; omit for viewers) */
  onArchive?: (id: string) => Promise<void>
}) {
  const [items, setItems] = useState<IncidentMeta[]>([])
  const reload = () => { void listIncidents().then(setItems).catch(() => setItems([])) }
  useEffect(reload, [])
  // reactivate is as deliberate as archive (its mirror confirm): the dialog also teaches
  // what it means — later edits land as Nachträge, a done Rapport flips to «geändert».
  const reactivate = async (id: string) => {
    const h = appConfig.copy.history
    const ok = await confirmDialog({
      title: h.reactivateConfirmTitle,
      message: h.reactivateConfirmMsg,
      confirmLabel: h.reactivateConfirmBtn,
      cancelLabel: appConfig.copy.cancel,
    })
    if (!ok) return
    await reactivateIncident(id)
    onOpen(id, false)
  }
  const archive = async (id: string) => { await onArchive?.(id); reload() }
  // hard delete — Übungen only (server-enforced). Deliberately NOT undoable, so it gets the
  // danger confirm instead of confirm-with-undo; real Einsätze never show the button.
  const removeExercise = async (i: IncidentMeta) => {
    const h = appConfig.copy.history
    const ok = await confirmDialog({
      title: h.deleteConfirmTitle,
      message: h.deleteConfirmMsg,
      confirmLabel: h.deleteConfirmBtn,
      cancelLabel: appConfig.copy.cancel,
      danger: true,
    })
    if (!ok) return
    try {
      await deleteIncident(i.id)
      toast(h.deleted, { icon: 'check', tone: 'success' })
      reload()
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : h.deleteFailed, { icon: 'warn', tone: 'warn' })
    }
  }
  // active first, then by start time (newest first)
  const sorted = [...items].sort(
    (a, b) => Number(a.is_archived) - Number(b.is_archived) || (a.started_at < b.started_at ? 1 : -1),
  )
  const h = appConfig.copy.history
  // the list grows by one row per Einsatz forever — search + time-group headers keep an
  // old incident findable months later (the reopen/ansehen path). Sorted active-first then
  // newest, so group keys change monotonically and a header renders on every key change.
  const [query, setQuery] = useState('')
  const shown = filterIncidents(sorted, query)
  const now = new Date()
  const groupTitle = (key: string) =>
    key === 'open' ? h.groupOpen : key === 'today' ? h.groupToday : key === 'week' ? h.groupWeek : monthLabel(key, getLocaleId())
  const rows = shown.map((i, idx) => {
    const key = historyGroupKey(i, now)
    const prev = idx > 0 ? historyGroupKey(shown[idx - 1], now) : null
    return { i, header: key !== prev ? groupTitle(key) : null }
  })
  return (
    <Modal title={h.title} onClose={onClose} wide>
      {sorted.length === 0 && <EmptyState icon="history" title={h.empty} sub={h.emptySub} />}
      {sorted.length > 0 && (
        <label className="ip-hist-search">
          <Icon id="search" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={h.searchPlaceholder} aria-label={h.searchPlaceholder} />
        </label>
      )}
      {sorted.length > 0 && shown.length === 0 && <p className="ip-hist-nores">{h.noMatches}</p>}
      {rows.map(({ i, header }) => {
        return (
          <Fragment key={i.id}>
            {header && <div className="ip-hist-group">{header}</div>}
            <div className="ip-hist">
              <button className="ip-hist-main" onClick={() => onOpen(i.id, i.is_archived)}>
                <div className="ip-hist-title">
                  <span className="ip-hist-name">{i.title}</span>
                  {i.is_exercise && <span className="ip-badge ip-badge-exercise">{appConfig.copy.exerciseBadge}</span>}
                  <span className={`ip-badge ip-badge-${statusKey(i)}`}>{statusLabel(i)}</span>
                </div>
                <div className="ip-hist-sub">{shortAddress(i.address) ?? h.noLocation} · {fmtWhen(i.started_at)}</div>
              </button>
              {i.is_archived
                ? <button className="ip-btn" onClick={() => reactivate(i.id)}>{h.reactivate}</button>
                : onArchive && <button className="ip-btn" onClick={() => void archive(i.id)}>{h.archiveConfirmBtn}</button>}
              {/* delete only for ARCHIVED exercises (editor-gated via onArchive) — an open
                  Übung is first abgeschlossen like any incident, then deletable */}
              {i.is_exercise && i.is_archived && onArchive && (
                <button className="ip-btn ip-btn-danger" onClick={() => void removeExercise(i)} aria-label={h.deleteConfirmTitle}>
                  <Icon id="trash" /> {h.deleteExercise}
                </button>
              )}
            </div>
          </Fragment>
        )
      })}
    </Modal>
  )
}
