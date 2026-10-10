import { ShellLoader } from '../components/ShellLoader'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, apiGet } from '../lib/api'
import { Sheet } from '../lib/overlays'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { downloadBlob } from '../lib/download'
import { isBoardTemplate, labelText, type BoardTemplate } from '../lib/boardTemplate'
import { BUNDLED_TEMPLATES } from '../lib/boardTemplates'
import type { ReferenceDataset } from '../lib/incidents'
import { ActionMenu, Card, EmptyState, Table, fmtDate } from './ui'
import { PlanSourceBadge } from './ObjectSheet'
import { deleteBoardTemplates, isBoardTemplateDataset, listReferenceDatasets, uploadChecklistFile } from './stationDataApi'
import './stationData.css'

// «Tafel-Vorlagen» (10.10.2026) — the station's board templates (board-template/1), the pages its
// Tafel offers under «+ Seite». The same registry and the same doors as the checklists
// (ChecklistsView): an upload is a PUT of `tafel:<id>` (the server validates it against its
// pydantic model), a delete is the prune `admin_board_templates push` uses. The bundled FKS file
// is downloadable here, because a station copy STARTS as that file (docs/board-templates.md) —
// and as long as nothing is stored, it is what the Tafel offers.

type Async<T> = { kind: 'loading' } | { kind: 'ok'; data: T } | { kind: 'error' }
interface Row { dataset: ReferenceDataset; slug: string; template: BoardTemplate | null }

const slugOf = (id: string) => id.slice('tafel:'.length)

function downloadFks(): void {
  const t = BUNDLED_TEMPLATES[0]
  downloadBlob(new Blob([`${JSON.stringify(t, null, 2)}\n`], { type: 'application/json' }), `${t.id}.json`)
}

/** The stored templates, each read once — it is small, and its pages are what the admin asks about. */
async function readRows(): Promise<Async<Row[]>> {
  try {
    const datasets = (await listReferenceDatasets()).filter((d) => isBoardTemplateDataset(d.id))
    const rows = await Promise.all(datasets.map(async (d) => {
      const j = await apiGet<unknown>(`/api/reference/${d.id}`).catch(() => null)
      return { dataset: d, slug: slugOf(d.id), template: isBoardTemplate(j) ? j : null }
    }))
    return { kind: 'ok', data: rows }
  } catch {
    return { kind: 'error' }
  }
}

