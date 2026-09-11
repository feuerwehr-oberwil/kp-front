import type { ReactNode } from 'react'
import type { DeploymentConfig } from '../lib/deploymentConfig'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { useConfig } from './ConfigContext'

/** The `setup` block of `GET /api/system` — the station's own answer to «what is still open»,
 *  derived server-side (backend · api/system · `_setup`). Row ids are a CONTRACT with
 *  `SETUP_ROWS` there; an id this build does not know is simply not rendered. */
export interface SetupState {
  rows: { id: string; done: boolean }[]
  acknowledged: string[]
  complete: boolean
}

/** The numbers the SUB lines quote — «4 Zugänge», «9 aktive Personen». The predicate itself is
 *  the server's (see `SetupState`); these only fill in what the row says about it, and the System
 *  page already holds them, so the card still adds no request of its own. */
export interface SetupFacts {
  users: number | null
  personnelActive: number | null
}

/** A row somebody can actually tick: it counts towards «x von n» and keeps the card up. */
interface Row {
  key: string
  /** what the STATION's data says — before any manual acknowledgement is folded in */
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
 * ⚠️ The PREDICATES are not computed here any more (10.09.2026). `GET /api/system` carries a
 * `setup` block — one `{id, done}` per row, in card order — and this card renders it. The nine
 * rules used to live in this file AND in the backend's own deployment check, which is two copies
 * of «is this station set up» that could only drift; the answer is now available to anything that
 * is not a browser, and there is one place to change a rule. What stays local is what the server
 * has no business writing: the row's WORDS, the consequence it names, and the numbers its sub
 * line quotes (`SetupFacts`).
 *
 * ⚠️ The rule holds; what it could not cover is a row whose FACT this UI cannot observe.
 * «Fahrzeuge» is that row: a station happy with the built-in catalogue never writes
 * `fleet.vehicles`, so the derived tick could never fire and the card parked at «7 von 8»
 * forever — the same failure, from the other direction. Hence the second control on every row:
 * «Abhaken» acknowledges a row by hand, an acknowledged row counts as done, and the
 * acknowledgement is stored in the config (`ACK_PATH`), not on the device. Derived ticks are
 * unchanged — the hand tick is an escape hatch, never the normal way to finish a row.
 */
export function SetupChecklist({ cfg, setup, facts, onGo }: {
  cfg: DeploymentConfig | null
  /** the server's `setup` block; null while /api/system is still out — or when that one section
   *  failed, and a card that cannot say what is open says nothing at all */
  setup: SetupState | null
  facts: SetupFacts
  onGo: (section: string) => void
}) {
  const C = appConfig.copy.admin.setup
  // The same writer «Verwaltung» uses everywhere: `set` edits the draft, the provider autosaves
  // the WHOLE document under its If-Match token (ConfigContext · persist).
  const { set } = useConfig()
  if (!cfg || !setup) return null

  // What each row SAYS, by the id the server sends. `sub` reads the local draft for the values
  // it quotes back — the tick itself is never derived here.
  const pair = (v: unknown): [number, number] | null =>
    Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number') ? (v as [number, number]) : null
  const centre = pair(cfg.map?.defaultView?.center) ?? pair(cfg.map?.defaultView?.centerLv95)
  const spec: Record<string, { label: string; go: string; sub: (done: boolean) => string }> = {
    // These two quote the value itself, so they read it rather than the tick: a done row shows
    // what is set, an open one what leaving it costs.
    name: { label: C.name, go: 'identitaet', sub: () => cfg.identity?.appName?.trim() || C.nameOpen },
    map: {
      label: C.map,
      go: 'identitaet',
      sub: () => (centre ? fillTemplate(C.mapSet, { lon: String(centre[0]), lat: String(centre[1]) }) : C.mapOpen),
    },
    logo: { label: C.logo, go: 'identitaet', sub: (d) => (d ? C.logoSet : C.logoOpen) },
    // A fresh deployment always has the ONE seeded account, so the server's predicate is «> 1»:
    // the question this row asks is «has the Wehr put its own people in».
    users: {
      label: C.users,
      go: 'mitglieder',
      sub: (d) => (d ? fillTemplate(C.usersSet, { n: facts.users ?? 0 }) : C.usersOpen),
    },
    personnel: {
      label: C.personnel,
      go: 'mannschaft',
      sub: (d) => (d ? fillTemplate(C.personnelSet, { n: facts.personnelActive ?? 0 }) : C.personnelOpen),
    },
    // ⚠️ Reads the DEPLOYMENT config only, and the built-in vehicle catalogue never writes
    // there: a station happy with the shipped Fahrzeuge keeps `fleet.vehicles = []` forever and
    // this row could never tick on its own. That is what «Abhaken» is for — see the escape hatch
    // in the card's doc comment.
    fleet: {
      label: C.fleet,
      go: 'fahrzeuge',
      sub: (d) => (d ? fillTemplate(C.fleetSet, { n: cfg.fleet?.vehicles?.length ?? 0 }) : C.fleetOpen),
    },
    // A Wehr can tick every other row and still be offered «Hauptstrasse 3» from a village three
    // cantons away when it opens an incident — the two geocoder fields appear on no landing page
    // at all. Done on EITHER of them (geocode.py · _resolve_bias).
    geocoder: { label: C.geocoder, go: 'identitaet', sub: (d) => (d ? C.geocoderSet : C.geocoderOpen) },
    // Credentials alone are a silent no-op (scheduler.py never has a folder to poll), and a
    // folder alone cannot exist without credentials to read it with — so the row is ONE fact.
    // It leads to «Zugangsdaten», not the config file: that is the half of the setup this UI can
    // actually offer a button for.
    sharepoint: { label: C.sharepoint, go: 'zugaenge', sub: (d) => (d ? C.sharepointSet : C.sharepointOpen) },
    // A station that never learns its instance is down is the failure the whole ops story is
    // about — and «Zugangsdaten» is now a screen that fixes it, so this row leads there rather
    // than naming an environment variable nobody at a tablet can reach.
    monitoring: { label: C.monitoring, go: 'zugaenge', sub: (d) => (d ? C.monitoringSet : C.monitoringOpen) },
  }

  // Order and membership are the SERVER's (backend · SETUP_ROWS); a row this build has no words
  // for is skipped rather than rendered as its raw id.
  const rows: Row[] = setup.rows.flatMap(({ id, done }) => {
    const s = spec[id]
    return s ? [{ key: id, done, label: s.label, sub: s.sub(done), go: s.go }] : []
  })

  // Fold the hand ticks in: an acknowledged row counts as done and says so, unless the derived
  // state already had something better to say.
  // ⚠️ Read from the DRAFT, not from `setup.acknowledged` — they are the same list, but the
  // draft is the one that has just been written to. Waiting for /api/system to be re-fetched
  // would leave «Abhaken» looking like it did nothing for as long as the autosave takes.
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
