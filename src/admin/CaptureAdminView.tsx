// Erfassung (station capture): manage the poster secret and print the Erfassungs-Poster.
// The poster hangs in the Magazin; scanning it opens the capture view (/e/<token>) where
// anyone can record attendance/material/notes for a recent incident — no login, no
// training. Rotation invalidates every printed poster at once (print a fresh one).
//
// Two cards, two jobs (UX rework 2026-07-14): «Erfassungs-Poster» = the digital QR path
// (status → link → actions in consequence order, destructive last), «Erfassungsblatt» =
// the paper fallback. Copy buttons on the link; rotate/disable use the inline two-step
// confirm instead of native dialogs.

import { useCallback, useEffect, useState } from 'react'
import { apiDelete, apiGet, apiPost } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { Card, ConfirmButton, CopyChip, ResultChip, StatusBadge } from './ui'

interface SecretState { configured: boolean; token?: string | null }

const captureUrl = (token: string) => `${window.location.origin}/e/${token}`

export function CaptureAdminView() {
  const C = appConfig.copy.admin.erfassung
  const [state, setState] = useState<SecretState | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const reload = useCallback(async () => {
    try { setState(await apiGet<SecretState>('/api/capture/secret')) } catch { setState({ configured: false }) }
  }, [])
  useEffect(() => { void reload() }, [reload])

  const rotate = async () => {
    setBusy(true)
    try {
      setState(await apiPost<SecretState>('/api/capture/secret/rotate', {}))
      setResult({ tone: 'ok', text: C.rotated })
    } catch { setResult({ tone: 'err', text: C.failed }) } finally { setBusy(false) }
  }

  const disable = async () => {
    setBusy(true)
    try {
      await apiDelete('/api/capture/secret')
      setState({ configured: false })
      setResult({ tone: 'ok', text: C.disabled })
    } catch { setResult({ tone: 'err', text: C.failed }) } finally { setBusy(false) }
  }

  // Poster: downloads a ready-to-print PDF (no popup, no print dialog) — the admin decides
  // when and where to print it. jsPDF + qrcode live in this lazy admin chunk.
  const printPoster = async () => {
    if (!state?.token) return
    try {
      const { downloadPosterPdf } = await import('./capturePdf')
      await downloadPosterPdf(captureUrl(state.token), getDeploymentConfig().identity?.appName ?? 'KP Front')
    } catch { setResult({ tone: 'err', text: C.failed }) }
  }

  // A4 Erfassungsblatt: the paper twin of the digital record, generated on demand from the
  // CURRENT roster + Mittel catalogue + config lists (groups/vehicles/partner). Used sheets
  // get photographed into the incident's Verlauf (Beilage) and transferred in the app.
  const printSheet = async () => {
    let names: string[] = []
    try {
      const people = await apiGet<{ display_name: string; active?: boolean; is_active?: boolean }[]>('/api/personnel')
      names = people.filter((p) => p.is_active ?? p.active ?? true).map((p) => p.display_name).sort((a, b) => a.localeCompare(b, 'de-CH'))
    } catch { /* roster unavailable → the blank guest lines still make a usable sheet */ }
    try {
      const { downloadSheetPdf } = await import('./capturePdf')
      const cfg = getDeploymentConfig()
      downloadSheetPdf({
        stationName: cfg.identity?.appName ?? 'KP Front',
        names,
        catalogue: cfg.mittel?.catalogue ?? appConfig.mittel.catalogue,
        // full analog twin of the digital record (stats-integration.md Table A): the
        // config-driven rows mirror the Rapport form, so paper→app transfer is 1:1.
        // (Kategorie deliberately NOT on paper — it's decided at WinFAP/app entry.)
        groups: cfg.alarms?.groups ?? [],
        vehicles: cfg.fleet?.vehicles ?? [],
        partnerOrgs: cfg.report?.partnerOrgs ?? [],
      })
    } catch { setResult({ tone: 'err', text: C.failed }) }
  }

  if (state === null) return null
  return (
    <>
      <Card title={C.cardTitle} caption={C.body}>
        <div className="adm-cap-rows">
          <div className="adm-cap-status">
            <StatusBadge tone={state.configured ? 'on' : 'off'} label={C.stateLabel} state={state.configured ? C.stateOn : C.stateOff} />
          </div>
          {state.token && <CopyChip value={captureUrl(state.token)} />}
        </div>
        <div className="adm-actions adm-cap-actions">
          {state.configured ? (
            <>
              <button type="button" className="btn adm-save-btn" disabled={busy} onClick={() => void printPoster()}>{C.printBtn}</button>
              <ConfirmButton label={C.rotateBtn} question={C.rotateMsg} disabled={busy} onConfirm={() => void rotate()} />
              <ConfirmButton label={C.disableBtn} question={C.disableMsg} danger disabled={busy} onConfirm={() => void disable()} />
            </>
          ) : (
            <button type="button" className="btn adm-save-btn" disabled={busy} onClick={() => void rotate()}>{C.enableBtn}</button>
          )}
        </div>
        {result && <ResultChip tone={result.tone} onExpire={() => setResult(null)}>{result.text}</ResultChip>}
        <p className="adm-card-cap">{C.hint}</p>
      </Card>

      <Card title={C.sheetCardTitle} caption={C.sheetCardBody}>
        <div className="adm-actions">
          <button type="button" className="btn adm-int-btn" disabled={busy} onClick={() => void printSheet()}>{C.sheetBtn}</button>
        </div>
      </Card>
    </>
  )
}
