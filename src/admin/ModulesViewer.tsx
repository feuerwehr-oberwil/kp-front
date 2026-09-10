import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import { fillTemplate } from '../lib/format'
import { appConfig } from '../config/appConfig'
import { apiGet } from '../lib/api'
import { Table } from './ui'
import { InfoTip } from './InfoTip'
import type { DeploymentModule } from '../lib/deploymentConfig'
import type { ObjectWithPlans } from '../lib/incidents'

// Read-only viewer for the Objektplan module catalogue, as a TABLE: one row per configured module
// (the importer's display tiles + parsing rules) plus a coverage status against the imported
// objects — how many objects have at least one plan that resolves to that module. When the
// deployment doesn't override `modules`, the caller passes the national defaults with
// `usingDefaults`, so the in-force standard catalogue is shown (not an empty state). Editing happens
// in the station configuration via the `admin_config` CLI, NOT here — so this surface only renders.
//
// It also carries the page's first line: through which DOOR plans arrive here. Three exist —
// the upload in the Objekt-Maske, the Planspeicher (PLANS_S3_*) and, since 09.2026, SharePoint —
// and none of them announces itself, so a station could not tell an automatic plan from a
// hand-uploaded one, nor whether an automatic one is coming at all. The counted strip is what
// the plans SAY (`source_type`); the note under it is what the deployment is CONFIGURED for
// (`usePlanSources`), pointing at the pages that own that configuration instead of restating
// their status.

// ─── how plans arrive: the doors, and which of them are open ───────────────────

/** The scheduled pulls this deployment has (`GET /api/objects/plan-sources`). Not a status —
 *  what the last run DID is the System page's SharePoint card; this is only «läuft überhaupt
 *  einer». */
export interface PlanSources {
  /** the PLANS_S3_* Planspeicher, which matches objects on `source_key` and nothing else */
  bucket: boolean
  /** the SharePoint connector, and only when it has a `plans` folder */
  sharepoint: boolean
}

/**
 * The connector state behind this page's first line, or null while it is unknown.
 *
 * ⚠️ Null covers BOTH «not answered yet» and «could not ask», and every caller stays silent on
 * it rather than guessing. Both guesses are ones an operator acts on: «kein Abgleich» invites a
 * hand upload that the next run overwrites, «Abgleich läuft» invites waiting for a plan that
 * will never arrive.
 */
export function usePlanSources(): PlanSources | null {
  const [sources, setSources] = useState<PlanSources | null>(null)
  useEffect(() => {
    let alive = true
    void apiGet<PlanSources>('/api/objects/plan-sources')
      .then((s) => { if (alive) setSources(s) })
      .catch(() => { /* the page is complete without the line — see above */ })
    return () => { alive = false }
  }, [])
  return sources
}

/**
 * How a stored plan got here, as a badge label plus the sentence behind it.
 *
 * `source_type` is the door the bytes came through (backend/app/plans.py · store_plan):
 * 'uploaded' by hand in the Objekt-Maske, 'snapshot' from the Planspeicher, 'sharepoint' from
 * the connector. Anything else is shown VERBATIM instead of being folded into «unbekannt» — an
 * unnamed door is still a fact, and the raw word is what the backend can be grepped for.
 */
export function planSourceLabel(sourceType: string): { label: string; tip?: string } {
  const C = appConfig.copy.admin.objects
  if (sourceType === 'uploaded') return { label: C.srcHand, tip: C.srcHandTip }
  if (sourceType === 'snapshot') return { label: C.srcBucket, tip: C.srcBucketTip }
  if (sourceType === 'sharepoint') return { label: C.srcSharepoint, tip: C.srcSharepointTip }
  return { label: sourceType }
}

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
  const CO = appConfig.copy.admin.objects
  const sources = usePlanSources()

  // a copy sorted by (order ?? 999) then id — never mutate the prop.
  const sorted = useMemo(
    () => modules.slice().sort((a, b) => ((a.order ?? 999) - (b.order ?? 999)) || a.id.localeCompare(b.id)),
    [modules],
  )

  const plans = useMemo(() => objects.reduce((n, o) => n + o.plans.length, 0), [objects])

  // How many plans came through each door. Counted from the plans themselves, so this strip is
  // an observation — the connector line below it is the configuration claim, and the two can
  // legitimately disagree (a pull switched on today has imported nothing yet).
  const bySource = useMemo(() => {
    const counts = new Map<string, number>()
    for (const o of objects) for (const p of o.plans) counts.set(p.source_type, (counts.get(p.source_type) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [objects])

  // Objects the Planspeicher-Abgleich cannot reach: it matches index rows on `source_key`, and
  // one typed into the Objekt-Maske has none — so it is skipped on every run, silently.
  const keyless = useMemo(() => objects.filter((o) => !o.source_key).length, [objects])
  const pulling = sources != null && (sources.bucket || sources.sharepoint)
  const pullNames = !sources ? '' : sources.bucket && sources.sharepoint
    ? fillTemplate(C.pullAnd, { a: CO.srcBucket, b: CO.srcSharepoint })
    : sources.bucket ? CO.srcBucket : CO.srcSharepoint

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

      {bySource.length > 0 && (
        <div className="adm-fleet-props">
          {bySource.map(([type, n]) => {
            const s = planSourceLabel(type)
            return (
              <span key={type} className="adm-fleet-badge adm-view-badge-muted" title={s.tip}>
                {fillTemplate(C.sourceTally, { n, label: s.label })}
              </span>
            )
          })}
        </div>
      )}

      {/* Renders only once the answer is in: an unanswered `/plan-sources` must not become
          «kein Abgleich», which is the sentence that invites a hand upload the next run eats.
          Inline is the STATE and where it is configured — one sentence. Why «kein Abgleich» is
          the normal case, and what the last run did, is the ⓘ. */}
      {sources && (
        <p className="adm-view-note">
          {pulling && <><span className="adm-view-badge adm-view-badge-ok">{pullNames}</span>{' '}</>}
          {pulling ? C.pullOn : C.pullOff}
          <InfoTip label={pulling ? C.pullOn : C.pullOff} text={pulling ? C.pullOnTip : C.pullOffTip} />
          {sources.bucket && keyless > 0 && ` ${fillTemplate(C.pullSkips, { n: keyless, total: objects.length })}`}
        </p>
      )}

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
