import type { ReactNode } from 'react'
import type { DeploymentConfig } from '../lib/deploymentConfig'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

/** What the System page has already fetched — this card adds no request of its own. */
export interface SetupFacts {
  users: number | null
  personnelActive: number | null
  heartbeatConfigured: boolean
}

interface Row {
  key: string
  done: boolean
  label: string
  sub: string
  /** the section to open; omitted where the fix is not in this UI at all (see below) */
  go?: string
}

/**
 * «Einrichtung» — what a fresh instance still needs, on the page it lands on.
 *
 * A new deployment is otherwise a set of blank forms with nothing saying which of them matter.
 * Every fact here is one the System page already holds or one line of config, so the card costs
 * no request; it disappears once there is nothing left to say.
 *
 * ⚠️ Deliberately NOT a wizard and NOT a progress bar. SETUP.md §4 already tells a station «you
 * do not owe anyone a complete inventory» — a Wehr with no vehicle list is operational, it just
 * gets no Ausrückzeiten grid. This card is the screen version of that sentence, so every row
 * names the CONSEQUENCE of leaving it undone rather than nagging, and nothing here blocks
 * anything.
 */
export function SetupChecklist({ cfg, facts, onGo }: {
  cfg: DeploymentConfig | null
  facts: SetupFacts
  onGo: (section: string) => void
}) {
  const C = appConfig.copy.admin.setup
  if (!cfg) return null

  const assets = cfg.identity?.assets
  const vehicles = cfg.fleet?.vehicles?.length ?? 0
  const center = cfg.map?.defaultView?.center

  const rows: Row[] = [
    {
      key: 'name', done: !!cfg.identity?.appName?.trim(), go: 'identitaet',
      label: C.name, sub: cfg.identity?.appName?.trim() || C.nameOpen,
    },
    {
      key: 'map', done: Array.isArray(center) && center.length === 2, go: 'identitaet',
      label: C.map,
      sub: Array.isArray(center) && center.length === 2
        ? fillTemplate(C.mapSet, { lon: String(center[0]), lat: String(center[1]) })
        : C.mapOpen,
    },
    {
      key: 'logo', done: !!assets?.logo, go: 'identitaet',
      label: C.logo, sub: assets?.logo ? C.logoSet : C.logoOpen,
    },
    {
      // A fresh deployment always has the ONE seeded account, so «>0» would tick on day zero.
      // The question this row asks is «has the Wehr put its own people in».
      key: 'users', done: (facts.users ?? 0) > 1, go: 'mitglieder',
      label: C.users,
      sub: (facts.users ?? 0) > 1 ? fillTemplate(C.usersSet, { n: facts.users ?? 0 }) : C.usersOpen,
    },
    {
      key: 'personnel', done: (facts.personnelActive ?? 0) > 0, go: 'mannschaft',
      label: C.personnel,
      sub: (facts.personnelActive ?? 0) > 0
        ? fillTemplate(C.personnelSet, { n: facts.personnelActive ?? 0 })
        : C.personnelOpen,
    },
    {
      key: 'fleet', done: vehicles > 0, go: 'fahrzeuge',
      label: C.fleet, sub: vehicles > 0 ? fillTemplate(C.fleetSet, { n: vehicles }) : C.fleetOpen,
    },
    {
      // ⚠️ NO `go`. This one lives in the environment (HEALTHCHECK_PING_URL), which a browser
      // can neither read nor set — so it is reported, not offered. A chevron here would promise
      // a screen that does not exist. It stays on the list because a station that never learns
      // its instance is down is the failure the whole ops story is about, and this page is where
      // somebody would look for it.
      key: 'monitoring', done: facts.heartbeatConfigured,
      label: C.monitoring, sub: facts.heartbeatConfigured ? C.monitoringSet : C.monitoringOpen,
    },
  ]

  const open = rows.filter((r) => !r.done)
  if (open.length === 0) return null

  const body = (r: Row): ReactNode => (
    <>
      <span className={`adm-setup-dot${r.done ? ' done' : ''}`} aria-hidden>{r.done ? '✓' : '–'}</span>
      <span className="adm-setup-txt">
        <span className="adm-setup-lbl">{r.label}</span>
        <span className="adm-setup-sub">{r.sub}</span>
      </span>
      {r.go && <span className="adm-setup-go" aria-hidden>›</span>}
    </>
  )

  return (
    <section className="adm-card">
      <header className="adm-card-head">
        <h2 className="adm-card-title">
          {fillTemplate(C.title, { done: rows.length - open.length, n: rows.length })}
        </h2>
        <p className="adm-card-cap">{C.caption}</p>
      </header>
      <div className="adm-card-body">
        <div className="adm-setup">
          {rows.map((r) => (r.go
            ? (
              <button type="button" className="adm-setup-row" key={r.key} onClick={() => onGo(r.go!)}>
                {body(r)}
              </button>
            )
            : <div className="adm-setup-row is-static" key={r.key}>{body(r)}</div>
          ))}
        </div>
      </div>
    </section>
  )
}