export function BoardTemplatesView() {
  const C = appConfig.copy.admin.boardTemplates
  const Cd = appConfig.copy.admin.data
  const [state, setState] = useState<Async<Row[]>>({ kind: 'loading' })
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState<Row | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const reload = useCallback(() => readRows().then(setState), [])
  useEffect(() => {
    let live = true
    void readRows().then((st) => { if (live) setState(st) })
    return () => { live = false }
  }, [])
  const rows = state.kind === 'ok' ? state.data : []
  const fks = BUNDLED_TEMPLATES[0]

  return (
    <>
      <Card
        action={(
          <>
            <button type="button" className="btn adm-int-btn" onClick={downloadFks}>{C.example}</button>
            <button type="button" className="btn adm-save-btn" onClick={() => setUploading(true)}>{C.upload}</button>
          </>
        )}
      >
        {flash && <p className="adm-save-ok">{flash}</p>}
        {state.kind === 'loading' && <EmptyState loading message={C.loading} />}
        {state.kind === 'error' && <EmptyState tone="err" message={C.loadError} />}
        {state.kind === 'ok' && rows.length === 0 && (
          <EmptyState message={C.none} hint={`${C.noneHint} ${fillTemplate(C.bundled, { title: labelText(fks.title), n: fks.pages.length })}`} />
        )}
        {state.kind === 'ok' && rows.length > 0 && (
          <Table
            columns={[
              { key: 'title', label: C.colTitle },
              { key: 'slug', label: C.colSlug },
              { key: 'pages', label: C.colPages, num: true },
              { key: 'ver', label: C.colVersion },
              { key: 'date', label: C.colUpdated },
              { key: 'src', label: Cd.colSource },
              { key: 'act', label: C.colActions },
            ]}
          >
            {rows.map((row) => (
              <tr key={row.dataset.id}>
                <td><span className="adm-ref-title">{row.template ? labelText(row.template.title) : row.dataset.title ?? row.slug}</span></td>
                <td><code className="adm-view-key">{row.slug}</code></td>
                <td className="adm-num adm-mono">{row.template?.pages.length ?? '—'}</td>
                <td className="adm-mono">v{row.template?.version ?? row.dataset.current_version}</td>
                <td>{fmtDate(row.dataset.updated_at)}</td>
                <td>
                  <PlanSourceBadge sourceType={row.dataset.source_type} />
                  {row.dataset.source_note && <span className="adm-ref-note">{row.dataset.source_note}</span>}
                </td>
                <td className="adm-ck-actions adm-c-act">
                  <ActionMenu ariaLabel={`${row.slug} – ${C.colActions}`}
                    actions={[{ label: C.delete, onClick: () => setDeleting(row), danger: true }]} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {uploading && (
        <UploadSheet existing={rows} onClose={() => setUploading(false)}
          onDone={(msg) => { setUploading(false); setFlash(msg); void reload() }} />
      )}
      {deleting && (
        <DeleteSheet row={deleting} onClose={() => setDeleting(null)}
          onDone={(msg) => { setDeleting(null); setFlash(msg); void reload() }} />
      )}
    </>
  )
}

/** Pick a board-template JSON, see what it is, write it to `tafel:<its id>`. The client check is
 *  the cheap one (lib/boardTemplate · isBoardTemplate); the server's model has the last word. */
function UploadSheet({ existing, onClose, onDone }: { existing: Row[]; onClose: () => void; onDone: (message: string) => void }) {
  const C = appConfig.copy.admin.boardTemplates
  const Cc = appConfig.copy.admin.common2
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<BoardTemplate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pick = async (f: File) => {
    setFile(f); setParsed(null); setError(null)
    let j: unknown
    try { j = JSON.parse(await f.text()) } catch { setError(C.notTemplate); return }
    if (!isBoardTemplate(j)) { setError(C.notTemplate); return }
    setParsed(j)
  }
  const replaces = parsed ? existing.find((r) => r.slug === parsed.id) : undefined
  const submit = async () => {
    if (!parsed || !file || busy) return
    setBusy(true); setError(null)
    const title = labelText(parsed.title)
    try {
      await uploadChecklistFile(`tafel:${parsed.id}`, file, file.name, { title, sourceNote: file.name })
      onDone(fillTemplate(replaces ? C.replaced : C.added, { title }))
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : C.uploadFailed)
      setBusy(false)
    }
  }
  return (
    <Sheet open onClose={onClose} fit title={C.uploadTitle} sheetClassName="adm-ck-sheet"
      footer={(
        <>
          <button type="button" className="ip-btn" onClick={onClose}>{Cc.cancel}</button>
          <button type="button" className="ip-btn primary" disabled={!parsed || busy} onClick={() => void submit()}>
            {busy && <ShellLoader />}{busy ? C.uploadingLabel : C.uploadConfirm}
          </button>
        </>
      )}>
      <p className="adm-hint">{C.uploadHint}</p>
      <div className="adm-brand-row">
        <button type="button" className="btn adm-int-btn" onClick={() => fileRef.current?.click()}>{C.pickFile}</button>
        {file && <span className="adm-ref-note">{file.name}</span>}
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pick(f) }} />
      </div>
      {error && <p className="adm-state adm-state-err">{error}</p>}
      {parsed && (
        <>
          <ul className="adm-ck-facts">
            <li><span>{C.factTitle}</span><strong>{labelText(parsed.title)}</strong></li>
            <li><span>{C.factSlot}</span><code>tafel:{parsed.id}</code></li>
            <li><span>{C.factPages}</span><strong>{parsed.pages.map((p) => labelText(p.title)).join(' · ')}</strong></li>
            <li><span>{C.factVersion}</span><strong>v{parsed.version}</strong></li>
          </ul>
          <p className={replaces ? 'adm-state' : 'adm-hint'}>
            {replaces ? fillTemplate(C.willReplace, { title: replaces.dataset.title ?? replaces.slug, v: replaces.template?.version ?? replaces.dataset.current_version }) : C.willCreate}
          </p>
        </>
      )}
    </Sheet>
  )
}

function DeleteSheet({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: (message: string) => void }) {
  const C = appConfig.copy.admin.boardTemplates
  const Cc = appConfig.copy.admin.common2
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const title = row.template ? labelText(row.template.title) : row.dataset.title ?? row.slug
  const submit = async () => {
    setBusy(true); setError(null)
    try {
      const res = await deleteBoardTemplates([row.dataset.id])
      onDone(fillTemplate(C.deleted, { n: res.pruned.length }))
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : C.deleteFailed)
      setBusy(false)
    }
  }
  return (
    <Sheet open onClose={onClose} fit title={C.deleteTitle} sheetClassName="adm-ck-sheet"
      footer={(
        <>
          <button type="button" className="ip-btn" onClick={onClose}>{Cc.cancel}</button>
          <button type="button" className="ip-btn ip-btn-danger" disabled={busy} onClick={() => void submit()}>
            {busy && <ShellLoader />}{busy ? C.deleting : C.delete}
          </button>
        </>
      )}>
      <p className="adm-state">{fillTemplate(C.deleteBody, { title })}</p>
      <ul className="adm-ck-facts"><li><code>{row.dataset.id}</code></li></ul>
      {error && <p className="adm-state adm-state-err">{error}</p>}
    </Sheet>
  )
}
