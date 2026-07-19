import { useMemo } from 'react'
import { Icon } from '../lib/icons'
import { fillTemplate } from '../lib/format'
import { appConfig } from '../config/appConfig'
import { Table } from './ui'
import type { DeploymentModule } from '../lib/deploymentConfig'
import type { ObjectWithPlans } from '../lib/incidents'

// Read-only viewer for the Objektplan module catalogue, as a TABLE: one row per configured module
// (the importer's display tiles + parsing rules) plus a coverage status against the imported
// objects — how many objects have at least one plan that resolves to that module. When the
// deployment doesn't override `modules`, the caller passes the national defaults with
// `usingDefaults`, so the in-force standard catalogue is shown (not an empty state). Editing happens
// in the station configuration via the `admin_config` CLI, NOT here — so this surface only renders.

// A plan resolves to a module by exact id, by membership in a combined module, or — for a generative
// `family` module — by the slot prefix (modul5 → modul5-wasser).
function planMatchesModule(planModule: string, m: DeploymentModule): boolean {
  if (planModule === m.id) return true
  if (m.combinedWith?.includes(planModule)) return true
  if (m.family && (planModule === m.id || planModule.startsWith(`${m.id}-`))) return true
  return false
}

export function ModulesViewer({ modules, objects, usingDefaults = false }: {
  modules: DeploymentModule[]
  objects: ObjectWithPlans[]
  usingDefaults?: boolean
}) {
  const C = appConfig.copy.admin.modules

  // a copy sorted by (order ?? 999) then id — never mutate the prop.
  const sorted = useMemo(
    () => modules.slice().sort((a, b) => ((a.order ?? 999) - (b.order ?? 999)) || a.id.localeCompare(b.id)),
    [modules],
  )

  const plans = useMemo(() => objects.reduce((n, o) => n + o.plans.length, 0), [objects])

  const columns = [
    { key: 'module', label: C.colModule },
    { key: 'orientation', label: C.orientation },
    { key: 'detection', label: C.detection },
    { key: 'props', label: C.colProps },
    { key: 'coverage', label: C.colCoverage, num: true },
  ]

  return (
    <div className="adm-view">
      <p className="adm-view-summary">
        {fillTemplate(C.summary, { modules: modules.length, objects: objects.length, plans })}
      </p>
      {usingDefaults && <p className="adm-view-note">{C.usingDefaults}</p>}

      {modules.length === 0
        ? <p className="adm-view-empty">{C.empty}</p>
        : (
          <Table columns={columns} className="adm-vtable">
            {sorted.map((m, mi) => {
              // covered = objects with at least one plan resolving to this module.
              const covered = objects.filter((o) =>
                o.plans.some((p) => p.module != null && planMatchesModule(p.module, m)),
              ).length
              const total = objects.length
              const orientation = m.orientation === 'portrait' ? C.orientationPortrait : m.orientation === 'landscape' ? C.orientationLandscape : ''
              return (
                <tr key={m.id} className={mi > 0 ? 'adm-vsep' : undefined}>
                  <td>
                    <span className="adm-vname">
                      <span className="adm-view-glyph" aria-hidden><Icon id={m.icon || 'doc'} /></span>
                      <span className="adm-view-id">
                        <span className="adm-view-name">
                          {m.code && <span className="adm-view-code">{m.code}</span>}
                          {m.title || m.id}
                        </span>
                        <span className="adm-view-key">{m.id}</span>
                      </span>
                    </span>
                  </td>
                  <td>{orientation || <span className="adm-fleet-freeval">—</span>}</td>
                  <td>{m.match ? <span className="adm-view-chip adm-view-mono adm-vregex" title={m.match}>{m.match}</span> : <span className="adm-fleet-freeval">{C.detectionNone}</span>}</td>
                  <td>
                    <span className="adm-fleet-props">
                      {m.family && <span className="adm-view-badge adm-view-badge-muted" title={C.familyHint}>{C.familyBadge}</span>}
                      {m.viewer && <span className="adm-view-badge adm-view-badge-muted" title={C.viewerHint}>{C.viewerBadge}</span>}
                      {m.combinedWith && m.combinedWith.length > 0 && m.combinedWith.map((c) => (
                        <span className="adm-view-chip" key={c}>{c}</span>
                      ))}
                      {!m.family && !m.viewer && !(m.combinedWith && m.combinedWith.length > 0) && <span className="adm-fleet-freeval">—</span>}
                    </span>
                  </td>
                  <td className="adm-num">
                    {total > 0
                      ? <span className={`adm-view-badge ${covered > 0 ? 'adm-view-badge-ok' : 'adm-view-badge-warn'}`}>{fillTemplate(C.coverage, { covered, total })}</span>
                      : <span className="adm-fleet-freeval">—</span>}
                  </td>
                </tr>
              )
            })}
          </Table>
        )}
    </div>
  )
}
