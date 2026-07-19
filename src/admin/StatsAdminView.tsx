// Statistik-Export: manage the read-only stats token (GET /api/stats/incidents). External
// analytics (e.g. a yearly-statistics dashboard) authenticate with this token; rotation
// cuts off every consumer at once. Fail-closed: no token → the export answers 403.

import { useCallback, useEffect, useState } from 'react'
import { apiDelete, apiGet, apiPost } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { Card, ConfirmButton, CopyChip, ResultChip, StatusBadge } from './ui'

interface SecretState { configured: boolean; token?: string | null }

export function StatsAdminView() {
  const C = appConfig.copy.admin.statistik
  const [state, setState] = useState<SecretState | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const reload = useCallback(async () => {
    try { setState(await apiGet<SecretState>('/api/stats/secret')) } catch { setState({ configured: false }) }
  }, [])
  useEffect(() => { void reload() }, [reload])

  const rotate = async () => {
    setBusy(true)
    try {
      setState(await apiPost<SecretState>('/api/stats/secret/rotate', {}))
      setResult({ tone: 'ok', text: C.rotated })
    } catch { setResult({ tone: 'err', text: C.failed }) } finally { setBusy(false) }
  }

  const disable = async () => {
    setBusy(true)
    try {
      await apiDelete('/api/stats/secret')
      setState({ configured: false })
      setResult({ tone: 'ok', text: C.disabled })
    } catch { setResult({ tone: 'err', text: C.failed }) } finally { setBusy(false) }
  }

  if (state === null) return null
  const curl = state.token
    ? `curl -H "X-Stats-Token: ${state.token}" ${window.location.origin}/api/stats/incidents?year=${new Date().getFullYear()}`
    : ''
  return (
    <Card>
      <p className="adm-card-cap">{C.body}</p>
      <div className="adm-cap-rows">
        <div className="adm-cap-status">
          <StatusBadge tone={state.configured ? 'on' : 'off'} label={C.stateLabel} state={state.configured ? C.stateOn : C.stateOff} />
        </div>
        {state.token && <CopyChip value={state.token} display={`${C.tokenLabel}: ${state.token}`} />}
        {state.token && (
          <div className="adm-cap-example">
            <p className="adm-card-cap">{C.exampleLabel} — <a href="https://github.com/feuerwehr-oberwil/kp-front/blob/main/docs/STATS-EXPORT.md" target="_blank" rel="noreferrer">API-Doku</a></p>
            <CopyChip value={curl} />
          </div>
        )}
      </div>
      <div className="adm-actions">
        {state.configured ? (
          <>
            <ConfirmButton label={C.rotateBtn} question={C.rotateMsg} primary disabled={busy} onConfirm={() => void rotate()} />
            <ConfirmButton label={C.disableBtn} question={C.disableMsg} danger disabled={busy} onConfirm={() => void disable()} />
          </>
        ) : (
          <button type="button" className="btn adm-save-btn" disabled={busy} onClick={() => void rotate()}>{C.enableBtn}</button>
        )}
        {result && <ResultChip tone={result.tone} onExpire={() => setResult(null)}>{result.text}</ResultChip>}
      </div>
      <p className="adm-card-cap">{C.hint}</p>
    </Card>
  )
}
