import type { ReactNode } from 'react'
import type { DeploymentConfig } from '../lib/deploymentConfig'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { useConfig } from './ConfigContext'

/** What the System page has already fetched — this card adds no request of its own. */
export interface SetupFacts {
  users: number | null
  personnelActive: number | null
  heartbeatConfigured: boolean
  /** `credentials && configured` from `GET /api/sharepoint/status` — the one fact that decides
   *  whether the connector can do anything at all (SystemView · SharePointCard reads the same
   *  status for its own card, one fetch shared by both). */
  sharepointConfigured: boolean
}

/** A row somebody can actually tick: it counts towards «x von n» and keeps the card up. */
interface Row {
  key: string
  /** what the config/facts SAY — before any manual acknowledgement is folded in */
  done: boolean
  label: string
  sub: string
  /** the section this row opens */
  go: string
}

/**
 * Where a hand-ticked row is remembered: in the deployment config, beside everything else the
 * station decides — «erledigt» is a statement about the Wehr, not a preference of the tablet it
 * was tapped on, so the next admin on the next device has to see it.
 *
 * ⚠️ It only survives a save because `setup` is DECLARED on both sides — `SetupConfig` in
 * backend/app/schemas.py and `DeploymentConfig.setup` in src/lib/deploymentConfig.ts. Every
 * model in that document is `extra="ignore"`, so an undeclared section is dropped on the next
 * round-trip, exactly as the SharePoint block warns.
 */
const ACK_PATH = ['setup', 'acknowledged']

/** The rows this station has ticked by hand. Tolerates anything the stored document holds. */
function acknowledgedKeys(cfg: DeploymentConfig): string[] {
  const raw = cfg.setup?.acknowledged
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []
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
 *
 * ⚠️ The rule holds; what it could not cover is a row whose FACT this UI cannot observe.
 * «Fahrzeuge» is that row: a station happy with the built-in catalogue never writes
 * `fleet.vehicles`, so the derived tick could never fire and the card parked at «7 von 8»
 * forever — the same failure, from the other direction. Hence the second control on every row:
 * «Abhaken» acknowledges a row by hand, an acknowledged row counts as done, and the
 * acknowledgement is stored in the config (`ACK_PATH`), not on the device. Derived ticks are
 * unchanged — the hand tick is an escape hatch, never the normal way to finish a row.
 */
export function SetupChecklist({ cfg, facts, onGo }: {
  cfg: DeploymentConfig | null
  facts: SetupFacts
  onGo: (section: string) => void
}) {
  const C = appConfig.copy.admin.setup
  // The same writer «Verwaltung» uses everywhere: `set` edits the draft, the provider autosaves
  // the WHOLE document under its If-Match token (ConfigContext · persist).
  const { set } = useConfig()
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
      // ⚠️ Reads the DEPLOYMENT config only, and the built-in vehicle catalogue never writes
      // there: a station happy with the shipped Fahrzeuge keeps `fleet.vehicles = []` forever
      // and this row could never tick on its own. That is what «Abhaken» is for — see the
      // escape hatch in the card's doc comment.
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
      // Credentials alone are a silent no-op (scheduler.py never has a folder to poll), and a
      // folder alone cannot exist without credentials to read it with — so the row only ticks
      // once BOTH halves are true, same rule `sharepoint_status` (backend) already applies to
      // `configured`. It leads to «Zugangsdaten», not the config file: that is the half of the
      // setup this UI can actually offer a button for.
      key: 'sharepoint', done: facts.sharepointConfigured, go: 'zugaenge',
      label: C.sharepoint, sub: facts.sharepointConfigured ? C.sharepointSet : C.sharepointOpen,
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

  // Fold the hand ticks in: an acknowledged row counts as done and says so, unless the derived
  // state already had something better to say.
  const acked = acknowledgedKeys(cfg)
  const shown = rows.map((r) => ({
    ...r,
    acked: acked.includes(r.key),
    done: r.done || acked.includes(r.key),
    sub: !r.done && acked.includes(r.key) ? C.ackSub : r.sub,
  }))

  const open = shown.filter((r) => !r.done)
  if (open.length === 0) return null

  const toggleAck = (key: string) => {
    set(ACK_PATH, acked.includes(key) ? acked.filter((k) => k !== key) : [...acked, key])
  }

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
          {/* Two SIBLING controls per row: «dorthin» and «abhaken». One button inside another is
              invalid HTML and, on iOS, a tap target that answers the wrong question. */}
          {shown.map((r) => (
            <div className="adm-setup-item" key={r.key}>
              <button type="button" className="adm-setup-row" onClick={() => onGo(r.go)}>
                {body(r)}
              </button>
              {/* A row that is done on its own facts has nothing to acknowledge — only an open
                  row, and one already ticked by hand, carry the control. */}
              {(!r.done || r.acked) && (
                <button
                  type="button"
                  className="btn adm-int-btn adm-setup-ack"
                  aria-pressed={r.acked}
                  onClick={() => toggleAck(r.key)}
                >
                  {r.acked ? C.ackUndo : C.ackDo}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
