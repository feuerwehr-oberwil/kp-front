import { useEffect, useState } from 'react'
import { Icon } from '../../lib/icons'
import { toast, confirmDialog } from '../../lib/ui'
import { ApiError, isUnverifiable } from '../../lib/api'
import { useOnline } from '../../lib/useOnline'
import { NO_HISTORY_FILTER, applyHistoryFilter, filterIncidents, historyGroups, historyTypes, historyWhen, monthLabel, type HistoryFilter } from '../../lib/historyGroups'
import { appConfig } from '../../config/appConfig'
import { EmptyState } from '../EmptyState'
import { EinsatzRow } from '../EinsatzRow'
import { Button } from '../Button'
import { ListGroup } from '../ListRow'
import { LoadingStatus } from '../ShellLoader'
import { foreignMark } from '../../lib/foreignAlarm'
import { einsatzSubject } from '../../lib/einsatzSubject'
import { Menu } from '../../lib/overlays'
import { cx } from '../../lib/cx'
import c from '../SurfaceControls.module.css'
import { SearchField } from '../SearchField'
import { FilterStrip } from '../FilterStrip'
import { fillTemplate, fmtSpanShort, formatLocale } from '../../lib/format'
import {
  deleteIncident,
  listIncidents,
  reactivateIncident,
  readCachedIncidentList,
  type IncidentMeta,
} from '../../lib/incidents'
import { Modal } from './_shared'

