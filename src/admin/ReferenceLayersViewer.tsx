import { useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import { useSymbols } from '../lib/useSymbols'
import { fillTemplate } from '../lib/format'
import { appConfig } from '../config/appConfig'
import { Table, fmtDate } from './ui'
import type { DeploymentReferenceLayer } from '../lib/deploymentConfig'
import type { ReferenceDataset } from '../lib/incidents'

// Read-only viewer for the deployment's reference map layers ("Kartenebenen"), as a TABLE grouped
// by layer group: a search box, one row per layer, no edit controls. Each layer carries a STATUS
// derived from how it is sourced — a GeoJSON layer backed by an uploaded dataset is «Geladen» (with
// feature count + freshness), one whose dataset is absent is «Nicht geladen», and a WMS/WMTS/tile/
// external-URL layer is an «Externe Quelle». Editing happens in the station data via the
// `admin_geodata` CLI (GeoJSON + manifest), NOT here — so this surface only renders, never mutates.

// Pull a `geo:<slug>` dataset id out of a reference URL (e.g. '/api/reference/geo:hydrant').
function datasetIdOf(url: string): string | null {
  return url.match(/geo:[A-Za-z0-9_-]+/)?.[0] ?? null
}

// Human-readable byte size for the loaded-dataset hint (no copy key — a bare unit suffix).
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

type Status = 'loaded' | 'missing' | 'external'

interface Resolved {
  status: Status
  ds?: ReferenceDataset // the backing dataset when status === 'loaded'
}

// Resolve a layer's status against the uploaded datasets. GeoJSON layers point at a `geo:<slug>`
// dataset (loaded ⇄ missing) or at a plain https URL (external); WMS/WMTS/tile layers are external.
function resolveStatus(layer: DeploymentReferenceLayer, datasets: ReferenceDataset[]): Resolved {
  const url = typeof layer.geojson === 'string' ? layer.geojson : ''
  const asGeojson = (): Resolved => {
    const id = datasetIdOf(url)
    if (!id) return { status: 'external' } // external https GeoJSON, not an uploaded dataset
    const ds = datasets.find((d) => d.id === id)
    return ds ? { status: 'loaded', ds } : { status: 'missing' }
  }
  if (layer.kind === 'geojson') return asGeojson()
  if (layer.kind === 'wms' || layer.kind === 'wmts') return { status: 'external' }
  // no explicit kind: tiles ⇒ external, a geojson string ⇒ resolve as geojson, otherwise missing.
  if (layer.tiles && layer.tiles.length > 0) return { status: 'external' }
  if (url) return asGeojson()
  return { status: 'missing' }
}

const STATUS_CLS: Record<Status, string> = { loaded: 'ok', missing: 'warn', external: 'muted' }

export function ReferenceLayersViewer({
  layers,
  datasets,
}: {
  layers: DeploymentReferenceLayer[]
  datasets: ReferenceDataset[]
}) {
  const sym = useSymbols()
  const C = appConfig.copy.admin.layers
  const [filter, setFilter] = useState('')

  // group the layers by `group` in encounter order, narrowed by the search box (label/id/group).
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const out: { group: string; layers: DeploymentReferenceLayer[] }[] = []
    const at: Record<string, number> = {}
    for (const l of layers) {
      const hay = `${l.label ?? ''} ${l.id ?? ''} ${l.group ?? ''}`.toLowerCase()
      if (q && !hay.includes(q)) continue
      const g = l.group || '—'
      if (!(g in at)) { at[g] = out.length; out.push({ group: g, layers: [] }) }
      out[at[g]].layers.push(l)
    }
    return out
  }, [layers, filter])

  // headline counts across ALL layers (not just the filtered subset).
  const counts = useMemo(() => {
    let loaded = 0, missing = 0, external = 0
    for (const l of layers) {
      const s = resolveStatus(l, datasets).status
      if (s === 'loaded') loaded++
      else if (s === 'missing') missing++
      else external++
    }
    return { total: layers.length, loaded, missing, external }
  }, [layers, datasets])

  if (layers.length === 0) {
    return (
      <div className="adm-view">
        <p className="adm-view-empty">{C.empty}</p>
      </div>
    )
  }

  const columns = [
    { key: 'layer', label: C.colLayer },
    { key: 'type', label: C.colType },
    { key: 'status', label: C.colStatus },
    { key: 'render', label: C.colRender },
    { key: 'source', label: C.source },
  ]

  return (
    <div className="adm-view">
      <p className="adm-view-summary">{fillTemplate(C.summary, counts)}</p>
      <input
        className="adm-input adm-view-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={C.filterPlaceholder}
        aria-label={C.filterPlaceholder}
      />

      {groups.length === 0 && <p className="adm-view-empty">{C.noMatches}</p>}

      {groups.map((g) => (
        <section className="adm-view-cat" key={g.group}>
          <h4 className="adm-view-catname">{g.group}</h4>
          <Table columns={columns} className="adm-vtable adm-ltable">
            {g.layers.map((l, li) => {
              const { status, ds } = resolveStatus(l, datasets)
              const glyph = l.symbol ? sym.byName[l.symbol] : undefined
              const statusText = status === 'loaded' ? C.statusLoaded : status === 'missing' ? C.statusMissing : C.statusExternal
              const source = typeof l.geojson === 'string' ? l.geojson : (l.tiles?.[0] ?? '')
              const geometry = l.vectorKind === 'point' ? C.geometryPoint : l.vectorKind === 'line' ? C.geometryLine : ''
              // compact Darstellung facts on one faint line: geometry · opacity · max-zoom
              const render = [
                geometry || null,
                l.opacity != null ? `${l.opacity}%` : null,
                l.maxzoom != null ? fillTemplate(C.maxZoomVal, { n: l.maxzoom }) : null,
              ].filter((x): x is string => !!x)
              return (
                <tr key={l.id ?? l.label} className={li > 0 ? 'adm-vsep' : undefined}>
                  <td>
                    <span className="adm-vname">
                      <span className="adm-view-glyph" aria-hidden>
                        {glyph ? <span dangerouslySetInnerHTML={{ __html: glyph }} /> : <Icon id="layers" />}
                      </span>
                      <span className="adm-view-id">
                        <span className="adm-view-name">{l.label || l.id}</span>
                        <span className="adm-view-key">{l.id}</span>
                      </span>
                    </span>
                  </td>
                  <td><span className="adm-view-badge adm-view-badge-muted">{(l.kind || '').toUpperCase()}</span></td>
                  <td>
                    <span className="adm-vline">
                      <span className={`adm-view-badge adm-view-badge-${STATUS_CLS[status]}`}>{statusText}</span>
                      {ds && <span className="adm-vfacts">{[
                        ds.feature_count != null ? fillTemplate(C.features, { n: ds.feature_count }) : null,
                        ds.size_bytes != null ? fmtBytes(ds.size_bytes) : null,
                        fillTemplate(C.updated, { date: fmtDate(ds.updated_at) }),
                      ].filter(Boolean).join(' · ')}</span>}
                    </span>
                  </td>
                  <td>
                    <span className="adm-vline">
                      {render.length > 0 && <span className="adm-vfacts">{render.join(' · ')}</span>}
                      {(l.color || l.nightColor) && (
                        <span className="adm-swatches">
                          {l.color && <span className="adm-swatch2" style={{ background: l.color }} title={`${C.colorDay}: ${l.color}`} />}
                          {l.nightColor && <span className="adm-swatch2" style={{ background: l.nightColor }} title={`${C.colorNight}: ${l.nightColor}`} />}
                        </span>
                      )}
                      {render.length === 0 && !l.color && !l.nightColor && <span className="adm-fleet-freeval">—</span>}
                    </span>
                  </td>
                  <td className="adm-vsource">
                    {source
                      ? <span className="adm-view-mono">{source}</span>
                      : <span className="adm-fleet-freeval">—</span>}
                    {l.attribution && <span className="adm-view-attr">{l.attribution}</span>}
                  </td>
                </tr>
              )
            })}
          </Table>
        </section>
      ))}
    </div>
  )
}
