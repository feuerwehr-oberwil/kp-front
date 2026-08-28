import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet, apiPost } from '../lib/api'
import type { DeploymentConfig } from '../lib/deploymentConfig'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { fmtDateTime } from './ui'
import { Sheet } from '../lib/overlays'

/** One kept configuration, as the API projects it (backend api/config · ConfigHistoryEntry). */
interface HistoryEntry {
  id: number
  replacedAt: string
  source: string | null
  replacedBy: string | null
  /** what the write that replaced this document CHANGED — `fleet.vehicles`, `map.defaultView`
   *  (backend config_history · changed_sections). NOT what the document contained: that was the
   *  same nine section names on every row, because every writer replaces the whole document. */
  sections: string[]
  /** …and what it left EMPTY. The subset that is worth a warning colour. */
  emptied: string[]
}

/** Consecutive writes from the same hand, no further apart than this, are ONE entry in the list.
 *  The Verwaltung autosaves, so a single afternoon of setup produces dozens of rows seconds
 *  apart; what an operator wants back is the state before the whole burst, not before keystroke
 *  19 of 26. Three minutes is longer than the autosave debounce and shorter than the pause
 *  between two things a person deliberately did. */
const BURST_GAP_MS = 3 * 60_000

/** How many section names a row spells out before it counts the rest. */
const MAX_NAMED = 4

const stamp = (e: HistoryEntry) => Date.parse(e.replacedAt)

/**
 * Consecutive entries that belong to one editing burst, newest group first, each group newest
 * entry first (the order the API returns).
 *
 * ⚠️ A write that EMPTIED something is never folded into a group, whatever its timing: it is the
 * one row this whole list exists to make findable, and a collapsed burst would hide it behind a
 * summary. Same for a change of hand — «Verwaltung · Meier» and a CLI push are two events even
 * one second apart.
 */
function groupBursts(rows: readonly HistoryEntry[]): HistoryEntry[][] {
  const groups: HistoryEntry[][] = []
  for (const e of rows) {
    const open = groups[groups.length - 1]
    const prev = open?.[open.length - 1] // the entry just NEWER than this one
    const joins = prev
      && prev.source === e.source
      && prev.replacedBy === e.replacedBy
      && prev.emptied.length === 0 && e.emptied.length === 0
      && stamp(prev) - stamp(e) <= BURST_GAP_MS
    if (joins && open) open.push(e)
    else groups.push([e])
  }
  return groups
}

/** Union of the sections a group of writes touched, in the API's order, without repeats. */
const unionChanged = (group: readonly HistoryEntry[]) => [...new Set(group.flatMap((e) => e.sections))].sort()

const fmtTime = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
}

/** «Verwaltung», «Kommandozeile» … — the path, in words, plus who was behind it.
 *
 *  ⚠️ `roster` (a rank adopted during a personnel import) had no label and therefore rendered as
 *  «Unbekannt» — an unattributed row in the one list read to find out who did what. And `api`
 *  with no user is not an unknown actor either but a specific one: a browser holding the admin
 *  key with nobody logged in, which is what an unattended writer looks like. Both say so now. */
function sourceLabel(e: HistoryEntry): string {
  const C = appConfig.copy.admin.backup
  const s = e.source === 'api' ? C.histSourceApi
    : e.source === 'cli' ? C.histSourceCli
      : e.source === 'workbook' ? C.histSourceWorkbook
        : e.source === 'branding' ? C.histSourceBranding
          : e.source === 'geodata' ? C.histSourceGeodata
            : e.source === 'roster' ? C.histSourceRoster
              : C.histSourceUnknown
  if (e.replacedBy) return fillTemplate(C.histBy, { source: s, name: e.replacedBy })
  return e.source === 'api' ? fillTemplate(C.histBy, { source: s, name: C.histAdminOnly }) : s
}

/** «geändert: fleet.vehicles, map.defaultView» — capped, because a restore changes everything
 *  and its row would otherwise be a paragraph. An empty list is a statement of its own: the
 *  write stored exactly the document that was already there. */
function changedText(keys: readonly string[]): string {
  const C = appConfig.copy.admin.backup
  if (keys.length === 0) return C.histNoChange
  const named = keys.slice(0, MAX_NAMED).join(', ')
  const rest = keys.length - MAX_NAMED
  return fillTemplate(C.histChanged, { what: rest > 0 ? `${named} ${fillTemplate(C.histMore, { n: rest })}` : named })
}

