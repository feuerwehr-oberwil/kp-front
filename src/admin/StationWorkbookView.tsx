import { useRef, useState } from 'react'
import { apiGet, apiUpload, ApiError } from '../lib/api'
import { downloadBlob } from '../lib/download'
import { linkSessionHeaders } from '../lib/linkMode'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { useConfig } from './ConfigContext'
import type { DeploymentConfig } from '../lib/deploymentConfig'
import { Card, Table } from './ui'

// Verwaltung › Daten › Arbeitsmappe. Download the station's list-shaped data as one .xlsx,
// edit it in Excel/Numbers/LibreOffice, upload it back.
//
// ⚠️ THE CONFIRMATION SCREEN IS THE FEATURE. kp-rueck's equivalent computes what an import
// would delete, types it in its API client, and never renders it — and its own troubleshooting
// guide now carries a row titled «An Excel import deleted the whole roster». So the impact is
// not a detail on this page, it IS this page: per sheet, how many rows are new, how many
// change, what would be deactivated or removed BY NAME, and every refused row with the sheet
// and row number the operator can open in their own file. Nothing is written until they press
// «Jetzt übernehmen»; cancelling writes nothing at all, because nothing was ever sent.
//
// The file is parsed SERVER-SIDE, twice — once for the preview, once for the write. Parsing it
// here and PUTting a merged document would turn this into an ordinary full-document config
// write and defeat every guard in backend/app/config_history.py.

interface SheetImpact {
  sheet: string
  present: boolean
  rows: number
  created: number
  updated: number
  unchanged: number
  /** the ids/names that go away, already capped server-side */
  removed: string[]
  removed_total: number
  /** ⚠️ two meanings of «absent», two German words — see `removalWord` */
  removal_kind: 'removed' | 'deactivated' | 'none'
}

interface Preview {
  sheets: SheetImpact[]
  errors: string[]
  warnings: string[]
  emptied: string[]
  digest: string
  ok: boolean
}

interface ImportResult {
  sheets: SheetImpact[]
  warnings: string[]
  emptied: string[]
}

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  /** parsed and counted, nothing written — the operator decides from here */
  | { kind: 'preview'; file: File; preview: Preview }
  /** `stale` = the import landed but this tab could not re-read the document it wrote, so the
   *  editor is still holding the pre-import one. Only a reload fixes that, and it has to say so. */
  | { kind: 'done'; result: ImportResult; stale?: boolean }
  | { kind: 'error'; message: string }

/** The station's own file, straight from the server. A binary GET, so it goes around the JSON
 *  `apiGet` rather than through it; cookies still ride along (the admin session is httpOnly),
 *  and so does the session-mode header every /api call owes (api · rawFetch) — /admin is the
 *  ordinary app and must never be answered as some link cookie's viewer. */
