import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../lib/api'
import { Sheet } from '../lib/overlays'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import type { ReferenceDataset } from '../lib/incidents'
import { Card, EmptyState, Field, Table, fmtDate } from './ui'
import {
  checklistUploadBlob,
  deleteChecklistDatasets,
  groupChecklists,
  listReferenceDatasets,
  parseChecklistTemplate,
  uploadChecklistFile,
  type ChecklistRow,
  type ParsedChecklist,
} from './stationDataApi'
import './stationData.css'

// «Checklisten» — the station's FU/EL checklist templates, in a browser.
//
// Until now this was the only kind of station data with no admin surface AT ALL: the templates
// the Checkliste tab runs on could only be put there by `admin_checklists` from a workstation
// with uv and a clone of the repo. The endpoints were already there and already validated the
// template shape server-side (api/reference · _validate_checklist_template).
//
// ⚠️ Deletion is the reason this page has more than an upload button. `admin_checklists load`
// PRUNES: it sends the manifest's complete id list and the server drops every other
// `checklists:*` dataset. Uploading is per-file and cannot do that, so a template renamed in the
// browser (fu-aktion → fu-aktion-2026) would leave the old one behind, still served, still
// fetched by every tablet. The page therefore drives the same prune endpoint explicitly.

type Async<T> = { kind: 'loading' } | { kind: 'ok'; data: T } | { kind: 'error' }

/** The Checklisten page: the stored templates, an upload, and the delete the prune door makes
 *  possible. The table sorts by slug (stable without fetching every template); the field app
 *  sorts by the `order` stamped into each document. */
