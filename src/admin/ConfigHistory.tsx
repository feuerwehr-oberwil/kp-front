import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPost } from '../lib/api'
import type { DeploymentConfig } from '../lib/deploymentConfig'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { fmtDateTime } from './ui'

/** One kept configuration, as the API projects it (backend api/config · ConfigHistoryEntry). */
interface HistoryEntry {
  id: number
  replacedAt: string
  source: string | null
  replacedBy: string | null
  sections: string[]
  emptied: string[]
}

/**
 * «Letzte Änderungen» — the undo for the most destructive operation this app has.
 *
 * ⚠️ Every write has always kept the document it replaced; the table was simply unreachable
 * from a browser, so recovering from a clobbered config meant an SSH session and
 * `admin_config history` / `restore` while the damage was live. This project has needed that
 * four times.
 *
 * The row leads with WHAT THE WRITE EMPTIED rather than with a diff. A diff of a clobbered
 * config is hundreds of lines and reads as noise; «hat 4 Abschnitte geleert: roster.ranks,
 * doctrine, fleet.vehicles, alarms.groups» is the damage, in the words of the thing that was
 * lost. It is also what distinguishes an ordinary edit from an incident at a glance.
 */
export function ConfigHistory({ onRestored }: { onRestored: (cfg: DeploymentConfig) => void }) {
  const C = appConfig.copy.admin.backup
  const [rows, setRows] = useState<HistoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setRows(await apiGet<HistoryEntry[]>('/api/config/history'))
      setError(null)
    } catch {
      setError(C.histFailed)
    }
  }, [C.histFailed])

  useEffect(() => { void load() }, [load])

  /** «Verwaltung», «Kommandozeile» … — the path, in words. `api` + no name is worth being able
   *  to read as such: that combination is the signature of an unattended writer, which is
   *  exactly what the fourth incident turned out to be. */
  const sourceLabel = (e: HistoryEntry) => {
    const s = e.source === 'api' ? C.histSourceApi
      : e.source === 'cli' ? C.histSourceCli
        : e.source === 'branding' ? C.histSourceBranding
          : e.source === 'geodata' ? C.histSourceGeodata
            : C.histSourceUnknown
    return e.replacedBy ? fillTemplate(C.histBy, { source: s, name: e.replacedBy }) : s
  }

  const restore = async (e: HistoryEntry) => {
    const when = fmtDateTime(e.replacedAt)
    if (!window.confirm(fillTemplate(C.histRestoreConfirm, { when }))) return
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
        {rows.map((e) => (
          <div className="adm-hist-row" key={e.id}>
            <span className="adm-hist-when">{fmtDateTime(e.replacedAt)}</span>
            <span className="adm-hist-what">
              <span className="adm-hist-src">{sourceLabel(e)}</span>
              {e.emptied.length > 0
                ? (
                  <span className="adm-hist-warn">
                    ⚠ {fillTemplate(C.histEmptied, { n: e.emptied.length, what: e.emptied.join(', ') })}
                  </span>
                )
                : <span className="adm-hist-sub">{e.sections.join(', ')}</span>}
            </span>
            <button
              type="button" className="adm-hist-btn" disabled={busy !== null}
              onClick={() => void restore(e)}
            >
              {C.histRestore}
            </button>
          </div>
        ))}
      </div>
    </>
  )
}
