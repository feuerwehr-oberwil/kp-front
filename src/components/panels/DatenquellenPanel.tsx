import { useEffect, useState } from 'react'
import { Icon } from '../../lib/icons'
import { toast } from '../../lib/ui'
import { ApiError } from '../../lib/api'
import { fillTemplate } from '../../lib/format'
import { appConfig } from '../../config/appConfig'
import { Segmented } from '../Segmented'
import { externalMapLinks } from '../../lib/deploymentConfig'
import {
  inspectGeojson,
  listObjects,
  listReference,
  uploadReference,
  upsertReferenceLayer,
  type ObjectWithPlans,
  type ReferenceDataset,
} from '../../lib/incidents'
import { Modal, fmtWhen } from './_shared'

// --- Datenquellen (Phase 7) ---------------------------------------------------------
export function DatenquellenPanel({ isEditor, incidentCoord, onClose }: {
  isEditor: boolean
  incidentCoord: [number, number] | null
  onClose: () => void
}) {
  const ds = appConfig.copy.datenquellen
  const [refs, setRefs] = useState<ReferenceDataset[]>([])
  const [objects, setObjects] = useState<ObjectWithPlans[]>([])
  const reload = async () => {
    try { setRefs(await listReference()) } catch { /* ignore */ }
    try { setObjects(await listObjects(undefined, incidentCoord ? `${incidentCoord[0]},${incidentCoord[1]}` : undefined)) } catch { /* ignore */ }
  }
  useEffect(() => { void reload() }, [])

  const upload = async (id: string, f: File) => {
    try { await uploadReference(id, f, f.name); toast(ds.uploaded, { icon: 'check', tone: 'success' }); void reload() }
    catch (e) { toast(e instanceof ApiError ? e.detail : ds.uploadFailed, { icon: 'warn', tone: 'warn' }) }
  }

  // --- add a new GeoJSON reference layer (file → store + render config) ---
  const [addOpen, setAddOpen] = useState(false)
  const [nf, setNf] = useState<File | null>(null)
  const [nLabel, setNLabel] = useState('')
  const [nGroup, setNGroup] = useState<string>(ds.defaultGroup)
  const [nKind, setNKind] = useState<'line' | 'point'>('line')
  const [nColor, setNColor] = useState('#0f52b5')
  const [busy, setBusy] = useState(false)
  // store slug from the file name: a-z0-9 only, so the dataset id geo:<slug> is URL-clean.
  const slug = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const resetAdd = () => { setNf(null); setNLabel(''); setNGroup(ds.defaultGroup); setNKind('line'); setNColor('#0f52b5'); setAddOpen(false) }

  const addLayer = async () => {
    if (!nf || !nLabel.trim()) return
    const id = slug(nf.name)
    if (!id) { toast(ds.invalidFilename, { icon: 'warn', tone: 'warn' }); return }
    setBusy(true)
    try {
      const check = await inspectGeojson(nf)
      if (!check.ok) { toast(check.msg, { icon: 'warn', tone: 'warn' }); return }
      await uploadReference(`geo:${id}`, nf, nf.name)
      await upsertReferenceLayer({
        id, group: nGroup.trim() || ds.defaultGroup, label: nLabel.trim(), icon: 'map',
        kind: 'geojson', geojson: `/api/reference/geo:${id}`, vectorKind: nKind, color: nColor,
      })
      toast(fillTemplate(ds.layerAdded, { name: nLabel.trim() }), { icon: 'check', tone: 'success' })
      resetAdd(); void reload()
    } catch (e) {
      toast(e instanceof ApiError ? e.detail : ds.addLayerFailed, { icon: 'warn', tone: 'warn' })
    } finally { setBusy(false) }
  }

  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const matches = (o: ObjectWithPlans) =>
    !q || o.name.toLowerCase().includes(q) || (o.address ?? '').toLowerCase().includes(q)
  const filtered = objects.filter(matches)
  // With coords: split into "nearby" (≤1 km, by distance) + the rest (alphabetical). The
  // full list (155+) is collapsed by default so the panel isn't an unwieldy wall of rows.
  const near = incidentCoord
    ? filtered.filter((o) => o.distance_m != null && o.distance_m <= 400).sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0))
    : []
  const nearIds = new Set(near.map((o) => o.id))
  const rest = filtered.filter((o) => !nearIds.has(o.id)).sort((a, b) => a.name.localeCompare(b.name))
  const totalPlans = objects.reduce((n, o) => n + o.plans.length, 0)

  const ObjectRow = (o: ObjectWithPlans) => (
    <div key={o.id} className="ip-ds ip-ds-compact">
      <div className="ip-ds-main">
        <div className="ip-ds-title">{o.name}{o.distance_m != null ? <span className="ip-ds-dist"> · {Math.round(o.distance_m)} m</span> : null}</div>
        <div className="ip-ds-sub">{o.address ?? '—'}{o.plans.length ? ` · ${o.plans.map((p) => (p.module ?? '?').replace('modul', 'M')).join(' ')}` : ` · ${appConfig.copy.intake.objectNoPlans}`}</div>
      </div>
    </div>
  )

  return (
    <Modal title={ds.title} onClose={onClose} wide>
      {incidentCoord && externalMapLinks(incidentCoord[0], incidentCoord[1]).length > 0 && (
        <div className="ip-row-actions">
          {externalMapLinks(incidentCoord[0], incidentCoord[1]).map((l) => (
            <a key={l.href} className="ip-btn" href={l.href} target="_blank" rel="noreferrer">
              <Icon id="map" /> {l.label}
            </a>
          ))}
        </div>
      )}

      <details className="ip-group" open>
        <summary className="ip-group-head">{ds.globalDatasets} <span className="ip-group-count">{refs.length}</span></summary>
        {refs.map((d) => (
          <div key={d.id} className="ip-ds">
            <div className="ip-ds-main">
              <div className="ip-ds-title">{d.title ?? d.id}</div>
              <div className="ip-ds-sub">
                {d.kind}{d.feature_count != null ? ` · ${d.feature_count} ${ds.objectsCount}` : ''}
                {d.size_bytes != null ? ` · ${Math.round(d.size_bytes / 1024)} kB` : ''} · v{d.current_version} · {fmtWhen(d.updated_at)}
              </div>
              {d.source_note && <div className="ip-ds-note">{d.source_note}</div>}
            </div>
            {isEditor && (
              <label className="ip-btn ghost">
                {ds.replace}
                <input type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(d.id, f) }} />
              </label>
            )}
          </div>
        ))}
        {isEditor && !addOpen && (
          <button type="button" className="ip-btn ghost" style={{ marginTop: 6 }} onClick={() => setAddOpen(true)}>
            <Icon id="area" /> {ds.newGeoLayer}
          </button>
        )}
        {isEditor && addOpen && (
          <div className="ip-addlayer">
            <label className="ip-btn ghost">
              {nf ? nf.name : ds.chooseGeojson}
              <input type="file" accept=".geojson,.json,application/geo+json,application/json" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) { setNf(f); if (!nLabel) setNLabel(f.name.replace(/\.[^.]+$/, '')) } }} />
            </label>
            <input className="ip-search" placeholder={ds.labelPlaceholder} value={nLabel} onChange={(e) => setNLabel(e.target.value)} />
            <input className="ip-search" placeholder={ds.groupPlaceholder} value={nGroup} onChange={(e) => setNGroup(e.target.value)} />
            <div className="ip-addlayer-row">
              <Segmented<'line' | 'point'> ariaLabel={ds.kindLines} value={nKind} onChange={setNKind}
                options={[{ value: 'line', label: ds.kindLines }, { value: 'point', label: ds.kindPoints }]} />
              <input type="color" value={nColor} onChange={(e) => setNColor(e.target.value)} aria-label={ds.color} />
              <button type="button" className="ip-btn" disabled={!nf || !nLabel.trim() || busy} onClick={() => void addLayer()}>
                {busy ? ds.adding : ds.add}
              </button>
              <button type="button" className="ip-btn ghost" disabled={busy} onClick={resetAdd}>{appConfig.copy.cancel}</button>
            </div>
            <div className="ip-ds-note">{ds.geojsonNoteBefore}<code>geo:…</code>{ds.geojsonNoteAfter}</div>
          </div>
        )}
      </details>

      <div className="ip-group-head ip-objects-head">
        {ds.incidentObjects} <span className="ip-group-count">{objects.length} · {totalPlans} {ds.plansWord}</span>
      </div>
      <input
        className="ip-search"
        placeholder={appConfig.copy.intake.objectSearchPlaceholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {near.length > 0 && (
        <>
          <h4 className="ip-sub2">{fillTemplate(ds.nearby, { n: near.length })}</h4>
          {near.map(ObjectRow)}
        </>
      )}
      {/* the full list is heavy (155+) — collapsed unless searching or there are no nearby hits */}
      <details className="ip-group" open={!!q || near.length === 0}>
        <summary className="ip-group-head">
          {near.length > 0 ? ds.allOther : ds.allObjects} <span className="ip-group-count">{rest.length}</span>
        </summary>
        {rest.length === 0 && <div className="ip-ds-note" style={{ padding: '6px 2px' }}>{appConfig.copy.noSymbolMatches}</div>}
        {rest.map(ObjectRow)}
      </details>
    </Modal>
  )
}