export function ChecklistsView() {
  const C = appConfig.copy.admin.checklists
  const [state, setState] = useState<Async<ReferenceDataset[]>>({ kind: 'loading' })
  const [uploading, setUploading] = useState(false)
  const [assetFor, setAssetFor] = useState<ChecklistRow | null>(null)
  const [deleting, setDeleting] = useState<ChecklistRow | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  /**
   * Re-read the registry after a write.
   *
   * This used to take a predicate and re-read a second time when the write it had just made was
   * missing, because the backend had a real read-after-write race (about 1 in 15) that showed up
   * here as «hinzugefügt» over an empty table. It doesn't any more: `get_db` commits before the
   * response is sent, not in FastAPI's request-scope teardown after it. Guarded by
   * backend/tests/test_db_commit_ordering.py.
   */
  const reload = useCallback(async () => {
    try {
      setState({ kind: 'ok', data: await listReferenceDatasets() })
    } catch {
      setState({ kind: 'error' })
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const datasets = state.kind === 'ok' ? state.data : []
  const { rows, orphanAssets } = groupChecklists(datasets)

  const cleanOrphans = async () => {
    setCleaning(true)
    try {
      const gone = new Set(orphanAssets.map((a) => a.id))
      const res = await deleteChecklistDatasets([...gone])
      setFlash(fillTemplate(C.deleted, { n: res.pruned.length }))
      await reload()
    } catch { /* the list reload below tells the truth either way */ }
    setCleaning(false)
  }

  return (
    <>
      <Card>
        <p className="adm-hint">{C.intro}</p>
        <p className="adm-hint">{C.pruneNote}</p>
        <p className="adm-hint">{C.cliHint} <code>{C.cliCmd}</code></p>
        <div className="adm-brand-row">
          <button type="button" className="btn primary adm-int-btn" onClick={() => setUploading(true)}>
            {C.upload}
          </button>
          {flash && <span className="adm-save-ok">{flash}</span>}
        </div>
      </Card>

      <Card>
        {state.kind === 'loading' && <EmptyState message={C.loading} />}
        {state.kind === 'error' && <EmptyState tone="err" message={C.loadError} />}
        {state.kind === 'ok' && rows.length === 0 && <EmptyState message={C.none} hint={C.noneHint} />}
        {state.kind === 'ok' && rows.length > 0 && (
          <Table
            columns={[
              { key: 'title', label: C.colTitle },
              { key: 'kind', label: C.colSlug },
              { key: 'ver', label: C.colVersion },
              { key: 'date', label: C.colUpdated },
              { key: 'assets', label: C.colAssets, num: true },
              { key: 'act', label: C.colActions },
            ]}
          >
            {rows.map((row) => (
              <tr key={row.dataset.id}>
                <td>
                  <span className="adm-ref-title">{row.dataset.title ?? row.slug}</span>
                  {row.dataset.source_note && <span className="adm-ref-note">{row.dataset.source_note}</span>}
                </td>
                <td><code className="adm-view-key">{row.slug}</code></td>
                <td className="adm-mono">v{row.dataset.current_version}</td>
                <td>{fmtDate(row.dataset.updated_at)}</td>
                <td className="adm-num adm-mono">
                  {row.assets.length || <span className="adm-fleet-freeval">—</span>}
                </td>
                {/* Deliberately NOT the shared `ActionMenu`: two actions do not need a menu.
                    (The stacking bug that ALSO argued against it — the popup painting behind
                    `.adm` on v0.6.0 — is fixed; see `.ui-menu-pos` in lib/overlays/Menu.) */}
                <td className="adm-ck-actions">
                  <button
                    type="button"
                    className="btn adm-int-btn"
                    onClick={() => setAssetFor(row)}
                    aria-label={fillTemplate(C.assetTitle, { title: row.dataset.title ?? row.slug })}
                  >
                    {C.addAsset}
                  </button>
                  <button
                    type="button"
                    className="btn adm-int-btn adm-ck-del"
                    onClick={() => setDeleting(row)}
                    aria-label={fillTemplate(C.deleteAria, { title: row.dataset.title ?? row.slug })}
                  >
                    {C.delete}
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        )}
        {orphanAssets.length > 0 && (
          <div className="adm-ck-orphans">
            <p className="adm-state adm-state-err">
              {fillTemplate(C.orphans, { n: orphanAssets.length })}
            </p>
            <p className="adm-hint">{orphanAssets.map((a) => a.id).join(' · ')}</p>
            <button type="button" className="btn adm-int-btn" disabled={cleaning} onClick={() => void cleanOrphans()}>
              {cleaning ? C.deleting : C.cleanOrphans}
            </button>
          </div>
        )}
      </Card>

      {uploading && (
        <UploadSheet
          existing={rows}
          onClose={() => setUploading(false)}
          onDone={(msg) => {
            setUploading(false)
            setFlash(msg)
            void reload()
          }}
        />
      )}
      {assetFor && (
        <AssetSheet
          row={assetFor}
          onClose={() => setAssetFor(null)}
          onDone={(msg) => {
            setAssetFor(null)
            setFlash(msg)
            void reload()
          }}
        />
      )}
      {deleting && (
        <DeleteSheet
          row={deleting}
          onClose={() => setDeleting(null)}
          onDone={(msg) => {
            setDeleting(null)
            setFlash(msg)
            void reload()
          }}
        />
      )}
    </>
  )
}

// ─── upload ────────────────────────────────────────────────────────────────────

/** Pick a template JSON, see what it is and what it will do, then write it. The file's own `id`
 *  decides the slot — matching `admin_checklists`, where the manifest entry id is the slug — so
 *  the sheet says up front whether this replaces a template or adds one. */
function UploadSheet({ existing, onClose, onDone }: {
  existing: ChecklistRow[]
  onClose: () => void
  /** `datasetId` lets the parent wait for the write to actually show up — see `reload`. */
  onDone: (message: string, datasetId: string) => void
}) {
  const C = appConfig.copy.admin.checklists
  const Cc = appConfig.copy.admin.common2
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<ParsedChecklist | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [order, setOrder] = useState('')
  const [busy, setBusy] = useState(false)

  const pick = async (f: File) => {
    setFile(f)
    setParsed(null)
    setError(null)
    const res = parseChecklistTemplate(await f.text(), C)
    if (!res.ok) { setError(res.error); return }
    setParsed(res.value)
    // Prefill the rail order: the file's own, else the next free position after what is stored.
    setOrder(String(res.value.order ?? existing.length + 1))
  }

  const replaces = parsed ? existing.find((r) => r.slug === parsed.id) : undefined
  const orderNum = Number(order.trim())
  const orderOk = order.trim() !== '' && Number.isFinite(orderNum) && Number.isInteger(orderNum) && orderNum >= 0

  const submit = async () => {
    if (!parsed || !file || !orderOk || busy) return
    setBusy(true)
    setError(null)
    try {
      await uploadChecklistFile(`checklists:${parsed.id}`, checklistUploadBlob(parsed, orderNum), file.name, {
        title: parsed.title,
        sourceNote: file.name,
      })
      onDone(fillTemplate(replaces ? C.replaced : C.added, { title: parsed.title }), `checklists:${parsed.id}`)
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : C.uploadFailed)
      setBusy(false)
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={C.uploadTitle}
      sheetClassName="adm-ck-sheet"
      footer={
        <>
          <button type="button" className="ip-btn" onClick={onClose}>{Cc.cancel}</button>
          <button type="button" className="ip-btn primary" disabled={!parsed || !orderOk || busy} onClick={() => void submit()}>
            {busy ? C.uploadingLabel : C.uploadConfirm}
          </button>
        </>
      }
    >
      <p className="adm-hint">{C.uploadHint}</p>
      <div className="adm-brand-row">
        <button type="button" className="btn adm-int-btn" onClick={() => fileRef.current?.click()}>
          {C.pickFile}
        </button>
        {file && <span className="adm-ref-note">{file.name}</span>}
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void pick(f)
          }}
        />
      </div>

      {error && <p className="adm-state adm-state-err">{error}</p>}

      {parsed && (
        <>
          <ul className="adm-ck-facts">
            <li><span>{C.factTitle}</span><strong>{parsed.title}</strong></li>
            <li><span>{C.factSlot}</span><code>checklists:{parsed.id}</code></li>
            <li><span>{C.factKind}</span><strong>{kindLabel(parsed.kind)}</strong></li>
            <li><span>{C.factSections}</span><strong>{parsed.sections}</strong></li>
          </ul>
          <p className={replaces ? 'adm-state' : 'adm-hint'}>
            {replaces
              ? fillTemplate(C.willReplace, { title: replaces.dataset.title ?? replaces.slug, v: replaces.dataset.current_version })
              : C.willCreate}
          </p>
          <Field label={C.orderLabel} hint={C.orderHint}>
            <input
              className="adm-input adm-input-mono"
              inputMode="numeric"
              value={order}
              onChange={(e) => setOrder(e.target.value)}
            />
          </Field>
        </>
      )}
    </Sheet>
  )
}

const kindLabel = (kind: 'action' | 'rapport' | 'reference'): string => {
  const C = appConfig.copy.admin.checklists
  return kind === 'action' ? C.kindAction : kind === 'rapport' ? C.kindRapport : C.kindReference
}

// ─── diagram assets ────────────────────────────────────────────────────────────

/** One page image of a reference playbook — `checklists:<slug>:p<N>`, rendered inline by the
 *  reference reader (ChecklistReference.tsx). Without this the browser could load an EL playbook
 *  whose figures are all missing. */
function AssetSheet({ row, onClose, onDone }: {
  row: ChecklistRow
  onClose: () => void
  /** `removed` flips the expectation from «is now there» to «is now gone». */
  onDone: (message: string, datasetId: string, removed?: boolean) => void
}) {
  const C = appConfig.copy.admin.checklists
  const Cc = appConfig.copy.admin.common2
  const fileRef = useRef<HTMLInputElement>(null)
  const [page, setPage] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  const pageNum = Number(page.trim())
  const pageOk = page.trim() !== '' && Number.isInteger(pageNum) && pageNum >= 0
  const datasetId = `checklists:${row.slug}:p${pageNum}`

  const submit = async () => {
    if (!file || !pageOk || busy) return
    setBusy(true)
    setError(null)
    try {
      await uploadChecklistFile(datasetId, file, file.name, { sourceNote: file.name })
      onDone(fillTemplate(C.assetAdded, { page: pageNum }), datasetId)
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : C.uploadFailed)
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    setRemoving(id)
    try {
      const res = await deleteChecklistDatasets([id])
      onDone(fillTemplate(C.deleted, { n: res.pruned.length }), id, true)
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : C.deleteFailed)
      setRemoving(null)
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={fillTemplate(C.assetTitle, { title: row.dataset.title ?? row.slug })}
      sheetClassName="adm-ck-sheet"
      footer={
        <>
          <button type="button" className="ip-btn" onClick={onClose}>{Cc.cancel}</button>
          <button type="button" className="ip-btn primary" disabled={!file || !pageOk || busy} onClick={() => void submit()}>
            {busy ? C.uploadingLabel : C.uploadConfirm}
          </button>
        </>
      }
    >
      <p className="adm-hint">{C.assetHint}</p>
      {row.assets.length > 0 && (
        <ul className="adm-ck-assets">
          {row.assets.map((a) => (
            <li key={a.id}>
              <a className="adm-link" href={`/api/reference/${encodeURIComponent(a.id)}?v=${a.current_version}`} target="_blank" rel="noreferrer">
                {a.id.slice(a.id.lastIndexOf(':') + 1)}
              </a>
              <button
                type="button"
                className="btn adm-int-btn"
                disabled={removing != null}
                onClick={() => void remove(a.id)}
              >
                {removing === a.id ? C.deleting : C.delete}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="adm-row-2">
        <Field label={C.assetPage} hint={C.assetPageHint}>
          <input
            className="adm-input adm-input-mono"
            inputMode="numeric"
            value={page}
            onChange={(e) => setPage(e.target.value)}
          />
        </Field>
        <Field label={C.assetFile}>
          <div className="adm-brand-row">
            <button type="button" className="btn adm-int-btn" onClick={() => fileRef.current?.click()}>
              {C.pickImage}
            </button>
            {file && <span className="adm-ref-note">{file.name}</span>}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) setFile(f)
              }}
            />
          </div>
        </Field>
      </div>
      {pageOk && <p className="adm-hint">{C.factSlot} <code>{datasetId}</code></p>}
      {error && <p className="adm-state adm-state-err">{error}</p>}
    </Sheet>
  )
}

// ─── delete ────────────────────────────────────────────────────────────────────

/** The explicit delete. Its own sheet rather than `window.confirm`, which an installed iOS PWA
 *  may suppress without a trace (same reason PinSheet exists). Names every id that goes. */
function DeleteSheet({ row, onClose, onDone }: {
  row: ChecklistRow
  onClose: () => void
  onDone: (message: string, datasetId: string) => void
}) {
  const C = appConfig.copy.admin.checklists
  const Cc = appConfig.copy.admin.common2
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const title = row.dataset.title ?? row.slug

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await deleteChecklistDatasets([row.dataset.id, ...row.assets.map((a) => a.id)])
      onDone(fillTemplate(C.deleted, { n: res.pruned.length }), row.dataset.id)
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : C.deleteFailed)
      setBusy(false)
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      fit
      title={C.deleteTitle}
      sheetClassName="adm-ck-sheet"
      footer={
        <>
          <button type="button" className="ip-btn" onClick={onClose}>{Cc.cancel}</button>
          <button type="button" className="ip-btn ip-btn-danger" disabled={busy} onClick={() => void submit()}>
            {busy ? C.deleting : C.delete}
          </button>
        </>
      }
    >
      <p className="adm-state">{fillTemplate(C.deleteBody, { title })}</p>
      <ul className="adm-ck-facts">
        <li><code>{row.dataset.id}</code></li>
        {row.assets.map((a) => <li key={a.id}><code>{a.id}</code></li>)}
      </ul>
      <p className="adm-hint">{C.deleteNote}</p>
      {error && <p className="adm-state adm-state-err">{error}</p>}
    </Sheet>
  )
}
