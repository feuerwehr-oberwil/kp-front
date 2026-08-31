import { appConfig } from '../config/appConfig'
import { useConfig, getPath } from './ConfigContext'
import type { DeploymentMittelItem, DeploymentMittelSource } from '../lib/deploymentConfig'
import { Card, EmptyState, Table } from './ui'

// Verwaltung › Station › Material — the station's Mittel catalogue, READ-ONLY.
//
// ⚠️ This page deliberately edits nothing. Catalogue, sources and stock levels are written by
// exactly one surface — the Arbeitsmappe (StationWorkbookView · sheets «Mittel», «Quellen»,
// «Mittel-Bestände»), which parses the file SERVER-side and shows what an import would change
// before it writes. A second editor here would be a second write path into `mittel.*` with none
// of that, so the entry offers what was actually missing: a way to SEE the catalogue.
//
// Missing was the honest word. The catalogue is empty on a fresh instance, it appears in no
// admin surface, and the only hint it exists at all is a sheet name inside a spreadsheet nobody
// has downloaded yet. A station could run for a year with «kein Material» in every Rapport and
// never learn why.

/** «TLF 31: 4 · Depot: 12» — where the nominal load-out of one material lives. */
function stockLine(item: DeploymentMittelItem, sources: DeploymentMittelSource[]): string | null {
  const rows = item.stock ?? []
  if (rows.length === 0) return null
  const label = (id: string) => sources.find((s) => s.id === id)?.label ?? id
  return rows.map((s) => `${label(s.source)}: ${s.qty}`).join(' · ')
}

export function MaterialView({ onNavigate }: { onNavigate?: (id: string) => void } = {}) {
  const { draft } = useConfig()
  const C = appConfig.copy.admin.material
  // Array.isArray, not `?? []`: the document can be written straight into the DB by the
  // `admin_config` CLI, and a hand-edited `mittel.catalogue: {}` must not white-screen the page.
  const rawItems = getPath<unknown>(draft, ['mittel', 'catalogue'])
  const rawSources = getPath<unknown>(draft, ['mittel', 'sources'])
  const rawUnits = getPath<unknown>(draft, ['mittel', 'units'])
  const items: DeploymentMittelItem[] = Array.isArray(rawItems) ? rawItems : []
  const sources: DeploymentMittelSource[] = Array.isArray(rawSources) ? rawSources : []
  const units: string[] = Array.isArray(rawUnits) ? rawUnits.filter((u): u is string => typeof u === 'string') : []

  const goWorkbook = onNavigate && (
    <button type="button" className="btn adm-int-btn" onClick={() => onNavigate('arbeitsmappe')}>
      {C.openWorkbook}
    </button>
  )

  return (
    <>
      <Card title={C.catalogueTitle}>
        <p className="adm-hint">{C.editNote}</p>
        {items.length === 0 ? (
          <EmptyState message={C.empty} hint={C.emptyHint} action={goWorkbook} />
        ) : (
          <>
            <Table
              columns={[
                { key: 'label', label: C.colLabel },
                { key: 'cat', label: C.colCategory },
                { key: 'unit', label: C.colUnit },
                { key: 'kind', label: C.colKind },
                { key: 'stock', label: C.colStock },
              ]}
            >
              {items.map((m) => {
                const stock = stockLine(m, sources)
                return (
                  <tr key={m.id}>
                    <td>
                      <span className="adm-ref-title">{m.label}</span>
                      <span className="adm-ref-id">{m.id}</span>
                    </td>
                    <td>{m.category || <span className="adm-int-muted">—</span>}</td>
                    <td className="adm-mono">{m.unit || <span className="adm-int-muted">—</span>}</td>
                    <td>{m.verbrauchbar ? C.kindConsumable : C.kindEquipment}</td>
                    <td>{stock ?? <span className="adm-int-muted">{C.stockNone}</span>}</td>
                  </tr>
                )
              })}
            </Table>
            <div className="adm-actions">{goWorkbook}</div>
          </>
        )}
      </Card>

      <Card title={C.sourcesTitle}>
        {sources.length === 0
          ? <p className="adm-hint">{C.sourcesEmpty}</p>
          : (
            <div className="adm-view-chips">
              {sources.map((s) => <span className="adm-view-chip" key={s.id}>{s.label || s.id}</span>)}
            </div>
          )}
      </Card>

      <Card title={C.unitsTitle}>
        {units.length === 0
          ? <p className="adm-hint">{C.unitsEmpty}</p>
          : (
            <div className="adm-view-chips">
              {units.map((u) => <span className="adm-view-chip" key={u}>{u}</span>)}
            </div>
          )}
      </Card>
    </>
  )
}
