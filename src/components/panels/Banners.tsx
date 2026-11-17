import { useState } from 'react'
import { hiddenAlarms, inAlarmWindow, shownAlarms } from '../../lib/diveraDismiss'
import { useMeldung, useMeldungKindPending } from '../../lib/useMeldung'
import { appConfig } from '../../config/appConfig'
import { shortAddress } from '../../lib/deploymentConfig'
import { acceptAlarmUpdate, dismissAlarmUpdate, showAlarmUpdate, undoAlarmUpdate, type DiveraAlarm, type IncidentFull, type IncidentMeta } from '../../lib/incidents'
import { alarmUpdateRow } from '../../lib/alarmUpdate'
import { ApiError } from '../../lib/api'
import { toast, undoToast } from '../../lib/ui'
import { realCoord } from './_shared'
import { fmtWhen } from '../../lib/format'

// ⚠️ None of the four below paints anything any more (23.08.). Each publishes ONE record into
// the Meldeleiste — `{ id, kind, tone, title, sub, actions }` — and the strip decides which one
// is read. They keep their names because App and IncidentWorkspace mount them where the state
// they watch lives; what changed is that they no longer bring their own geometry, z-index and
// live region to the fight. See src/lib/meldungen.ts for the ranking.

// --- Incoming-alarm row (one-tap take) ------------------------------------------------------
// Published whenever an untaken Divera alarm is in the pool. The whole point of the redesign:
// the dispatch finds the EL. The primary action takes the alarm AS-IS (everything Divera carries
// + backend type/priority/geocode) and drops straight onto the map — corrections happen there
// via the review row, not in a gating wizard. Dismissed alarms are remembered PER DEVICE
// (localStorage), so a given alarm only ever nags once on this device — across reloads. ✕ folds
// the row to a grey strip in its own place, «Ausgeblendet · <Stichwort> · Zeigen» (rare-user
// round M3 = C, 17.11.2026; lib/diveraDismiss · hiddenAlarms): it stays while the alarm is
// untaken and younger than 3 h, and «Zeigen» brings the row back. No toast.
//
// One exception to «take leads» (`attachFirst`): an Einsatz started by hand — the Übung above
// all — has no alarm behind it, so its Zeiten stay empty until one is attached and taking this
// dispatch would open a second Einsatz next to the one the crew is in. There, «Zu Einsatz» is
// the filled action. Same two buttons, swapped emphasis; nothing is hidden either way.
export function IncomingAlarmBanner({ alarms, dismissed, taking, attachFirst, onTake, onAttach, onDismiss, onShow }: {
  alarms: DiveraAlarm[]
  /** the alarms hidden on this device (lib/diveraDismiss) – App's one set, shared with the
   *  «Einsätze» list and the «Neuer Einsatz» gate */
  dismissed: ReadonlySet<number>
  /** divera_id currently being taken (disables its button) */
  taking: number | null
  /** The open Einsatz was started by hand (Übung included), so no alarm routes anything to it
   *  yet: its Zeiten stay empty until one is attached, and a take would put this dispatch in a
   *  SECOND Einsatz beside the one the crew is working in. So «Zu Einsatz» leads and Öffnen
   *  follows — one tap, and the times land where the operator is looking. */
  attachFirst: boolean
  onTake: (a: DiveraAlarm) => void
  /** attach this alarm to the active incident (split dispatch; the caller confirms). Absent when
   *  there is nothing to attach TO — the active Einsatz is closed — and then only «Öffnen» shows. */
  onAttach?: (a: DiveraAlarm) => void
  /** hide this alarm on this device (the row's ✕) */
  onDismiss: (a: DiveraAlarm) => void
  /** «Zeigen» on the strip: the hidden alarm back as a row */
  onShow: (a: DiveraAlarm) => void
}) {
  const ix = appConfig.copy.intake
  const live = shownAlarms(alarms, dismissed)
  // pool is newest-first; ONE alarm is published — dismissing it (per device) surfaces the
  // next, and the landing launch list always carries the whole pool
  const top = live[0]
  const busy = top != null && taking === top.divera_id
  // The same two actions either way — only which one is filled, and reads first, changes.
  const actionsFor = (a: DiveraAlarm) => {
    const take = { label: busy ? ix.alarmOpening : ix.alarmOpen, icon: busy ? 'rotate' : 'truck', busy, primary: !attachFirst || !onAttach, disabled: busy, onClick: () => onTake(a) }
    if (!onAttach) return [take]
    // split dispatch: this alarm may be the Einsatz that's already open — join it
    const attach = { label: ix.attachShort, icon: 'swap', primary: attachFirst, disabled: busy, onClick: () => onAttach(a) }
    return attachFirst ? [attach, take] : [take, attach]
  }
  useMeldung(top == null ? null : {
    id: `alarm:${top.divera_id}`,
    kind: 'alarm',
    tone: 'alarm',
    icon: 'bell',
    title: `${ix.newDiveraAlarm} — ${top.title}`,
    sub: `${shortAddress(top.address) ?? ix.addressUnknown} · ${fmtWhen(top.received_at, { todayShort: true })}`,
    actions: actionsFor(top),
    dismiss: { label: ix.hide, onClick: () => onDismiss(top) },
  })
  // the newest hidden one folds in the row's place; showing it lets the next hidden one fold there
  const folded = hiddenAlarms(alarms, dismissed)[0]
  useMeldung(folded == null ? null : {
    id: `alarm-hidden:${folded.divera_id}`,
    kind: 'alarmHidden',
    tone: 'calm',
    icon: 'bell-off',
    title: `${ix.hiddenAlarm} · ${folded.title}`,
    fold: true,
    actions: [{ label: ix.showAlarm, onClick: () => onShow(folded) }],
  })
  return null
}

