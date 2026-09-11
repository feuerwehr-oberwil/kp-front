import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../lib/api'
import { Sheet } from '../lib/overlays'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { downloadBlob } from '../lib/download'
import genericAction from '../data/checklists/generic-action.json'
import genericReference from '../data/checklists/generic-reference.json'
import type { ReferenceDataset } from '../lib/incidents'
import { Card, EmptyState, Field, Table, fmtDate } from './ui'
import { PlanSourceBadge } from './ObjectSheet'
import {
  checklistSlug,
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

/**
 * Hand the operator something to start from — one file per SHAPE a template can have.
 *
 * ⚠️ Both are bundled app data, not examples written for this page: `generic-action.json` is the
 * very template the Checkliste tab falls back to when a station has none (lib/checklists ·
 * FALLBACK), and `generic-reference.json` is the same thing for the other kind — a Merkblatt,
 * read and never ticked. What you download is therefore literally what you are replacing, and no
 * second shape can drift away from the one the field app reads. Same rule as the symbol pack.
 *
 * ⚠️ Two files, because `kind` is not a detail an operator can guess: an action template carries
 * `phases[].items[]` and a reference one `entries[].content[]`, and somebody who downloads the
 * tick-list to write a Merkblatt learns that only from the upload's refusal.
 */
function downloadExample(kind: 'action' | 'reference'): void {
  const doc = kind === 'action' ? genericAction : genericReference
  downloadBlob(
    new Blob([`${JSON.stringify(doc, null, 2)}\n`], { type: 'application/json' }),
    `checklisten-vorlage-${kind === 'action' ? 'aufgaben' : 'nachschlagen'}.json`,
  )
}

/**
 * What kind of FILE a checklist dataset holds.
 *
 * ⚠️ Not `dataset.kind`: every `checklists:*` row carries the constant 'checklists' (backend/
 * app/api/reference.py · replace_reference), so the content type is the only thing that tells a
 * JSON template from a PNG diagram — which is exactly the «some PDFs, some other random things»
 * question the table has to answer.
 */
const fileTypeLabel = (ds: ReferenceDataset): string => {
  const type = (ds.content_type ?? '').split(';')[0].trim().toLowerCase()
  if (!type) return ds.kind.toUpperCase()
  if (type.includes('json')) return 'JSON'
  return (type.split('/')[1] ?? type).split('+')[0].toUpperCase()
}

/** `checklists:el-playbook:p12` → «12»; anything that is not a p-number is shown verbatim. */
const assetPage = (datasetId: string): string => {
  const seg = datasetId.slice(datasetId.lastIndexOf(':') + 1)
  return /^p\d+$/.test(seg) ? seg.slice(1) : seg
}

/** The Checklisten page: the stored templates, an upload, and the delete the prune door makes
 *  possible. The table sorts by slug (stable without fetching every template); the field app
 *  sorts by the `order` stamped into each document. */
export function ChecklistsView() {
  const C = appConfig.copy.admin.checklists
  // «Typ» / «Quelle» are the Geodaten table's own headers — the same two columns over the same
  // registry, so they share the wording instead of getting a second pair of keys.
  const Cd = appConfig.copy.admin.data
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
      {/* ONE card, so the page has one head and the ⓘ of the page title carries the prune rule.
          The two examples come FIRST and the upload last: «Vorlage hochladen» on an empty page
          asks for a file format nobody has ever seen, and the two downloads are the two shapes
          that format has — a tick-list and a Merkblatt. The prune semantics live in the delete
          dialog, which is where they are a decision, and the manifest walkthrough in the docs. */}
      <Card
        action={(
          <>
            <button type="button" className="btn adm-int-btn" onClick={() => downloadExample('action')}>
              {fillTemplate(C.exampleDownloadKind, { kind: C.kindAction })}
            </button>
            <button type="button" className="btn adm-int-btn" onClick={() => downloadExample('reference')}>
              {fillTemplate(C.exampleDownloadKind, { kind: C.kindReference })}
            </button>
            <button type="button" className="btn adm-save-btn" onClick={() => setUploading(true)}>
              {C.upload}
            </button>
          </>
        )}
      >
        <p className="adm-hint">{C.intro}</p>
        {flash && <p className="adm-save-ok">{flash}</p>}
        {state.kind === 'loading' && <EmptyState message={C.loading} />}
        {state.kind === 'error' && <EmptyState tone="err" message={C.loadError} />}
        {state.kind === 'ok' && rows.length === 0 && <EmptyState message={C.none} hint={C.noneHint} />}
        {/* Typ und Quelle mirror the Geodaten table (DataView · GeodataView), down to the
            column names — the same two facts, asked of the same registry. */}
        {state.kind === 'ok' && rows.length > 0 && (
          <Table
            columns={[
              { key: 'title', label: C.colTitle },
              { key: 'kind', label: C.colSlug },
              { key: 'type', label: Cd.colType },
              { key: 'ver', label: C.colVersion },
              { key: 'date', label: C.colUpdated },
              { key: 'assets', label: C.colAssets, num: true },
              { key: 'src', label: Cd.colSource },
              { key: 'act', label: C.colActions },
            ]}
          >
            {rows.map((row) => (
              <tr key={row.dataset.id}>
                <td>
                  <span className="adm-ref-title">{row.dataset.title ?? row.slug}</span>
                </td>
                <td><code className="adm-view-key">{row.slug}</code></td>
                <td><span className="adm-ref-kind">{fileTypeLabel(row.dataset)}</span></td>
                <td className="adm-mono">v{row.dataset.current_version}</td>
                <td>{fmtDate(row.dataset.updated_at)}</td>
                <td className="adm-num adm-mono">
                  {row.assets.length || <span className="adm-fleet-freeval">—</span>}
                </td>
                <td>
                  <PlanSourceBadge sourceType={row.dataset.source_type} />
                  {row.dataset.source_note && <span className="adm-ref-note">{row.dataset.source_note}</span>}
                </td>
                {/* Deliberately NOT the shared `ActionMenu`: two actions do not need a menu.
                    (The stacking bug that ALSO argued against it — the popup painting behind
                    `.adm` on v0.6.0 — is fixed; see `.ui-menu-pos` in lib/overlays/Menu.) */}
                <td className="adm-ck-actions">
                  {/* The flex row is this inner box, never the `<td>` itself: `display: flex`
                      on a table-cell takes it out of the table box tree and the row wraps it
                      in an anonymous cell, which drifts out of the column alignment. */}
                  <div className="adm-ck-actbar">
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
                  </div>
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
            {/* Labelled, not a bare id dump: which template each ghost was filed under, which
                page it is and what kind of file — the three facts that make «Reste löschen» a
                decision rather than a leap. */}
            <ul className="adm-ck-facts">
              {orphanAssets.map((a) => (
                <li key={a.id}>
                  <span>{checklistSlug(a.id) ?? a.id}</span>
                  <strong>{C.assetPage} {assetPage(a.id)}</strong>
                  <span className="adm-ref-kind">{fileTypeLabel(a)}</span>
                  <code>{a.id}</code>
                </li>
              ))}
            </ul>
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
      fit
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
      fit
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
