import { useState } from 'react'
import { dismissAlarm, loadDismissedAlarms } from '../../lib/diveraDismiss'
import { useMeldung, useMeldungKindPending } from '../../lib/useMeldung'
import { appConfig } from '../../config/appConfig'
import { shortAddress } from '../../lib/deploymentConfig'
import type { DiveraAlarm, IncidentMeta } from '../../lib/incidents'
import { realCoord, fmtWhen } from './_shared'

// ⚠️ None of the three below paints anything any more (23.08.). Each publishes ONE record into
// the Meldeleiste — `{ id, kind, tone, title, sub, actions }` — and the strip decides which one
// is read. They keep their names because App and IncidentWorkspace mount them where the state
// they watch lives; what changed is that they no longer bring their own geometry, z-index and
// live region to the fight. See src/lib/meldungen.ts for the ranking.

// --- Incoming-alarm row (one-tap take) ------------------------------------------------------
// Published whenever an untaken Divera alarm is in the pool. The whole point of the redesign:
// the dispatch finds the EL. The primary action takes the alarm AS-IS (everything Divera carries
// + backend type/priority/geocode) and drops straight onto the map — corrections happen there
// via the review row, not in a gating wizard. Dismissed alarms are remembered PER DEVICE
// (localStorage), so a given alarm only ever nags once on this device — across reloads, and
// whether it's X'd or taken.
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
  const now = Date.now()
  const live = alarms.filter((a) => {
    if (dismissed.has(a.divera_id)) return false
    // age < 3h; no lower bound so minor server/device clock skew can't hide a fresh alarm
    const age = now - new Date(a.received_at).getTime()
    return Number.isFinite(age) && age < ALARM_MAX_AGE_MS
  })
  // pool is newest-first; ONE alarm is published — dismissing it (per device) surfaces the
  // next, and the landing launch list always carries the whole pool
  const top = live[0]
  const busy = top != null && taking === top.divera_id
  useMeldung(top == null ? null : {
    id: `alarm:${top.divera_id}`,
    kind: 'alarm',
    tone: 'alarm',
    icon: 'bell',
    title: `${ix.newDiveraAlarm} — ${top.title}`,
    sub: `${shortAddress(top.address) ?? ix.addressUnknown} · ${fmtWhen(top.received_at)}`,
    actions: [
      { label: busy ? ix.alarmOpening : ix.alarmOpen, icon: busy ? 'rotate' : 'truck', busy, primary: true, disabled: busy, onClick: () => onTake(top) },
      // split dispatch: this alarm may be the Einsatz that's already open — join it
      { label: ix.attachShort, icon: 'swap', disabled: busy, onClick: () => onAttach(top) },
    ],
    dismiss: { label: ix.hide, onClick: () => setDismissed(dismissAlarm(top.divera_id)) },
  })
  return null
}

// --- New-incident row (announce, never switch) ----------------------------------------------
// With alarm auto-open, an Einsatz can appear with no human in the loop (Divera auto-take,
// generic /api/alarms intake, or a colleague's take on another device). This announces the
// arrival wherever the operator is; switching stays a deliberate tap — a working editor is
// never yanked off their incident. Dismissal is per device (useIncidentWatch).
export function NewIncidentBanner({ inc, active, onSwitch, onDismiss }: {
  inc: IncidentMeta
  /** whether another incident is currently active (labels the action Wechseln vs. Öffnen) */
  active: boolean
  onSwitch: () => void
  onDismiss: () => void
}) {
  const c = appConfig.copy.incidentAlert
  useMeldung({
    id: `incident:${inc.id}`,
    kind: 'alarm',
    tone: 'alarm',
    icon: 'bell',
    title: `${c.kicker} — ${inc.title}`,
    sub: `${shortAddress(inc.address) ?? appConfig.copy.intake.addressUnknown} · ${fmtWhen(inc.started_at)}`,
    actions: [{ label: active ? c.switch : c.open, icon: 'truck', primary: true, onClick: onSwitch }],
    dismiss: { label: c.later, onClick: onDismiss },
  })
  return null
}

// --- Intake review row (correct-in-place) ---------------------------------------------------
// Published on a freshly one-tap-taken Divera incident so the EL is operational immediately and
// refines without a blocking step: «Passt» confirms the dispatch's guesses, «Bearbeiten» opens
// the panel that already holds Stichwort, Adresse, Meldung AND the Einsatzart.
//
// ⚠️ This is the one place the Meldeleiste MOVES a capability rather than rehousing it (decided
// 23.08.). The old card was not a banner but a form — 700px wide, a 4-line clamped Meldung and a
// Combo for the Einsatzart — which is precisely why it covered the due-Wiedervorlage card whole.
// A form does not fit a row, so the Einsatzart picker went back to the edit panel, which has
// carried the same Combo all along (EinsatzWizard · categoryLabel).
// A missing coordinate still gets said loudly: the row turns amber and names it.
export function ReviewBanner({ meta, onEdit, onDone }: {
  meta: IncidentMeta
  onEdit: () => void
  onDone: () => void
}) {
  const ix = appConfig.copy.intake
  const hasLoc = realCoord(meta.lng, meta.lat) != null
  // ⚠️ Yields to a pending alarm (23.08.). «Passt» confirms the dispatch's guesses for the Einsatz
  // you are IN — asking that while an unopened alarm is still on the strip invites confirming one
  // Einsatz's data while looking at another's. The alarm owns the moment; this comes back the
  // instant the alarm is taken or waved away. Same rule NewIncidentBanner already follows.
  const alarmPending = useMeldungKindPending('alarm')
  useMeldung(alarmPending ? null : {
    id: `review:${meta.id}`,
    kind: 'review',
    tone: hasLoc ? 'info' : 'warn',
    icon: hasLoc ? 'flag' : 'warn',
    title: ix.reviewTitle,
    sub: hasLoc ? ix.fromDivera : ix.noLocationOnMap,
    actions: [
      { label: appConfig.copy.edit, icon: 'pen', onClick: onEdit },
      { label: ix.ok, icon: 'check', primary: true, onClick: onDone },
    ],
  })
  return null
}
