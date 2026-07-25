import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPost, apiPut } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { Card, ConfirmButton, CopyChip, EmptyState, StatusBadge } from './ui'

// The consent switch, and — more importantly — the receipts.
//
// A toggle on its own is not a privacy feature; anyone can draw a toggle. What makes this
// defensible to a fire station is the list underneath it: the exact payloads this instance
// has queued or sent, verbatim, straight out of the outbox table. The station can read what
// left before deciding whether it should have, and can keep reading afterwards.
//
// Deliberately lives in /admin rather than in the operator's Einstellungen sheet: the
// deployment is the data controller here, not whoever happens to be holding the tablet.

interface OutboxRow {
  id: string
  channel: 'error' | 'report'
  createdAt: string | null
  sentAt: string | null
  attempts: number
  lastError: string | null
  payload: unknown
}

interface TelemetryStatus {
  consent: 'off' | 'errors'
  /** false = nobody has ever answered. Not the same state as a deliberate "off". */
  decided: boolean
  installId: string | null
  /** false when the DEPLOYER disabled outbound in env — the switch then cannot do anything */
  outboundAllowed: boolean
  ingestConfigured: boolean
  pending: number
  recent: OutboxRow[]
}

export function TelemetryCard() {
  const C = appConfig.copy.admin.telemetry
  const [status, setStatus] = useState<TelemetryStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await apiGet<TelemetryStatus>('/api/diag/telemetry'))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const setConsent = async (consent: 'off' | 'errors') => {
    setBusy(true)
    try {
      await apiPut('/api/diag/telemetry/consent', { consent })
      await load()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const rotate = async () => {
    setBusy(true)
    try {
      await apiPost('/api/diag/telemetry/install-id', {})
      await load()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (failed) return <Card title={C.title}><EmptyState tone="err" message={C.loadError} /></Card>
  if (!status) return <Card title={C.title}><EmptyState message={C.loading} /></Card>

  const on = status.consent === 'errors'
  // The env kill switch outranks this screen. Saying so plainly is better than showing a
  // switch that silently does nothing.
  const locked = !status.outboundAllowed

  // Never asked: put the question itself on screen, with neither answer preselected and
  // neither one styled as the obvious choice. A pre-ticked box is not consent, and a
  // "Nein danke" in grey next to a bright "Ja" is a pre-ticked box with extra steps.
  if (!status.decided && !locked) {
    return (
      <Card title={C.title} caption={C.askCaption} tip={C.tip}>
        <p className="adm-tel-ask">{C.askQuestion}</p>
        <p className="adm-card-cap">{C.explain}</p>
        <div className="adm-tel-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void setConsent('off')}>
            {C.askNo}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void setConsent('errors')}>
            {C.askYes}
          </button>
        </div>
        <p className="adm-card-cap">{C.askLater}</p>
      </Card>
    )
  }

  return (
    <Card title={C.title} caption={C.caption} tip={C.tip}>
      <div className="adm-tel-state">
        <StatusBadge
          tone={locked ? 'warn' : on ? 'on' : 'off'}
          label={locked ? C.lockedBadge : on ? C.onBadge : C.offBadge}
          state={locked ? C.lockedState : on ? C.onState : C.offState}
        />
      </div>

      <p className="adm-card-cap">{locked ? C.lockedNote : C.explain}</p>

      {!locked && (
        <div className="adm-tel-actions">
          <button
            type="button"
            className={`btn${on ? '' : ' primary'}`}
            disabled={busy || !on}
            onClick={() => void setConsent('off')}
          >
            {C.turnOff}
          </button>
          <button
            type="button"
            className={`btn${on ? ' primary' : ''}`}
            disabled={busy || on}
            onClick={() => void setConsent('errors')}
          >
            {C.turnOn}
          </button>
        </div>
      )}

      {status.installId ? (
        <div className="adm-tel-id">
          <span className="adm-sys-metric-label">{C.installId}</span>
          <CopyChip value={status.installId} />
          <ConfirmButton
            label={C.rotate}
            question={C.rotateConfirm}
            disabled={busy}
            onConfirm={() => void rotate()}
          />
        </div>
      ) : (
        <p className="adm-card-cap">{C.noInstallId}</p>
      )}

      {/* The receipts. Verbatim, newest first — this is the outbox table, not a summary. */}
      <div className="adm-tel-log">
        <h4 className="adm-tel-log-t">{C.sentTitle}</h4>
        {status.recent.length === 0 ? (
          <p className="adm-card-cap">{C.nothingSent}</p>
        ) : (
          status.recent.map((row) => (
            <details key={row.id} className="adm-tel-row">
              <summary>
                <span className="adm-tel-ch">{row.channel === 'report' ? C.chReport : C.chError}</span>
                <span className="adm-tel-when">{row.createdAt?.slice(0, 16).replace('T', ' ')}</span>
                <span className={`adm-tel-st${row.sentAt ? ' sent' : ''}`}>
                  {row.sentAt ? C.stSent : row.lastError ? `${C.stPending} (${row.lastError})` : C.stPending}
                </span>
              </summary>
              <pre className="adm-tel-payload">{JSON.stringify(row.payload, null, 2)}</pre>
            </details>
          ))
        )}
        {status.pending > 0 && <p className="adm-card-cap">{C.pendingNote}</p>}
      </div>
    </Card>
  )
}