/** the «Alle» row of a one-of-N filter group – no Einsatzart is empty */
const ALL = ''

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
  /** Editors and EL can close or reopen. Pass the visible row so the confirmation names the
   *  incident even when another device created it since the app last read its switcher list. */
  onArchive?: (incident: IncidentMeta) => Promise<void>
  /** a `viewer` account's window in days (docs/roles-and-access.md · «The viewer's window», #449):
   *  the server lists only the running Einsätze and those closed within it, so the list says so
   *  in a foot line – older ones vanished silently, and «abgeschlossene erscheinen hier» was false
   *  after a quiet week. Absent for everyone the server does not narrow. */
  windowDays?: number
}) {
  const [items, setItems] = useState<IncidentMeta[]>([])
  // Four states, never folded into «empty» (duck sweep LISTS.1, 17.11.2026): the FU in the cellar
  // read «Noch keine Einsätze» while the list was still loading, offline or refused, and concluded
  // yesterday's Einsatz was gone. «Empty» only after the server answered with nothing.
  //   · loading – the first answer is out;
  //   · offline – nobody could be asked (api · isUnverifiable): the list this device cached last
  //     (the running ones, lib/api/incidents · cacheIncidentList – the menu reads the same one),
  //     with what is missing said and a retry;
  //   · failed – the server answered with a refusal: THE form warning and a retry;
  //   · ok.
  const [state, setState] = useState<'loading' | 'ok' | 'offline' | 'failed'>('loading')
  // a HINT, not a gate (lib/useOnline): the buttons stay, the line says what they need
  const online = useOnline()
  // the fetch alone – the first state is already «loading»; a retry says so first (`retry`)
  const reload = () => {
    listIncidents().then((list) => { setItems(list); setState('ok') }).catch(async (e: unknown) => {
      if (!isUnverifiable(e)) { setState('failed'); return }
      // ⚠️ a cached list's alarm tiers are as old as the cache – never shown as if they were now
      const cached = (await readCachedIncidentList().catch(() => [])).map(({ atemschutz_due: _stale, ...i }) => i)
      setItems((cur) => (cur.length ? cur : cached))
      setState('offline')
    })
  }
  useEffect(reload, [])
  const retry = () => { setState('loading'); reload() }
  // reactivate is as deliberate as archive (its mirror confirm): the dialog also teaches
  // what it means — later edits land as Nachträge, a done Rapport flips to «geändert». Every
  // lifecycle confirm here names its Einsatz above the buttons (lib/einsatzSubject, LISTS.11).
  const reactivate = async (i: IncidentMeta) => {
    const h = appConfig.copy.history
    const ok = await confirmDialog({
      title: h.reactivateConfirmTitle,
      message: h.reactivateConfirmMsg,
      subject: einsatzSubject(i),
      confirmLabel: h.reactivateConfirmBtn,
      cancelLabel: appConfig.copy.cancel,
    })
    if (!ok) return
    // ⚠️ caught: an offline reopen used to be an unhandled rejection and no word at all
    try {
      await reactivateIncident(i.id)
    } catch (e) {
      toast(isUnverifiable(e) ? appConfig.copy.archived.reactivateNeedsServer
        : e instanceof ApiError ? e.detail : appConfig.copy.errors.updateFailed, { icon: 'warn', tone: 'warn' })
      return
    }
    onOpen(i.id, false)
  }
  const archive = async (incident: IncidentMeta) => { await onArchive?.(incident); reload() }
  // hard delete — Übungen only (server-enforced). Deliberately NOT undoable, so it gets the
  // danger confirm instead of confirm-with-undo; real Einsätze never show the button.
  const removeExercise = async (i: IncidentMeta) => {
    const h = appConfig.copy.history
    const ok = await confirmDialog({
      title: h.deleteConfirmTitle,
      message: h.deleteConfirmMsg,
      subject: einsatzSubject(i),
      confirmLabel: h.deleteConfirmBtn,
      cancelLabel: appConfig.copy.cancel,
      danger: true,
      bin: true,
    })
    if (!ok) return
    try {
      // no toast: the row leaves after the red confirm
      await deleteIncident(i.id)
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
  const types = historyTypes(sorted)
  const shown = applyHistoryFilter(filterIncidents(sorted, query), filter)
  /** what is on, for the button's tooltip and name and the strip under the line – never printed on
   *  the button (Anwesenheit's way) */
  const filterOn = [
    filter.kind === 'real' ? h.filterReal : filter.kind === 'exercise' ? h.filterExercise : null,
    filter.type,
    filter.rapportOpen ? h.filterRapportOpen : null,
  ].filter(Boolean).join(' · ')
  const now = new Date()
  const groupTitle = (key: string) =>
    key === 'open' ? h.groupOpen : key === 'last' ? h.groupLastClosed : key === 'today' ? h.groupToday
      : key === 'week' ? h.groupWeek : monthLabel(key, formatLocale())
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
  // one ListGroup per time group, and «Zuletzt abgeschlossen» on top of them (lib/historyGroups)
  const groups = historyGroups(shown, now)
  const windowNote = windowDays == null ? null
    : windowDays === 0 ? h.windowNoteRunning
    : windowDays === 1 ? h.windowNoteOne
    : fillTemplate(h.windowNote, { n: windowDays })
  return (
    <Modal title={h.title} onClose={onClose} wide>
      {state === 'loading' && sorted.length === 0 && <div className="ip-hist-state"><LoadingStatus size="surface">{h.loading}</LoadingStatus></div>}
      {state === 'failed' && (
        <div className="form-warn" role="alert">
          <Icon id="warn" /><span className="form-warn-text">{h.loadFailed}</span>
          <button type="button" className="form-warn-act" onClick={retry}>{h.retry}</button>
        </div>
      )}
      {state === 'offline' && (
        <div className="form-warn form-warn-amber" role="status">
          <Icon id="cloud-off" /><span className="form-warn-text">{sorted.length ? h.offlineCached : h.offlineNothing}</span>
          <button type="button" className="form-warn-act" onClick={retry}>{h.retry}</button>
        </div>
      )}
      {state === 'ok' && sorted.length === 0 && (windowNote
        ? <EmptyState icon="list" title={h.emptyWindow} sub={windowNote} />
        : <EmptyState icon="list" title={h.empty} sub={h.emptySub} />)}
      {state === 'ok' && !online && onArchive && sorted.length > 0 && <p className="ip-hist-offline"><Icon id="cloud-off" /> {h.offlineNote}</p>}
      {/* the search line of a working list (owner, 27.10.2026 r2: «in-line with a filter button
          the same way we have it for … people in Anwesenheiten») – SurfaceControls' search and
          WORDED filter tile («Art», button sweep HEADS.2, 17.11.2026), the filters behind it in a
          Menu. «Filter is on» is the button's choice fill; WHAT is on is the strip under the line.
          Each group is ONE value, so it is a one-of-N (radio, the trailing ✓, closes on pick –
          HEADS.4: ticking «Brand» used to untick «BMA» behind a checkbox's back), «Alle» its
          first, ticked row (HEADS.7); «Rapport offen» is a flag and stays a checkbox. */}
      {sorted.length > 0 && (
        <div className="ip-hist-controls">
          <SearchField className={c.search} value={query} onChange={setQuery} placeholder={h.searchPlaceholder} aria-label={h.searchPlaceholder} />
          <Menu
            trigger={
              <button type="button" className={cx(c.iconBtn, filterOn && c.iconBtnOn)}
                aria-label={filterOn ? `${h.filterAria} – ${filterOn}` : h.filterAria}
                title={filterOn ? `${h.filterAria} – ${filterOn}` : h.filterAria}>
                <Icon id="filter" /><span className={c.word} aria-hidden="true">{h.filterWord}</span>
              </button>
            }
            popupClassName={c.menuPop}
            itemClassName={() => c.menuItem}
            items={[
              { kind: 'head' as const, label: h.filterKindHead },
              {
                kind: 'radio' as const,
                value: filter.kind ?? ALL,
                onChange: (v: string) => setFilter((f) => ({ ...f, kind: v === 'real' || v === 'exercise' ? v : null })),
                options: [
                  { value: ALL, label: h.filterAll },
                  { value: 'real', label: h.filterReal },
                  { value: 'exercise', label: h.filterExercise },
                ],
              },
              // only where there is a choice to make – one Einsatzart filters nothing
              ...(types.length > 1 ? [
                { kind: 'head' as const, label: h.filterType },
                {
                  kind: 'radio' as const,
                  value: filter.type ?? ALL,
                  onChange: (v: string) => setFilter((f) => ({ ...f, type: v === ALL ? null : v })),
                  options: [{ value: ALL, label: h.filterAll }, ...types.map((t) => ({ value: t, label: t }))],
                },
              ] : []),
              { kind: 'sep' as const },
              { kind: 'check' as const, label: h.filterRapportOpen, checked: filter.rapportOpen, onChange: (on: boolean) => setFilter((f) => ({ ...f, rapportOpen: on })) },
            ]}
          />
        </div>
      )}
      {/* WHAT narrows the list, and the way back (button sweep HEADS.3, 17.11.2026); the count
          only while nothing is typed */}
      {sorted.length > 0 && filterOn && (
        <FilterStrip className="ip-hist-strip" what={filterOn}
          count={query.trim() ? undefined : { n: shown.length, m: sorted.length }}
          onClear={() => setFilter(NO_HISTORY_FILTER)} />
      )}
      {/* the one no-hit line (LISTS.4): a query says what was searched; only a filter gets the
          shared filter line – its way out is the strip right above */}
      {sorted.length > 0 && shown.length === 0 && (
        <p className="no-hits">{query.trim() ? fillTemplate(appConfig.copy.noHits, { q: query.trim() }) : appConfig.copy.filterNoHits}</p>
      )}
      {groups.map(({ key, rows }) => (
        <ListGroup key={key} label={groupTitle(key)} className="ip-hist-group">
          {rows.map((i) => (
            // the row opens the Einsatz (›); its lifecycle buttons stay BESIDE it (owner,
            // 17.11.2026 – kept), each confirm naming the Einsatz it acts on
            <div key={i.id} className="ip-hist">
              <EinsatzRow incident={i} when={whenOf(i)} alarm={foreignMark(i)} onClick={() => onOpen(i.id, i.is_archived)} />
              {/* Closing and reopening have the same permission, matched to the server. */}
              {onArchive && (
                <div className="ip-hist-acts">
                  {i.is_archived
                    /* ↶ beside the word, the glyph the Verlauf gives «Einsatz wiedereröffnet» – as
                       «Löschen» beside it carries its bin (round 18.11.2026 #2, owner pick) */
                    ? <Button icon={<Icon id="undo" />} onClick={() => void reactivate(i)}>{h.reactivate}</Button>
                    : <Button onClick={() => void archive(i)}>{h.archiveConfirmBtn}</Button>}
                  {/* delete only for ARCHIVED exercises (editor-gated via onArchive) — an open
                      Übung is first abgeschlossen like any incident, then deletable. Only one
                      CREATED as Übung: a real Einsatz marked Übung later needs the Verwaltung */}
                  {i.is_exercise && i.exercise_since_creation && i.is_archived && (
                    <Button variant="danger" icon={<Icon id="trash" />} onClick={() => void removeExercise(i)} aria-label={h.deleteConfirmTitle}>
                      {h.deleteExercise}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </ListGroup>
      ))}
      {windowNote && sorted.length > 0 && <p className="ip-hist-foot">{windowNote}</p>}
    </Modal>
  )
}
