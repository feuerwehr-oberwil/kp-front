// Erfassung (station capture): manage the poster secret and print the Erfassungs-Poster.
// The poster hangs in the Magazin; scanning it opens the capture view (/e/<token>) where
// anyone can record attendance/material/notes for a recent incident — no login, no
// training. Rotation invalidates every printed poster at once (print a fresh one).
//
// Two jobs, now two groups of ONE settings sheet (admin/ui · «the settings table»):
// «Erfassungs-Poster» = the digital QR path (status → link → actions in consequence order,
// destructive last), «Erfassungsblatt» = the paper fallback. The prose that stood as captions
// and hints under the fields is the two dividers' ⓘ and the status row's ⓘ; the state and the
// link are rows, and only what is genuinely not a setting stays a full-width note — the copy
// warning, the rehearsal and the button row. Rotate/disable use the inline two-step confirm.

import { apiGet } from '../lib/api'
import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { InfoTip } from './InfoTip'
import {
  ConfirmButton, CopyChip, ResultChip, SettingRow, SettingsGroup, SettingsNote, SettingsSheet,
  StatusBadge, useSecret,
} from './ui'

const captureUrl = (token: string) => `${window.location.origin}/e/${token}`

export function CaptureAdminView() {
  const C = appConfig.copy.admin.erfassung
  // the same get/rotate/disable trio the Statistik and Einsatz-Link surfaces run on. This one
  // keeps its OWN markup: the poster button, the copy-warning and the Übung note sit between
  // the rows, and the paper Erfassungsblatt is a second group of the same sheet.
  const { state, busy, result, clearResult, report, rotate, disable } = useSecret('/api/capture/secret', {
    rotated: C.rotated, disabled: C.disabled, failed: C.failed,
  })

  // Poster: downloads a ready-to-print PDF (no popup, no print dialog) — the admin decides
  // when and where to print it. jsPDF + qrcode live in this lazy admin chunk.
  const printPoster = async () => {
    if (!state?.token) return
    try {
      const { downloadPosterPdf } = await import('./capturePdf')
      await downloadPosterPdf(captureUrl(state.token), getDeploymentConfig().identity?.appName ?? 'KP Front')
    } catch { report('err', C.failed) }
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
        // full analog twin of the digital record (docs/einsatzrapport-workflow.md): the
        // config-driven rows mirror the Rapport form, so paper→app transfer is 1:1.
        // (Kategorie deliberately NOT on paper — it's decided at WinFAP/app entry.)
        groups: cfg.alarms?.groups ?? [],
        vehicles: cfg.fleet?.vehicles ?? [],
        partnerOrgs: cfg.report?.partnerOrgs ?? [],
      })
    } catch { report('err', C.failed) }
  }

  if (state === null) return null
  return (
    <SettingsSheet>
      <SettingsGroup title={C.cardTitle} tip={C.body} />
      {/* The badge carries no label of its own — the row's Einstellung column names it. */}
      <SettingRow label={C.stateLabel} tip={C.hint}>
        <StatusBadge tone={state.configured ? 'on' : 'off'} label=""
          state={state.configured ? C.stateOn : C.stateOff} />
      </SettingRow>
      {state.token && (
        <SettingRow label={C.linkLabel} span>
          <CopyChip value={captureUrl(state.token)} />
        </SettingRow>
      )}
      {/* The copy button hands out the poster's whole secret. That is fine for a test or a
          Schulung — but it has to be said next to the button, not behind an ⓘ nobody opens. */}
      {state.token && <SettingsNote tone="warn">{C.linkWarn}</SettingsNote>}
      <SettingsNote>
        <div className="adm-actions">
          {state.configured ? (
            <>
              <button type="button" className="btn adm-save-btn" disabled={busy} onClick={() => void printPoster()}>{C.printBtn}</button>
              <ConfirmButton label={C.rotateBtn} question={C.rotateMsg} disabled={busy} onConfirm={() => void rotate()} />
              <ConfirmButton label={C.disableBtn} question={C.disableMsg} danger disabled={busy} onConfirm={() => void disable()} />
            </>
          ) : (
            <button type="button" className="btn adm-save-btn" disabled={busy} onClick={() => void rotate()}>{C.enableBtn}</button>
          )}
          {result && <ResultChip tone={result.tone} onExpire={clearResult}>{result.text}</ResultChip>}
        </div>
      </SettingsNote>
      {/* the rehearsal, named where the poster is made — an Übung is the one incident kind that
          is stats-excluded and may be deleted afterwards, which is what makes it the safe thing
          to hand a colleague before the poster goes on the wall. The four steps are a
          walkthrough, so they sit in the ⓘ; what stands inline is the one sentence saying
          there is one. */}
      {state.configured && (
        <SettingsNote>
          <strong>{C.testTitle}:</strong> {C.testLead}
          <InfoTip label={C.testTitle} text={C.testBody} />
        </SettingsNote>
      )}

      <SettingsGroup title={C.sheetCardTitle} tip={C.sheetCardBody} />
      <SettingsNote>
        <div className="adm-actions">
          <button type="button" className="btn adm-int-btn" disabled={busy} onClick={() => void printSheet()}>{C.sheetBtn}</button>
        </div>
      </SettingsNote>
    </SettingsSheet>
  )
}
