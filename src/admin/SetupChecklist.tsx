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

/** A row somebody can actually tick: it counts towards «x von n» and keeps the card up. */
interface Row {
  key: string
  done: boolean
  label: string
  sub: string
  /** the section this row opens */
  go: string
}

/**
 * «Einrichtung» — what a fresh instance still needs, on the page it lands on.
 *
 * A new deployment is otherwise a set of blank forms with nothing saying which of them matter.
 * Every fact here is one the System page already holds or one line of config, so the card costs
 * no request; it disappears once there is nothing left for this UI to offer.
 *
 * ⚠️ Deliberately NOT a wizard and NOT a progress bar. SETUP.md §4 already tells a station «you
 * do not owe anyone a complete inventory» — a Wehr with no vehicle list is operational, it just
 * gets no Ausrückzeiten grid. This card is the screen version of that sentence, so every row
 * names the CONSEQUENCE of leaving it undone rather than nagging, and nothing here blocks
 * anything.
 *
 * ⚠️ Every line here is a ROW, and the rule behind that is: this card only ever lists things
 * this UI can finish. «Überwachung» used to be the exception — HEALTHCHECK_PING_URL was
 * env-only, so it was reported without a chevron and kept out of the «x von n» count, because
 * a row nobody could tick would have parked the card at «6 von 7» on the admin's landing page
 * forever. That is no longer true: the ping URL is one of the sixteen credentials
 * «Zugangsdaten» sets (backend/app/credentials.py), so it is now finishable in two taps like
 * every other row and counts like every other row. The exception, and the `Note` type that
 * existed for it, are gone — if a future line genuinely cannot be finished from a browser, it
 * does not belong on this card at all.
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
  // ⚠️ A centre can be stored in EITHER CRS, and they are mutually exclusive
  // (schemas.py · MapDefaultView._one_crs): picking LV95 in the Station form writes
  // `centerLv95` and NULLs `center`. Ticking on `center` alone therefore left every LV95
  // station — i.e. the Swiss default this product is built for — with a row it could never
  // finish, parking the card on the admin's landing page forever. That is the exact failure
  // this card's own «only ever lists things this UI can finish» rule exists to prevent.
  const pair = (v: unknown): [number, number] | null =>
    Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number') ? (v as [number, number]) : null
  const centre = pair(cfg.map?.defaultView?.center) ?? pair(cfg.map?.defaultView?.centerLv95)
  // Either field biases the address search; neither is required for the other to work.
  const geo = cfg.map?.geocoder
  const geocoderBiased = !!geo?.defaultLocality?.trim() || !!geo?.bboxLv95?.trim()

  const rows: Row[] = [
    {
      key: 'name', done: !!cfg.identity?.appName?.trim(), go: 'identitaet',
      label: C.name, sub: cfg.identity?.appName?.trim() || C.nameOpen,
    },
    {
      key: 'map', done: !!centre, go: 'identitaet',
      label: C.map,
      sub: centre ? fillTemplate(C.mapSet, { lon: String(centre[0]), lat: String(centre[1]) }) : C.mapOpen,
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
      // A Wehr can tick every other row and still be offered «Hauptstrasse 3» from a village
      // three cantons away when it opens an incident — the two geocoder fields were CLI-only
      // until recently and appear on no landing page at all. Done on EITHER of them: the
      // locality alone already keeps the search at home (geocode.py · _resolve_bias), and a row
      // that demands both would stay open on a station that is in fact biased correctly.
      key: 'geocoder', done: geocoderBiased, go: 'identitaet',
      label: C.geocoder, sub: geocoderBiased ? C.geocoderSet : C.geocoderOpen,
    },
    {
      // A station that never learns its instance is down is the failure the whole ops story is
      // about — and «Zugangsdaten» is now a screen that fixes it, so this row leads there
      // rather than naming an environment variable nobody at a tablet can reach.
      // `heartbeatConfigured` is /api/system's boolean and already reads through the credential
      // layer, so a value set in .env ticks this row exactly like one set in the browser.
      key: 'monitoring', done: facts.heartbeatConfigured, go: 'zugaenge',
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
      <span className="adm-setup-go" aria-hidden>›</span>
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
          {rows.map((r) => (
            <button type="button" className="adm-setup-row" key={r.key} onClick={() => onGo(r.go)}>
              {body(r)}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
