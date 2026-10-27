import { Fragment, useEffect, useState } from 'react'
import { Icon } from '../../lib/icons'
import { toast, confirmDialog } from '../../lib/ui'
import { ApiError, isUnverifiable } from '../../lib/api'
import { useOnline } from '../../lib/useOnline'
import { NO_HISTORY_FILTER, applyHistoryFilter, filterIncidents, historyGroupKey, historyTypes, historyWhen, monthLabel, type HistoryFilter } from '../../lib/historyGroups'
import { appConfig } from '../../config/appConfig'
import { shortAddress } from '../../lib/deploymentConfig'
import { EmptyState } from '../EmptyState'
import { Chip } from '../Chip'
import { SearchField } from '../SearchField'
import { fillTemplate, fmtSpanShort, formatLocale } from '../../lib/format'
import {
  deleteIncident,
  listIncidents,
  reactivateIncident,
  type IncidentMeta,
} from '../../lib/incidents'
import { Modal } from './_shared'

// --- History (Phase 5) --------------------------------------------------------------
// All incidents in one list — active and archived together, so you can switch to any of them.
// Clicking opens it (archived → read-only); a reactivate restores edit. An open incident gets a
// compact «Abschliessen» here too, for closing one that is not the active Einsatz (the active
// one also has it in the Einsatz menu card and the Rapport head; the caller confirms + archives).
// ONE status tag, and only on a closed Einsatz: «Abgeschlossen» (29.09.2026, owner: «we just need
// tags to say an emergency is closed. open is the default state»). «Offen» and «In Arbeit» are
// gone — the backend's two ACTIVE statuses (lib/api/incidents · INCIDENT_ACTIVE_STATUSES) are one
// state to the operator, and nothing here sorted or grouped by the difference.
export function HistoryPanel({ onClose, onOpen, onArchive, windowDays }: {
  onClose: () => void
  onOpen: (id: string, readOnly: boolean) => void
  /** confirm + archive an open incident (editors only; omit for viewers and the el role). Its
   *  presence also offers «Wieder öffnen» on an archived one — the same lifecycle, the same gate. */
  onArchive?: (id: string) => Promise<void>
  /** a `viewer` account's window in days (docs/roles-and-access.md · «The viewer's window», #449):
   *  the server lists only the running Einsätze and those closed within it, so the list says so
   *  in a foot line – older ones vanished silently, and «abgeschlossene erscheinen hier» was false
   *  after a quiet week. Absent for everyone the server does not narrow. */
  windowDays?: number
}) {
  const [items, setItems] = useState<IncidentMeta[]>([])
  // a HINT, not a gate (lib/useOnline): the buttons stay, the line says what they need
  const online = useOnline()
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
    // ⚠️ caught: an offline reopen used to be an unhandled rejection and no word at all
    try {
      await reactivateIncident(id)
    } catch (e) {
      toast(isUnverifiable(e) ? appConfig.copy.archived.reactivateNeedsServer
        : e instanceof ApiError ? e.detail : appConfig.copy.errors.updateFailed, { icon: 'warn', tone: 'warn' })
      return
    }
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
  // the quick filters (27.10.2026, owner): Ernstfall | Übung, one Einsatzart, Rapport offen –
  // client-side, the list already carries every field they read (lib/historyGroups)
  const [filter, setFilter] = useState<HistoryFilter>(NO_HISTORY_FILTER)
  const [typesOpen, setTypesOpen] = useState(false)
  const types = historyTypes(sorted)
  const shown = applyHistoryFilter(filterIncidents(sorted, query), filter)
  const toggleKind = (kind: 'real' | 'exercise') => setFilter((f) => ({ ...f, kind: f.kind === kind ? null : kind }))
  const now = new Date()
  const groupTitle = (key: string) =>
    key === 'open' ? h.groupOpen : key === 'today' ? h.groupToday : key === 'week' ? h.groupWeek : monthLabel(key, formatLocale())
  // «Mo., 05.10. · 12:24–13:47 · 1 h 23», a running one «Mo., 05.10. · seit 14:00 · 32 min» —
  // the day and the span lead the row's second line, the address follows on its own
  const whenOf = (i: IncidentMeta): string | null => {
    const w = historyWhen(i, now, formatLocale())
    if (!w) return null
    const span = i.is_archived
      ? (w.end ? `${w.start}–${w.endDay ? `${w.endDay} ` : ''}${w.end}` : w.start)
      : fillTemplate(h.since, { t: w.start })
    // each piece holds together («55 min» never splits over two lines); the row breaks between them
    return [w.day, span, w.durationMs != null ? fmtSpanShort(w.durationMs) : null]
      .filter((x): x is string => !!x).map((x) => x.replace(/ /g, '\u00a0')).join(' · ')
  }
  const rows = shown.map((i, idx) => {
    const key = historyGroupKey(i, now)
    const prev = idx > 0 ? historyGroupKey(shown[idx - 1], now) : null
    return { i, header: key !== prev ? groupTitle(key) : null }
  })
  const windowNote = windowDays == null ? null
    : windowDays === 0 ? h.windowNoteRunning
    : windowDays === 1 ? h.windowNoteOne
    : fillTemplate(h.windowNote, { n: windowDays })
  return (
    <Modal title={h.title} onClose={onClose} wide>
      {sorted.length === 0 && (windowNote
        ? <EmptyState icon="list" title={h.emptyWindow} sub={windowNote} />
        : <EmptyState icon="list" title={h.empty} sub={h.emptySub} />)}
      {!online && onArchive && sorted.length > 0 && <p className="ip-hist-offline"><Icon id="warn" /> {h.offlineNote}</p>}
      {sorted.length > 0 && (
        <SearchField value={query} onChange={setQuery} placeholder={h.searchPlaceholder} aria-label={h.searchPlaceholder} />
      )}
      {sorted.length > 0 && (
        <div className="ip-hist-filters" role="group" aria-label={h.filterAria}>
          <Chip selected={filter.kind === 'real'} onClick={() => toggleKind('real')}>{h.filterReal}</Chip>
          <Chip selected={filter.kind === 'exercise'} onClick={() => toggleKind('exercise')}>{h.filterExercise}</Chip>
          {/* only where there is a choice to make – one Einsatzart filters nothing */}
          {types.length > 1 && (
            <Chip selected={filter.type != null} aria-expanded={typesOpen} onClick={() => setTypesOpen((v) => !v)}>
              {filter.type ?? h.filterType}<Icon id="chevron-down" className="chev" />
            </Chip>
          )}
          <Chip selected={filter.rapportOpen} onClick={() => setFilter((f) => ({ ...f, rapportOpen: !f.rapportOpen }))}>{h.filterRapportOpen}</Chip>
          {typesOpen && types.length > 1 && (
            <div className="ip-hist-types">
              {types.map((t) => (
                <Chip key={t} selected={filter.type === t}
                  onClick={() => { setFilter((f) => ({ ...f, type: f.type === t ? null : t })); setTypesOpen(false) }}>
                  {t}
                </Chip>
              ))}
            </div>
          )}
        </div>
      )}
      {sorted.length > 0 && shown.length === 0 && <p className="no-hits">{query.trim() ? fillTemplate(appConfig.copy.noHits, { q: query.trim() }) : h.filterNoHits}</p>}
      {rows.map(({ i, header }) => {
        return (
          <Fragment key={i.id}>
            {header && <div className="ip-hist-group">{header}</div>}
            <div className={`ip-hist${i.is_archived ? '' : ' ip-hist-live'}`}>
              <button className="ip-hist-main" onClick={() => onOpen(i.id, i.is_archived)}>
                <div className="ip-hist-title">
                  <span className="ip-hist-name">{i.title}</span>
                  {i.is_exercise && <span className="ip-badge ip-badge-exercise">{appConfig.copy.exerciseBadge}</span>}
                  {i.is_archived && <span className="ip-badge ip-badge-arch">{h.statusArchived}</span>}
                </div>
                {whenOf(i) && <div className="ip-hist-when">{whenOf(i)}</div>}
                <div className="ip-hist-sub">{shortAddress(i.address) ?? h.noLocation}</div>
              </button>
              {/* «Wieder öffnen» is the lifecycle too (PATCH is_archived, editor-only on the
                  server) — gated with «Abschliessen», or an el/viewer got a confirm and a 403 */}
              {i.is_archived
                ? onArchive && <button className="ip-btn" onClick={() => reactivate(i.id)}>{h.reactivate}</button>
                : onArchive && <button className="ip-btn ip-hist-close" onClick={() => void archive(i.id)}>{h.archiveConfirmBtn}</button>}
              {/* delete only for ARCHIVED exercises (editor-gated via onArchive) — an open
                  Übung is first abgeschlossen like any incident, then deletable. Only one
                  CREATED as Übung: a real Einsatz marked Übung later needs the Verwaltung */}
              {i.is_exercise && i.exercise_since_creation && i.is_archived && onArchive && (
                <button className="ip-btn ip-btn-danger" onClick={() => void removeExercise(i)} aria-label={h.deleteConfirmTitle}>
                  <Icon id="trash" /> {h.deleteExercise}
                </button>
              )}
            </div>
          </Fragment>
        )
      })}
      {windowNote && sorted.length > 0 && <p className="ip-hist-foot">{windowNote}</p>}
    </Modal>
  )
}