async function downloadWorkbook(): Promise<void> {
  const res = await fetch('/api/station-workbook/export', {
    credentials: 'include',
    headers: linkSessionHeaders(),
  })
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`)
  const today = new Date().toISOString().slice(0, 10)
  downloadBlob(await res.blob(), `stationsdaten-${today}.xlsx`)
}

export function StationWorkbookView() {
  const C = appConfig.copy.admin.workbook
  const Cc = appConfig.copy.admin.common2
  // ⚠️ This page writes the config document, so it has to tell the shared editor about it —
  // see `onConfirm`. Every other config writer in /admin does (RosterView · applyServerRanks,
  // ConfigBackup · applyServerConfig); this one did not, and that is a silent revert.
  const { applyServerConfig } = useConfig()
  const [state, setState] = useState<State>({ kind: 'idle' })
  const fileRef = useRef<HTMLInputElement>(null)

  const clearInput = () => { if (fileRef.current) fileRef.current.value = '' }

  const onDownload = async () => {
    setState({ kind: 'busy' })
    try {
      await downloadWorkbook()
      setState({ kind: 'idle' })
    } catch (e) {
      setState({ kind: 'error', message: e instanceof ApiError ? e.detail : C.downloadFailed })
    }
  }

  /** Step 1 of the upload — ask the server what this file WOULD do. Writes nothing. */
  const onPick = async (file: File) => {
    setState({ kind: 'busy' })
    // ⚠️ Cleared HERE, not after the write: picking the same file twice in a row fires no
    // `change` event otherwise, so cancelling once made the button dead until a reload.
    clearInput()
    const form = new FormData()
    form.append('file', file)
    try {
      const preview = await apiUpload<Preview>('/api/station-workbook/preview', form)
      setState({ kind: 'preview', file, preview })
    } catch (e) {
      setState({ kind: 'error', message: e instanceof ApiError ? e.detail : C.previewFailed })
    }
  }

  /**
   * Step 2 — the operator confirmed. The digest pins it to the file they actually looked at.
   *
   * ⚠️ The import rewrites six sections of the config document SERVER-SIDE — `roster.ranks`,
   * `fleet.vehicles`, `fleet.partner`, `fleet.attributeLists`, `mittel.*`, `report.partnerOrgs`.
   * The shared editor read `/api/config` once, when the shell mounted, and would otherwise still
   * be holding the PRE-import document together with its version token: the next edit anywhere in
   * Verwaltung is then a 409, and the «Übernehmen» that offers itself writes the old document
   * back over the import. The personnel rows survive that (their own table), so the station is
   * left with people pointing at rank keys that no longer exist — exactly the split the import's
   * single-transaction rule exists to prevent.
   *
   * `applyServerConfig`, not the `applyServerRanks`-style fold: after an import the SERVER's
   * document is the authoritative one, in every section the file touched, and a fold can only
   * carry the branches it is written to name. It discards unsaved edits by design — which is the
   * right trade here, because any local draft is by definition older than the import the operator
   * just confirmed, and re-sending it is the clobber.
   */
  const onConfirm = async ({ file, preview }: { file: File; preview: Preview }) => {
    setState({ kind: 'busy' })
    const form = new FormData()
    form.append('file', file)
    form.append('digest', preview.digest)
    let result: ImportResult
    try {
      result = await apiUpload<ImportResult>('/api/station-workbook/import', form)
    } catch (e) {
      setState({ kind: 'error', message: e instanceof ApiError ? e.detail : C.importFailed })
      return
    }
    try {
      applyServerConfig(await apiGet<DeploymentConfig>('/api/config'))
      setState({ kind: 'done', result })
    } catch {
      // The write landed; only this tab's copy of it did not. Saying so is the whole point —
      // a page that stays quiet here is a page holding a document that must never be sent.
      setState({ kind: 'done', result, stale: true })
    }
  }

  const busy = state.kind === 'busy'

  return (
    <div className="adm-editor">
      {/* What this is, and — the part that keeps it honest — what it is NOT. A file that looks
          like the whole station is the file somebody will reach for after a bad day. */}
      <Card>
        <p className="adm-card-cap">{C.caption}</p>
        <p className="adm-hint">{C.covers}</p>
        <p className="adm-hint"><strong>{C.notBackup}</strong> {C.notBackupBody}</p>
        <p className="adm-hint">{C.carriesNot}</p>
        <p className="adm-hint">{C.nameNote}</p>
      </Card>

      <Card title={C.step1Title} caption={C.step1Body}>
        <div className="adm-brand-row">
          <button type="button" className="btn adm-int-btn" disabled={busy} onClick={() => void onDownload()}>
            {C.download}
          </button>
        </div>
      </Card>

      <Card title={C.step2Title} caption={C.step2Body}>
        <div className="adm-brand-row">
          <button type="button" className="btn adm-int-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            {state.kind === 'preview' ? C.chooseOther : C.choose}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPick(f) }}
          />
        </div>
        {busy && <p className="adm-card-cap">{C.busy}</p>}
        {state.kind === 'error' && <div className="adm-save-err">{state.message}</div>}
      </Card>

      {state.kind === 'preview' && (
        <Card title={C.previewTitle} caption={fillTemplate(C.previewLead, { file: state.file.name })}>
          <ImpactTable sheets={state.preview.sheets} />
          <Lines title={C.warningsTitle} lines={state.preview.warnings} />
          <Lines title={C.emptiedTitle} lines={state.preview.emptied} tone="warn" />
          <Lines title={C.errorsTitle} lines={state.preview.errors} tone="err" hint={C.errorsLead} />
          <div className="adm-brand-row">
            <button type="button" className="btn adm-int-btn" onClick={() => setState({ kind: 'idle' })}>
              {Cc.cancel}
            </button>
            <button
              type="button"
              className="btn adm-save-btn"
              disabled={!state.preview.ok}
              onClick={() => void onConfirm(state)}
            >
              {C.confirm}
            </button>
          </div>
          <p className="adm-hint">{state.preview.ok ? C.confirmHint : C.blockedHint}</p>
        </Card>
      )}

      {state.kind === 'done' && (
        <Card title={C.doneTitle}>
          <p className="adm-save-ok">{C.done}</p>
          <ImpactTable sheets={state.result.sheets} />
          <Lines title={C.emptiedTitle} lines={state.result.emptied} tone="warn" />
          {state.stale && <div className="adm-save-err">{C.reloadHint}</div>}
          <p className="adm-hint">{C.undoHint}</p>
        </Card>
      )}
    </div>
  )
}

/** ⚠️ Two meanings of «absent» in one workbook, and they need different German words: a person
 *  missing from Mannschaft is DEACTIVATED (soft — closed incidents still resolve their name), a
 *  vehicle id missing from Fahrzeuge is REMOVED from the list. An operator who reads one and
 *  gets the other has been misled by the screen that exists to protect them. */
function removalWord(kind: SheetImpact['removal_kind'], n: number): string {
  const C = appConfig.copy.admin.workbook
  if (kind === 'deactivated') return fillTemplate(C.deactivated, { n: String(n) })
  return fillTemplate(C.removedLabel, { n: String(n) })
}

function ImpactTable({ sheets }: { sheets: SheetImpact[] }) {
  const C = appConfig.copy.admin.workbook
  return (
    <Table
      columns={[
        { key: 'sheet', label: C.colSheet },
        { key: 'rows', label: C.colRows, num: true },
        { key: 'new', label: C.colNew, num: true },
        { key: 'upd', label: C.colChanged, num: true },
        { key: 'same', label: C.colUnchanged, num: true },
        { key: 'gone', label: C.colGone },
      ]}
    >
      {sheets.map((s) => (
        <tr key={s.sheet}>
          <td>{s.sheet}</td>
          {/* ⚠️ An absent sheet is NOT an empty sheet. «nicht in der Datei» has to read
              differently from «0», because one means «bleibt unverändert» and the other means
              «wird geleert» — and that difference is the whole safety design. */}
          {s.present ? (
            <>
              <td className="adm-num">{s.rows}</td>
              <td className="adm-num">{s.created || '—'}</td>
              <td className="adm-num">{s.updated || '—'}</td>
              <td className="adm-num">{s.unchanged || '—'}</td>
              <td>
                {s.removed_total === 0 ? '—' : (
                  <>
                    <strong>{removalWord(s.removal_kind, s.removed_total)}</strong>
                    {/* named, not counted: a number is useless to the person who has to act */}
                    <span className="adm-hint"> {s.removed.join(', ')}
                      {s.removed_total > s.removed.length
                        && ` ${fillTemplate(C.andMore, { n: String(s.removed_total - s.removed.length) })}`}
                    </span>
                  </>
                )}
              </td>
            </>
          ) : (
            <td colSpan={5} className="adm-card-cap">{C.sheetAbsent}</td>
          )}
        </tr>
      ))}
    </Table>
  )
}

/** One heading over a list of lines — refused rows, warnings, emptied sections. Each is its
 *  own edit in the operator's file, so they are listed, never run into one sentence. */
function Lines({ title, lines, tone, hint }: {
  title: string
  lines: string[]
  tone?: 'err' | 'warn'
  hint?: string
}) {
  if (lines.length === 0) return null
  return (
    <div className={tone === 'err' ? 'adm-save-err' : undefined}>
      <p className="adm-card-cap">{title}</p>
      {hint && <p className="adm-hint">{hint}</p>}
      <ul className="adm-import-errs">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </div>
  )
}
