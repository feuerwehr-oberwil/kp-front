import { useState } from 'react'
import { Icon } from '../../lib/icons'
import { dismissAlarm, loadDismissedAlarms } from '../../lib/diveraDismiss'
import { Combo } from '../Combo'
import { appConfig } from '../../config/appConfig'
import { shortAddress } from '../../lib/deploymentConfig'
import type { DiveraAlarm, IncidentMeta } from '../../lib/incidents'
import { realCoord, fmtWhen } from './_shared'

// --- Incoming-alarm banner (one-tap take) -------------------------------------------
// Floats over the live map whenever an untaken Divera alarm is in the pool. The whole
// point of the redesign: the dispatch finds the EL. The primary button takes the alarm
// AS-IS (everything Divera carries + backend type/priority/geocode) and drops straight
// onto the map — corrections happen there via the ReviewBanner, not in a gating wizard.
// dismissed alarms are remembered PER DEVICE (localStorage), so a given alarm only ever
// nags once on this device — across reloads, and whether it's X'd or taken.
const ALARM_MAX_AGE_MS = 3 * 60 * 60 * 1000 // only surface dispatches < 3h old

export function IncomingAlarmBanner({ alarms, taking, onTake, onAttach }: {
  alarms: DiveraAlarm[]
  /** divera_id currently being taken (disables its button) */
  taking: number | null
  onTake: (a: DiveraAlarm) => void
  /** attach this alarm to the active incident (split dispatch; the caller confirms) */
  onAttach: (a: DiveraAlarm) => void
}) {
  const ix = appConfig.copy.intake
  const [dismissed, setDismissed] = useState<Set<number>>(loadDismissedAlarms)
  const dismiss = (id: number) => setDismissed(dismissAlarm(id))
  const now = Date.now()
  const live = alarms.filter((a) => {
    if (dismissed.has(a.divera_id)) return false
    // age < 3h; no lower bound so minor server/device clock skew can't hide a fresh alarm
    const age = now - new Date(a.received_at).getTime()
    return Number.isFinite(age) && age < ALARM_MAX_AGE_MS
  })
  if (live.length === 0) return null
  // pool is newest-first; the banner shows ONE alarm — dismissing it (per device)
  // surfaces the next, and the landing launch list always carries the whole pool
  const top = live[0]
  const busy = taking === top.divera_id
  return (
    <div className="dv-banner" role="alert">
      <div className="dv-banner-pulse"><Icon id="bell" /></div>
      <div className="dv-banner-main">
        <div className="dv-banner-kicker">{ix.newDiveraAlarm}</div>
        <div className="dv-banner-title">{top.title}</div>
        <div className="dv-banner-sub">{shortAddress(top.address) ?? ix.addressUnknown} · {fmtWhen(top.received_at)}</div>
      </div>
      <div className="dv-banner-act">
        <button className="ip-btn primary" disabled={busy} onClick={() => onTake(top)}>
          <Icon id={busy ? 'rotate' : 'truck'} className={busy ? 'spin' : undefined} /> {busy ? ix.alarmOpening : ix.alarmOpen}
        </button>
        {/* split dispatch: this alarm may be the Einsatz that's already open — join it */}
        <button className="ip-btn ghost" disabled={busy} onClick={() => onAttach(top)} title={ix.attach}>
          <Icon id="swap" /> {ix.attachShort}
        </button>
        <button className="dv-banner-x" aria-label={ix.hide} onClick={() => dismiss(top.divera_id)}>
          <Icon id="close" />
        </button>
      </div>
    </div>
  )
}

// --- New-incident banner (announce, never switch) ------------------------------------
// With alarm auto-open, an Einsatz can appear with no human in the loop (Divera auto-take,
// generic /api/alarms intake, or a colleague's take on another device). This announces the
// arrival wherever the operator is; switching stays a deliberate tap — a working editor is
// never yanked off their incident. Dismissal is per device (useIncidentWatch).
export function NewIncidentBanner({ inc, active, onSwitch, onDismiss }: {
  inc: IncidentMeta
  /** whether another incident is currently active (labels the button Wechseln vs. Öffnen) */
  active: boolean
  onSwitch: () => void
  onDismiss: () => void
}) {
  const c = appConfig.copy.incidentAlert
  return (
    <div className="dv-banner" role="alert">
      <div className="dv-banner-pulse"><Icon id="bell" /></div>
      <div className="dv-banner-main">
        <div className="dv-banner-kicker">{c.kicker}</div>
        <div className="dv-banner-title">{inc.title}</div>
        <div className="dv-banner-sub">{shortAddress(inc.address) ?? appConfig.copy.intake.addressUnknown} · {fmtWhen(inc.started_at)}</div>
      </div>
      <div className="dv-banner-act">
        <button className="ip-btn primary" onClick={onSwitch}>
          <Icon id="truck" /> {active ? c.switch : c.open}
        </button>
        <button className="dv-banner-x" aria-label={c.later} onClick={onDismiss}>
          <Icon id="close" />
        </button>
      </div>
    </div>
  )
}

// --- In-map review banner (correct-in-place) ----------------------------------------
// Shown on a freshly one-tap-taken Divera incident so the EL is operational immediately
// and refines without a blocking step: the dispatch reads top-down like the pager message
// (Stichwort, Adresse, Meldung — verify at a glance, tap «Passt», done); the Einsatzart is
// a compact Combo, and the edit panel stays one tap away for address/location fixes.
// Warns loudly when no coordinate could be resolved.
export function ReviewBanner({ meta, categories, onPatchType, onEdit, onDone }: {
  /** meta comes from getIncident/takeDiveraAlarm (IncidentFull), so the Meldung is present */
  meta: IncidentMeta & { text?: string | null }
  categories: string[]
  onPatchType: (type: string) => void
  onEdit: () => void
  onDone: () => void
}) {
  const ix = appConfig.copy.intake
  const hasLoc = realCoord(meta.lng, meta.lat) != null
  return (
    <div className={`rv-banner${hasLoc ? '' : ' rv-warn'}`} role="status">
      <div className="rv-head">
        <Icon id={hasLoc ? 'flag' : 'warn'} />
        <span className="rv-kicker">{ix.fromDivera}</span>
      </div>
      <div className="rv-title">{meta.title}</div>
      <div className="rv-addr">{hasLoc ? (meta.address ?? ix.locationSet) : ix.noLocationOnMap}</div>
      {!!meta.text?.trim() && <div className="rv-msg">{meta.text}</div>}
      <div className="rv-body">
        {/* same themed Combo as the wizard: options are display labels, the stored value
            stays the (German) kategorie key — mapped back on change */}
        <div className="rv-type">
          <Combo
            value={meta.type ? (ix.kategorienLabels[meta.type] ?? meta.type) : ''}
            options={categories.map((k) => ix.kategorienLabels[k] ?? k)}
            placeholder={ix.categoryLabel}
            clearable={false}
            onChange={(label) => onPatchType(categories.find((k) => (ix.kategorienLabels[k] ?? k) === label) ?? label)}
          />
        </div>
        <div className="rv-act">
          <button className="ip-btn" onClick={onEdit}><Icon id="pen" /> {appConfig.copy.edit}</button>
          <button className="ip-btn primary" onClick={onDone}><Icon id="check" /> {ix.ok}</button>
        </div>
      </div>
    </div>
  )
}
