import { useEffect, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { Sheet } from '../lib/overlays'
import { fillTemplate } from '../lib/format'
import { personnelSyncExecute, personnelSyncPreview, type PersonnelSyncPreview, type PersonnelSyncResult } from '../lib/incidents'

// Editor-only provider sync: fetch a read-only preview (new /
// updated / unchanged / stale), let the EL confirm — including whether to deactivate stale
// members — then execute and report what was applied. Never hard-deletes; stale people are
// only ever hidden, so old incidents/reports keep resolving their names.
export function PersonnelSyncDialog({ provider, onClose, onSynced }: { provider: string; onClose: () => void; onSynced: () => void }) {
  const ps = appConfig.copy.personnelSync
  const [preview, setPreview] = useState<PersonnelSyncPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deactivateStale, setDeactivateStale] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<PersonnelSyncResult | null>(null)

  useEffect(() => {
    let alive = true
    personnelSyncPreview()
      .then((p) => { if (alive) setPreview(p) })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : ps.unknownError) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await personnelSyncExecute(deactivateStale)
      setResult(res)
      onSynced()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : ps.syncFailed)
    } finally {
      setBusy(false)
    }
  }

  const counts = preview && [
    { n: preview.new.length, label: ps.countNew },
    { n: preview.updated.length, label: ps.countUpdated },
    { n: preview.unchanged.length, label: ps.countUnchanged },
    { n: preview.stale.length, label: fillTemplate(ps.countStale, { provider }) },
  ]

  return (
    <Sheet open onClose={onClose} title={fillTemplate(ps.title, { provider })}>
      {loading ? (
        <p className="ip-note"><Icon id="rotate" /> {fillTemplate(ps.querying, { provider })}</p>
      ) : error && !result ? (
        <p className="ip-note"><Icon id="warn" /> {error}</p>
      ) : result ? (
        <>
          <p className="ip-note"><Icon id="check" /> {ps.done}</p>
          <ul className="psync-result">
            <li>{fillTemplate(ps.resultCreated, { n: result.created })}</li>
            <li>{fillTemplate(ps.resultUpdated, { n: result.updated })}{result.reactivated ? fillTemplate(ps.resultReactivated, { n: result.reactivated }) : ''}</li>
            <li>{fillTemplate(ps.resultUnchanged, { n: result.unchanged })}</li>
            <li>{fillTemplate(ps.resultDeactivated, { n: result.deactivated })}</li>
          </ul>
          <div className="ip-actions">
            <button className="ip-btn primary" onClick={onClose}><Icon id="check" /> {appConfig.copy.done}</button>
          </div>
        </>
      ) : preview ? (
        <>
          <ul className="psync-counts">
            {counts!.map((c) => (
              <li key={c.label}><b>{c.n}</b> <span>{c.label}</span></li>
            ))}
          </ul>
          {preview.stale.length > 0 && (
            <label className="psync-stale">
              <input type="checkbox" checked={deactivateStale} onChange={(e) => setDeactivateStale(e.target.checked)} />
              <span>{fillTemplate(ps.staleHide, { n: preview.stale.length, provider })}</span>
            </label>
          )}
          <div className="ip-actions">
            <button className="ip-btn" onClick={onClose} disabled={busy}>{appConfig.copy.cancel}</button>
            <button className="ip-btn primary" onClick={() => void run()} disabled={busy}>
              <Icon id="rotate" />{busy ? ps.syncing : ps.sync}
            </button>
          </div>
        </>
      ) : null}
    </Sheet>
  )
}
