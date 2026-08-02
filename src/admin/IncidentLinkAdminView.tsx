// Einsatz-Link: manage the minting key (GET/POST/DELETE /api/incident-link/secret). The
// alerting system holds this key and signs the link tokens it puts into the alert itself —
// KP Front generates the key, hands it out once, and is never called to mint a link.
// Rotation invalidates every link already sent out at once. Fail-closed: no key → the whole
// link surface is off, so deleting the key IS the off switch.

import { useCallback, useEffect, useState } from 'react'
import { apiDelete, apiGet, apiPost } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { Card, ConfirmButton, CopyChip, ResultChip, StatusBadge } from './ui'

interface SecretState { configured: boolean; token?: string | null }

const DOCS_URL =
  'https://github.com/feuerwehr-oberwil/kp-front/blob/main/docs/ALARM-INTEGRATIONS.md#4-the-einsatz-link-read-only-link-into-one-incident'

export function IncidentLinkAdminView() {
  const C = appConfig.copy.admin.einsatzlink
  const [state, setState] = useState<SecretState | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const reload = useCallback(async () => {
    try { setState(await apiGet<SecretState>('/api/incident-link/secret')) } catch { setState({ configured: false }) }
  }, [])
  useEffect(() => { void reload() }, [reload])

  const rotate = async () => {
    setBusy(true)
    try {
      setState(await apiPost<SecretState>('/api/incident-link/secret/rotate', {}))
      setResult({ tone: 'ok', text: C.rotated })
    } catch { setResult({ tone: 'err', text: C.failed }) } finally { setBusy(false) }
  }

  const disable = async () => {
    setBusy(true)
    try {
      await apiDelete('/api/incident-link/secret')
      setState({ configured: false })
      setResult({ tone: 'ok', text: C.disabled })
    } catch { setResult({ tone: 'err', text: C.failed }) } finally { setBusy(false) }
  }

  if (state === null) return null
  // The URL shape the alerting system composes around its own signed token — the one thing
  // besides the key an operator has to type into the other system.
  const linkPattern = `${window.location.origin}/l/<token>`
  return (
    <Card>
      <p className="adm-card-cap">{C.body}</p>
      <div className="adm-cap-rows">
        <div className="adm-cap-status">
          <StatusBadge tone={state.configured ? 'on' : 'off'} label={C.stateLabel} state={state.configured ? C.stateOn : C.stateOff} />
        </div>
        {state.token && <CopyChip value={state.token} display={`${C.keyLabel}: ${state.token}`} />}
        {state.token && (
          <div className="adm-cap-example">
            <p className="adm-card-cap">{C.exampleLabel} — <a href={DOCS_URL} target="_blank" rel="noreferrer">{C.docsLink}</a></p>
            <CopyChip value={linkPattern} />
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