/** One kept configuration: when, by which path, what that write did to the config, put back. */
function EntryRow({ e, nested, busy, onRestore }: {
  e: HistoryEntry
  nested?: boolean
  busy: boolean
  onRestore: (e: HistoryEntry) => void
}) {
  const C = appConfig.copy.admin.backup
  return (
    <div className={nested ? 'adm-hist-row adm-hist-nested' : 'adm-hist-row'}>
      <span className="adm-hist-when">{nested ? fmtTime(e.replacedAt) : fmtDateTime(e.replacedAt)}</span>
      <span className="adm-hist-what">
        <span className="adm-hist-src">{sourceLabel(e)}</span>
        {e.emptied.length > 0 && (
          <span className="adm-hist-warn">
            ⚠ {fillTemplate(C.histEmptied, { n: e.emptied.length, what: e.emptied.join(', ') })}
          </span>
        )}
        <span className="adm-hist-sub">{changedText(e.sections)}</span>
      </span>
      <button type="button" className="adm-hist-btn" disabled={busy} onClick={() => onRestore(e)}>
        {C.histRestore}
      </button>
    </div>
  )
}

/**
 * «Letzte Änderungen» — the undo for the most destructive operation this app has.
 *
 * ⚠️ Every write has always kept the document it replaced; the table was simply unreachable
 * from a browser, so recovering from a clobbered config meant an SSH session and
 * `admin_config history` / `restore` while the damage was live. This project has needed that
 * four times.
 *
 * ⚠️ Being reachable was not the same as being READABLE. A fresh station's first afternoon
 * produced 26 rows that all said «alarms, doctrine, fleet, identity, journal, map, mittel,
 * report, roster» — the sections a kept document CONTAINED, which is every section every time,
 * because every writer replaces the whole document. Four of them were inside the same minute.
 * The list could not answer the only question it is opened with: which entry do I go back to?
 *
 * So a row now says what the write CHANGED (`sections`, computed against the document that
 * replaced it — see backend config_history · changed_sections) and what it EMPTIED, and a burst
 * of autosaves from one hand collapses into one entry whose «Wiederherstellen» is the state
 * before the burst began. Nothing about what is stored, or about restoring, changed.
 */