// --- «Alarm aktualisiert» row (decide, never overwrite) ------------------------------------
// The Leitstelle sent a follow-up for the open Einsatz's own alarm (backend app/alarm_update). The
// sibling of «Neuer Alarm» – same red bell, same row – showing old → new per field. «Übernehmen»
// takes every changed field nobody edited by hand (the label names them when it is not all of
// them), with «Rückgängig» on the toast; «Bearbeiten» opens the Einsatzdaten with the alarm's
// value offered beside each field; ✕ hides it for EVERY device – one decision for the Einsatz –
// and folds it to the same grey strip as a hidden «Neuer Alarm» («Ausgeblendet · … · Zeigen»,
// rare-user round F7, 17.11.2026) on every device, inside the same 3-h window; «Zeigen» makes it
// pending again (backend alarm_update · show). All four are the server's (Verlauf row included) and need a connection: no outbox, because
// the Einsatzdaten they change have none either; a failure says so and the row stays.
export function AlarmUpdateBanner({ meta, onChanged, onEdit }: {
  /** the open Einsatz as the list poll last served it – `alarm_update` set */
  meta: IncidentMeta
  /** the incident as the server now has it (App · reflectMeta) */
  onChanged: (inc: IncidentFull) => void
  onEdit: () => void
}) {
  const C = appConfig.copy.intake.alarmUpdate
  const [busy, setBusy] = useState(false)
  const update = meta.alarm_update
  const run = async (call: () => Promise<IncidentFull>, done?: string) => {
    if (busy) return
    setBusy(true)
    try {
      onChanged(await call())
      // the take of an update is no ↶ step: the pill is its only way back, so it keeps its own kind
      if (done) undoToast(done, () => void run(() => undoAlarmUpdate(meta.id)), undefined, { glyph: 'check', kind: 'alarm-update' })
    } catch (e) {
      toast(e instanceof ApiError && e.status !== 0 ? e.detail : C.failed, { icon: 'warn', tone: 'warn' })
    } finally {
      setBusy(false)
    }
  }
  const hidden = update?.state === 'hidden'
  const row = update && !(hidden && !inAlarmWindow(update.at)) ? alarmUpdateRow(update, meta.title) : null
  useMeldung(row == null ? null : hidden ? {
    id: `alarm-update-hidden:${meta.id}`,
    kind: 'alarmHidden',
    tone: 'calm',
    icon: 'bell-off',
    title: `${appConfig.copy.intake.hiddenAlarm} · ${row.title}`,
    fold: true,
    actions: [{ label: appConfig.copy.intake.showAlarm, busy, disabled: busy, onClick: () => void run(() => showAlarmUpdate(meta.id)) }],
  } : {
    // one row per pending update: a newer one replaces it in place
    id: `alarm-update:${meta.id}`,
    kind: 'alarm',
    tone: 'alarm',
    icon: 'bell',
    title: row.title,
    sub: row.sub,
    sub2: row.sub2,
    subLines: 2,
    actions: [
      { label: appConfig.copy.edit, icon: 'pen', disabled: busy, onClick: onEdit },
      ...(row.takeLabel ? [{ label: row.takeLabel, icon: 'check', primary: true, busy, disabled: busy, onClick: () => void run(() => acceptAlarmUpdate(meta.id), C.taken) }] : []),
    ],
    dismiss: { label: appConfig.copy.intake.hide, onClick: () => void run(() => dismissAlarmUpdate(meta.id)) },
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
    sub: `${shortAddress(inc.address) ?? appConfig.copy.intake.addressUnknown} · ${fmtWhen(inc.started_at, { todayShort: true })}`,
    actions: [{ label: active ? c.switch : c.open, icon: 'truck', primary: true, onClick: onSwitch }],
    dismiss: { label: c.dismiss, onClick: onDismiss },
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
