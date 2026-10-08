import { useState } from 'react'
import { apiPost, CONNECTOR_TIMEOUT_MS } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { ConfirmButton, ResultChip, fmtDateTime } from './ui'

/** What the roster-snapshot run stored about itself — `connector_states.detail` for the
 *  `roster_snapshot` row (backend · roster_snapshot_ingest.status_json). Everything optional:
 *  a row that has never run, or an older build, serves less. */
export interface RosterSnapshotCounts {
  held?: boolean
  unchanged?: boolean
  stale?: boolean
  activeBefore?: number
  deactivationLimit?: number | null
  pendingDeactivations?: number
  unmatchedTotal?: number
  lastGood?: { generatedAt: string; count: number } | null
  outcome?: {
    refused?: string | null
    created?: number
    updated?: number
    deactivated?: number
    unmatched?: Array<{ display_name: string; reason: string }>
    unknown_ranks?: string[]
  } | null
}

/** How many unmatched names the cell spells out before «…». */
const NAMES_SHOWN = 5

/** The roster-snapshot connector's own lines under its status badge on System › Verbindungen.
 *
 *  ⚠️ The only roster-snapshot UI there is, on purpose (owner, 08.10.2026: «as little active
 *  changes as possible»): the source is set on Anbindungen like every credential, the policy
 *  (interval, deactivation cap) in the config document, and what a run did is read HERE. Two
 *  buttons, both admin-only server-side: «Jetzt abrufen», and — only while a run is held by the
 *  deactivation cap — «Abgänge übernehmen», which is the human decision the hold waits for. */
export function RosterSnapshotDetail({ counts, onReload }: {
  counts: RosterSnapshotCounts | null | undefined
  onReload: () => Promise<void> | void
}) {
  const C = appConfig.copy.admin.system
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const outcome = counts?.outcome ?? null
  const refused = outcome?.refused ?? null
  const unmatched = (outcome?.unmatched ?? []).filter((u) => u.reason !== 'inactive_in_snapshot')
  const unmatchedTotal = counts?.unmatchedTotal ?? unmatched.length
  const unknownRanks = outcome?.unknown_ranks ?? []

  const run = async (force: boolean) => {
    setBusy(true)
    try {
      await apiPost('/api/personnel/snapshot/sync', { force }, undefined, CONNECTOR_TIMEOUT_MS)
      setResult({ tone: 'ok', text: C.snapRunOk })
    } catch {
      setResult({ tone: 'err', text: C.snapRunFailed })
    } finally {
      await onReload()
      setBusy(false)
    }
  }

  return (
    <>
      {counts?.held && (
        <p className="adm-card-cap">
          {fillTemplate(C.snapHeldText, {
            n: counts.pendingDeactivations ?? 0,
            total: counts.activeBefore ?? 0,
            limit: counts.deactivationLimit ?? 0,
          })}
        </p>
      )}
      {outcome && !refused && (
        <p className="adm-card-cap">
          {counts?.unchanged ? C.snapUnchanged : fillTemplate(C.snapSummary, {
            created: outcome.created ?? 0,
            updated: outcome.updated ?? 0,
            deactivated: outcome.deactivated ?? 0,
          })}
        </p>
      )}
      {counts?.held && unmatched.length > 0 && (
        <p className="adm-card-cap">
          {fillTemplate(C.snapHeldWho, {
            names: unmatched.slice(0, NAMES_SHOWN).map((u) => u.display_name).join(', ')
              + (unmatched.length > NAMES_SHOWN || unmatchedTotal > unmatched.length ? ' …' : ''),
          })}
        </p>
      )}
      {!counts?.held && unmatched.length > 0 && (
        <p className="adm-card-cap">
          {fillTemplate(C.snapUnmatched, {
            n: unmatched.length,
            names: unmatched.slice(0, NAMES_SHOWN).map((u) => u.display_name).join(', ')
              + (unmatched.length > NAMES_SHOWN || unmatchedTotal > unmatched.length ? ' …' : ''),
          })}
        </p>
      )}
      {unknownRanks.length > 0 && (
        <p className="adm-card-cap">{fillTemplate(C.snapUnknownRanks, { ranks: unknownRanks.join(', ') })}</p>
      )}
      {counts?.lastGood?.generatedAt && (
        <p className="adm-card-cap">{fillTemplate(C.snapFileDate, { time: fmtDateTime(counts.lastGood.generatedAt) })}</p>
      )}
      {counts?.stale && <p className="adm-card-cap">{C.snapStale}</p>}
      <div className="adm-sys-actions">
        <button type="button" className="btn adm-int-btn adm-sys-nudge" disabled={busy} onClick={() => void run(false)}>
          {busy ? C.snapRunning : C.snapRunNow}
        </button>
        {counts?.held && (
          <ConfirmButton
            label={C.snapRelease}
            question={fillTemplate(C.snapReleaseQ, { n: counts.pendingDeactivations ?? 0 })}
            danger
            className="btn adm-danger-btn adm-sys-nudge"
            disabled={busy}
            onConfirm={() => void run(true)}
          />
        )}
        {result && <ResultChip tone={result.tone} onExpire={() => setResult(null)}>{result.text}</ResultChip>}
      </div>
    </>
  )
}