export function ConfigHistory({ onRestored }: { onRestored: (cfg: DeploymentConfig) => void }) {
  const C = appConfig.copy.admin.backup
  const Cc = appConfig.copy.admin.common2
  const [rows, setRows] = useState<HistoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** ids of the collapsed groups an operator has opened (keyed by the group's newest entry) */
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set())

  const load = useCallback(async () => {
    try {
      setRows(await apiGet<HistoryEntry[]>('/api/config/history'))
      setError(null)
    } catch {
      setError(C.histFailed)
    }
  }, [C.histFailed])

  useEffect(() => { void load() }, [load])

  const [pending, setPending] = useState<HistoryEntry | null>(null)
  const groups = useMemo(() => groupBursts(rows ?? []), [rows])

  const toggle = (id: number) => setOpened((prev) => {
    const next = new Set(prev)
    if (!next.delete(id)) next.add(id)
    return next
  })

  /** What a restore of `e` would overwrite: every section touched by a write that landed AFTER
   *  it. The rows are newest-first from the API, so «after» is «above it in the list».
   *  ⚠️ Deliberately NOT `e.sections` — that is what the write which REPLACED this document
   *  changed, i.e. one step of the way back, not the distance being travelled. Naming the wrong
   *  set on the one screen that says «this disappears» is worse than naming none. */
  const overwrittenBy = (e: HistoryEntry): string[] => {
    const newer = (rows ?? []).filter((r) => r.replacedAt > e.replacedAt)
    return [...new Set(newer.flatMap((r) => r.sections))].sort()
  }

  // ⚠️ The product's own Sheet, not `window.confirm()` — this was the last browser dialog in the
  // Verwaltung, in front of a FULL-DOCUMENT replace. An installed iOS PWA may suppress one
  // without a trace, and a suppressed confirm reads as «no»: the button did nothing, silently,
  // on the device the Verwaltung is most often opened from. `.adm` sits at `--z-admin` and
  // admin.css lifts the Sheet above it, which is what makes this the primitive that works here.
  const restore = async (e: HistoryEntry) => {
    setPending(null)
    setBusy(e.id)
    try {
      onRestored(await apiPost<DeploymentConfig>(`/api/config/history/${e.id}/restore`))
      setNote(C.histRestored)
      await load() // the restore kept the document it replaced — that row belongs on the list
    } catch {
      setNote(C.histRestoreFailed)
    } finally {
      setBusy(null)
    }
  }

  if (error) return <div className="adm-state">{error}</div>
  if (!rows) return null

  return (
    <>
      <p className="adm-card-cap">{C.histCaption}</p>
      {note && <p className="adm-hint">{note}</p>}
      <div className="adm-hist">
        {/* The live document gets a row of its own. Without it the newest entry reads as «the
            current state», when it is in fact the state BEFORE the most recent write — the one
            distinction somebody restoring under pressure must not get wrong. */}
        <div className="adm-hist-row adm-hist-now">
          <span className="adm-hist-when">—</span>
          <span className="adm-hist-what"><span className="adm-hist-src">{C.histNow}</span></span>
          <span className="adm-hist-badge">{C.histActive}</span>
        </div>
        {rows.length === 0 && <div className="adm-state">{C.histEmpty}</div>}
        {groups.map((group) => {
          const newest = group[0]
          const oldest = group[group.length - 1]
          if (group.length === 1) {
            return (
              <EntryRow key={newest.id} e={newest} busy={busy !== null} onRestore={(e) => setPending(e)} />
            )
          }
          const open = opened.has(newest.id)
          return (
            <div className="adm-hist-burst" key={newest.id}>
              <div className="adm-hist-row">
                {/* the OLDEST timestamp leads, because that is the state the button puts back */}
                <span className="adm-hist-when">
                  {fmtDateTime(oldest.replacedAt)}
                  <span className="adm-hist-when-to">
                    {fillTemplate(C.histUntil, { time: fmtTime(newest.replacedAt) })}
                  </span>
                </span>
                <span className="adm-hist-what">
                  <span className="adm-hist-src">
                    {sourceLabel(newest)}
                    <span className="adm-hist-count">{fillTemplate(C.histBurst, { n: group.length })}</span>
                  </span>
                  <span className="adm-hist-sub">{changedText(unionChanged(group))}</span>
                  <button
                    type="button" className="adm-hist-toggle" aria-expanded={open}
                    onClick={() => toggle(newest.id)}
                  >
                    {open ? C.histBurstHide : C.histBurstShow}
                  </button>
                </span>
                <button
                  type="button" className="adm-hist-btn" disabled={busy !== null}
                  onClick={() => setPending(oldest)}
                >
                  {C.histRestore}
                </button>
              </div>
              {open && group.map((e) => (
                <EntryRow key={e.id} e={e} nested busy={busy !== null} onRestore={(x) => setPending(x)} />
              ))}
            </div>
          )
        })}
      </div>
      {pending && (
        <Sheet
          open
          onClose={() => setPending(null)}
          title={C.histRestoreTitle}
          fit
          modal
          footer={
            <>
              <button type="button" className="ip-btn ghost" onClick={() => setPending(null)}>{Cc.cancel}</button>
              <button type="button" className="ip-btn ip-btn-danger" onClick={() => void restore(pending)}>
                {C.histRestoreGo}
              </button>
            </>
          }
        >
          <p className="adm-card-cap">{fillTemplate(C.histRestoreLead, { when: fmtDateTime(pending.replacedAt) })}</p>
          {/* «here is what disappears», not «is that ok?» — the same shape the Sicherung's import
              sheet uses, and for the same reason: before the fact is the only time it can be
              acted on. Nothing listed means nothing was changed since, which is worth its own
              silence rather than an empty heading. */}
          {overwrittenBy(pending).length > 0 && (
            <>
              <p className="adm-card-cap">{C.histRestoreOverwrites}</p>
              <ul className="adm-import-errs">
                {overwrittenBy(pending).map((sec) => <li key={sec}>{sec}</li>)}
              </ul>
            </>
          )}
          <p className="adm-hint">{C.histRestoreKept}</p>
        </Sheet>
      )}
    </>
  )
}
