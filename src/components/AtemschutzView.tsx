import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { toast } from '../lib/ui'
import { cx } from '../lib/cx'
import { Segmented } from './Segmented'
import { Overlay } from '../lib/overlays'
import { contactSeverity, deriveTruppLive, estimatePressure, fmtClock, type TruppLive } from '../lib/atemschutz'
import type { AttendanceState, Person, Trupp, TruppFields } from '../types'
import { assignedPersonIds } from '../lib/personnel'
import { PersonField, type Slot } from './PersonField'
import { ensureNotifyPermission, unlockAlarm } from '../lib/alarm'
import { atemschutzDoctrine } from '../lib/deploymentConfig'
import { useHoldRepeat } from '../lib/useHoldRepeat'
import { useTapToType } from '../lib/useTapToType'
import s from './Atemschutz.module.css'

const cfg = appConfig.atemschutz // static, non-doctrine parts only (auftrag list)
// `az` (appConfig.copy.atemschutz) and the doctrine numbers (`atemschutzDoctrine()`) are read
// at the top of each component/helper below rather than captured here at module-load, so the
// locale AND the deployment config resolved at boot apply.

type FormMode = 'create' | 'edit' | 'redeploy'

/** Resolve a Trupp's Auftrag type to its display label (the order detail lives in `ziel`). */
function auftragTypeLabel(t: Trupp): string | null {
  if (!t.auftrag) return null
  // localized label wins; fall back to the config label (stored value stays the auftrag id)
  return appConfig.copy.atemschutz.auftragLabels[t.auftrag] ?? cfg.auftrag.find((a) => a.id === t.auftrag)?.label ?? null
}

/** snap a raw bar value to the step grid, clamped to [0, ceiling] */
function snapBar(v: number): number {
  const dz = atemschutzDoctrine()
  return Math.max(0, Math.min(dz.pressureMax, Math.round(v / dz.pressureStep) * dz.pressureStep))
}

// The Atemschutzüberwachung surface: the digital Atemschutz-Überwachungstafel. Swiss FKS model
// — one big glanceable card per Trupp whose dominant element is TIME SINCE LAST FUNKKONTAKT, a
// large "Kontakt" reset, and a contact-clock alarm (amber nudge → red überfällig). Pressure is
// set inline and logged. Purely presentational + local UI state — data + mutations via props.
export function AtemschutzView({
  trupps, canEdit, personnel, attendance, muted, onToggleMuted, createTrupp, placeTrupp, placeTargets, focusTruppOnPlan, recordContact, recordPressure, setTruppStatus, editTrupp, reactivateTrupp, deleteTrupp, restoreTrupp,
  intervalMin = atemschutzDoctrine().contactIntervalMin, graceSec = atemschutzDoctrine().contactGraceSec,
  defaultFunkkanal = atemschutzDoctrine().defaultFunkkanal,
}: {
  trupps: Trupp[]
  canEdit: boolean
  /** per-incident Funkkontakt-Intervall (min) + Nachfrist (sec); default = appConfig doctrine */
  intervalMin?: number
  graceSec?: number
  /** synced default Funkkanal new Trupps are seeded with (FKS-Standard: 11) */
  defaultFunkkanal?: number
  /** Mannschaft roster + who is present — the create/edit form offers present people first */
  personnel: Person[]
  attendance: AttendanceState
  /** alarm audibility (per-device, persisted in App) — drives the mute button only; the actual
   *  alarm now runs app-wide in useAtemschutzAlarm so it fires even off this surface */
  muted: boolean
  onToggleMuted: () => void
  createTrupp: (t: Trupp) => void
  /** place a Trupp's marker — targetId is the Lage map or a plan (see App's placeTargets) */
  placeTrupp: (id: string, targetId?: string) => void
  /** where a Trupp can be placed (Lage map / Gebäude / Modul 6) — >1 shows a picker first */
  placeTargets: { id: string; label: string }[]
  focusTruppOnPlan: (id: string) => void
  recordContact: (id: string) => void
  recordPressure: (id: string, bar: number) => void
  setTruppStatus: (id: string, status: Trupp['status']) => void
  editTrupp: (id: string, f: TruppFields) => void
  reactivateTrupp: (id: string, f: TruppFields) => void
  deleteTrupp: (id: string) => void
  /** undo for deleteTrupp — re-adds the captured Trupp (minus its removed placement) */
  restoreTrupp: (t: Trupp) => void
}) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  // the shared create / edit / re-deploy form — null when closed
  const [form, setForm] = useState<{ mode: FormMode; trupp?: Trupp } | null>(null)
  // a Trupp awaiting a Gebäude/Modul-6 placement choice (only when >1 target exists)
  const [placePick, setPlacePick] = useState<string | null>(null)
  const handlePlace = (id: string) => {
    // no plan to place on yet — the EL must first create a Gebäude (from the Umrisse) or there's
    // no Modul 6 for this object. Tell them rather than silently doing nothing.
    if (placeTargets.length === 0) { toast(az.placeNoTarget, { icon: 'warn', tone: 'warn' }); return }
    if (placeTargets.length > 1) setPlacePick(id)
    else placeTrupp(id, placeTargets[0].id)
  }

  // per-second tick so the contact clock re-renders (pattern from TopBar's clock). This drives
  // the VISUAL board only; the audible alarm + OS notification run app-wide (useAtemschutzAlarm).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // derive every Trupp's live numbers once per tick
  const live = useMemo(
    () => new Map(trupps.map((t) => [t.id, deriveTruppLive(t, now, intervalMin, graceSec)] as const)),
    [trupps, now, intervalMin, graceSec],
  )

  // überfällige Trupps float to the top of the board so an overdue one can't hide off-screen,
  // and the header carries a count badge (the alarm may be muted — the visual must not be).
  const overdueCount = trupps.filter((t) => live.get(t.id)?.status === 'ueberfaellig').length
  const activeTrupps = trupps
    .filter((t) => t.status !== 'raus')
    .sort((a, b) => Number(live.get(b.id)?.status === 'ueberfaellig') - Number(live.get(a.id)?.status === 'ueberfaellig'))
  const done = trupps.filter((t) => t.status === 'raus')

  // roster of everyone already entered on any Trupp (GF + AdF) — offered as quick-select chips
  // in the form so names don't have to be retyped each time.
  const roster = useMemo(() => {
    const seen = new Set<string>()
    for (const t of trupps) {
      for (const n of [t.name, ...(t.members ?? [])]) {
        const v = n?.trim()
        if (v) seen.add(v)
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b, 'de'))
  }, [trupps])

  // present crew (attendance) — offered first in the picker; ids already on another active
  // Trupp get a duplicate-warning badge but stay selectable (real incidents need corrections)
  const presentIds = useMemo(
    () => new Set(Object.entries(attendance).filter(([, a]) => a.status === 'present').map(([id]) => id)),
    [attendance],
  )

  // unlock the alarm tone + ask for OS-notification permission on this gesture, so a later
  // überfällig alert can both sound and reach the tray when the app is backgrounded.
  const openForm = (mode: FormMode, trupp?: Trupp) => { unlockAlarm(); void ensureNotifyPermission(); setForm({ mode, trupp }) }

  const submitForm = (f: TruppFields) => {
    if (!form) return
    if (form.mode === 'create') {
      createTrupp({
        id: `tr${Date.now()}`,
        name: f.name, members: f.members, auftrag: f.auftrag, ziel: f.ziel, lineNumber: f.lineNumber, funkkanal: f.funkkanal,
        leaderPersonId: f.leaderPersonId, memberPersonIds: f.memberPersonIds,
        entryPressureBar: f.pressure, entryTime: '', lastContactTime: '', lowestBar: f.pressure,
        status: 'angemeldet', readings: [],
      })
    } else if (form.mode === 'edit' && form.trupp) {
      editTrupp(form.trupp.id, f)
    } else if (form.mode === 'redeploy' && form.trupp) {
      reactivateTrupp(form.trupp.id, f)
    }
    setForm(null)
  }

  const cards = (list: Trupp[]) => list.map((t) => (
    <TruppCard
      key={t.id} t={t} live={live.get(t.id)!} now={now} canEdit={canEdit} intervalMin={intervalMin} graceSec={graceSec}
      onContact={recordContact} onPressure={recordPressure} onStatus={setTruppStatus}
      onEdit={() => openForm('edit', t)} onReenter={() => openForm('redeploy', t)}
      onDelete={deleteTrupp} onRestore={restoreTrupp} onPlace={handlePlace} onShowPlan={focusTruppOnPlan}
    />
  ))

  return (
    <div className={s.surface}>
      <header className={s.head}>
        <div className={s.headTitles}>
          <h2>{az.title}</h2>
          <p>{az.subtitle}</p>
        </div>
        {overdueCount > 0 && (
          <div className={s.overdueBadge} role="status" aria-live="assertive">
            <Icon id="warn" /><span>{az.overdueBadge.replace('{n}', String(overdueCount))}</span>
          </div>
        )}
        <button
          className={cx(s.muteBtn, muted && s.muteOn)} onClick={onToggleMuted} aria-pressed={muted}
          aria-label={muted ? az.alarmOff : az.alarmOn} title={muted ? az.alarmOff : az.alarmOn}
        >
          <Icon id={muted ? 'bell-off' : 'bell'} />
        </button>
        {canEdit && (
          <button className={s.newBtn} onClick={() => openForm('create')}>
            <Icon id="plus-bold" /><span>{az.newTrupp}</span>
          </button>
        )}
      </header>

      <div className={s.body}>
        {trupps.length === 0 ? (
          <div className={s.empty}>
            <Icon id="warn" />
            <p>{az.empty}</p>
            <span>{az.emptyHint}</span>
          </div>
        ) : (
          <div className={s.grid}>
            {cards(activeTrupps)}
            {done.length > 0 && <div className={s.sep}>{az.status.raus}</div>}
            {cards(done)}
          </div>
        )}
      </div>

      {form && (
        <TruppForm
          mode={form.mode} initial={form.trupp} roster={roster} defaultFunkkanal={defaultFunkkanal}
          personnel={personnel} presentIds={presentIds}
          assignedIds={assignedPersonIds(trupps.filter((t) => t.id !== form.trupp?.id))}
          onCancel={() => setForm(null)} onSubmit={submitForm}
        />
      )}

      {placePick && (
        <Overlay open onClose={() => setPlacePick(null)} className={cx(s.modal, s.placeModal)} ariaLabel={az.placeWhere}>
          <div className={s.modalHead}><h3>{az.placeWhere}</h3>
            <button className={s.iconBtn} aria-label={az.cancel} onClick={() => setPlacePick(null)}><Icon id="close" /></button>
          </div>
          <div className={s.placeOpts}>
            {placeTargets.map((tgt) => (
              <button key={tgt.id} className={s.placeOpt} onClick={() => { placeTrupp(placePick, tgt.id); setPlacePick(null) }}>
                <Icon id={tgt.id === 'lage' ? 'map' : 'doc'} /><span>{tgt.label}</span>
              </button>
            ))}
          </div>
        </Overlay>
      )}
    </div>
  )
}

// A gloved-friendly ±stepper for cylinder pressure (step + ceiling from config; 320 bar allows
// an overfull bottle). Big targets, snaps to the step grid; tap the value to type an exact bar.
function PressureStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  const dz = atemschutzDoctrine()
  const dec = useHoldRepeat(() => onChange(snapBar(value - dz.pressureStep)))
  const inc = useHoldRepeat(() => onChange(snapBar(value + dz.pressureStep)))
  const edit = useTapToType({ min: 0, max: dz.pressureMax, onCommit: (v) => onChange(snapBar(v)), clamp: snapBar })
  return (
    <div className={s.stepper}>
      <button type="button" className={s.stepBtn} aria-label={az.pressureDown} {...dec}>
        <Icon id="minus" />
      </button>
      {edit.editing ? (
        <div className={s.stepVal}><input className={s.stepInput} {...edit.inputProps} /><span>bar</span></div>
      ) : (
        <button type="button" className={s.stepVal} onClick={() => edit.start(value)} title={appConfig.copy.stepper.typeToEnter}><b>{value}</b><span>bar</span></button>
      )}
      <button type="button" className={s.stepBtn} aria-label={az.pressureUp} {...inc}>
        <Icon id="plus" />
      </button>
    </div>
  )
}

// The Funkkanal ±stepper in the create/edit form: hold to repeat, tap the value to type an
// exact channel. Clamped to the configured channel range.
function FunkkanalStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const az = appConfig.copy.atemschutz
  const dz = atemschutzDoctrine()
  const clamp = (v: number) => Math.max(dz.funkkanalMin, Math.min(dz.funkkanalMax, v))
  const dec = useHoldRepeat(() => onChange(clamp(value - 1)))
  const inc = useHoldRepeat(() => onChange(clamp(value + 1)))
  const edit = useTapToType({ min: dz.funkkanalMin, max: dz.funkkanalMax, onCommit: onChange })
  return (
    <div className={s.stepper}>
      <button type="button" className={s.stepBtn} aria-label={az.funkkanalDown} {...dec}><Icon id="minus" /></button>
      {edit.editing ? (
        <div className={s.stepVal}><input className={s.stepInput} {...edit.inputProps} /><span>{az.funkkanalUnit}</span></div>
      ) : (
        <button type="button" className={s.stepVal} onClick={() => edit.start(value)} title={appConfig.copy.stepper.typeToEnter}><b>{value}</b><span>{az.funkkanalUnit}</span></button>
      )}
      <button type="button" className={s.stepBtn} aria-label={az.funkkanalUp} {...inc}><Icon id="plus" /></button>
    </div>
  )
}

// The INLINE pressure control on a live card: ± adjust a PENDING value (shown distinct); nothing
// is committed until "Bestätigen". A misclick on ± therefore never silently logs a reading or
// resets the contact clock — only an explicit confirm does (which is what counts as a Funkkontakt).
function PressureInline({ value, onCommit }: { value: number; onCommit: (bar: number) => void }) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  // keyed on `value` by the caller, so an external change to the committed pressure remounts this
  // with a fresh start — no sync effect needed
  const dz = atemschutzDoctrine()
  const [bar, setBar] = useState(value)
  const dirty = bar !== value
  const bump = (d: number) => setBar((b) => snapBar(b + d))
  const dec = useHoldRepeat(() => bump(-dz.pressureStep))
  const inc = useHoldRepeat(() => bump(dz.pressureStep))
  const edit = useTapToType({ min: 0, max: dz.pressureMax, onCommit: (v) => setBar(snapBar(v)), clamp: snapBar })
  const low = bar <= dz.mindestBar
  return (
    <div className={s.pressureBlock}>
      <div className={s.pressureRow}>
        <span className={s.pressureLbl}>{az.currentPressure}</span>
        <div className={s.pressureCtl}>
          <button type="button" className={s.pBtn} aria-label={az.pressureDown} {...dec}>
            <Icon id="minus" />
          </button>
          {edit.editing ? (
            <span className={cx(s.pVal, dirty && s.pPending, low && s.metaAlarm)}><input className={s.pInput} {...edit.inputProps} /><span>bar</span></span>
          ) : (
            <button type="button" className={cx(s.pVal, s.pValBtn, dirty && s.pPending, low && s.metaAlarm)} onClick={() => edit.start(bar)} title={appConfig.copy.stepper.typeToEnter}>{bar}<span>bar</span></button>
          )}
          <button type="button" className={s.pBtn} aria-label={az.pressureUp} {...inc}>
            <Icon id="plus" />
          </button>
        </div>
      </div>
      {dirty && (
        <div className={s.pressureConfirm}>
          <button type="button" className={s.pConfirm} onClick={() => onCommit(bar)} title={az.pressureConfirmHint}>
            <Icon id="check" /><span>{az.pressureConfirm}</span>
          </button>
          <button type="button" className={s.pCancel} aria-label={az.cancel} title={az.cancel} onClick={() => setBar(value)}>
            <Icon id="close" />
          </button>
        </div>
      )}
    </div>
  )
}

// One big glanceable monitoring card. The dominant element is the contact clock (time since last
// Funkkontakt) with a large Kontakt reset; the inline Druck control + an expandable Verlauf log
// sit below, and the lifecycle actions run along the bottom.
function TruppCard({
  t, live, now, canEdit, intervalMin, graceSec, onContact, onPressure, onStatus, onEdit, onReenter, onDelete, onRestore, onPlace, onShowPlan,
}: {
  t: Trupp; live: TruppLive; now: number; canEdit: boolean
  intervalMin: number; graceSec: number
  onContact: (id: string) => void
  onPressure: (id: string, bar: number) => void
  onStatus: (id: string, status: Trupp['status']) => void
  onEdit: () => void
  onReenter: () => void
  onDelete: (id: string) => void
  onRestore: (t: Trupp) => void
  onPlace: (id: string) => void
  onShowPlan: (id: string) => void
}) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  const status = live.status
  const statusLabel = az.status[status] ?? status
  const [logOpen, setLogOpen] = useState(false)
  const inField = t.status === 'aktiv' || t.status === 'rueckzug'
  const auftrag = auftragTypeLabel(t)
  const sev = contactSeverity(live.sinceContactSec, intervalMin, graceSec)
  // the clock's OWN state as a word — so green-number-on-amber-card parses instantly and the
  // signal survives colourblindness / a muted alarm (not colour alone)
  const clockState = sev >= 2 ? az.clockOverdue : sev === 1 ? az.clockWarn : az.clockOk
  const dz = atemschutzDoctrine()
  const lowPressure = live.currentBar <= dz.mindestBar
  // Planungshilfe: measured consumption history wins; the configured assumption is used only
  // until enough confirmed Druck values exist. It never replaces a reading or drives an alarm.
  const estimate = inField ? estimatePressure(t, now, dz.cylinderLiters, dz.estConsumptionLPerMin) : null
  const readings = t.readings ?? []

  // «Raus» happens immediately with a Rückgängig toast (house rule: confirm-with-undo, no
  // blocking dialog). The undo lives in the action (setTruppStatus) so it restores the full
  // pre-raus Trupp — status + clocks — not just re-open a dead-ended card.
  const askExit = () => onStatus(t.id, 'raus')
  // delete-now + Rückgängig toast (house rule: confirm-with-undo, no blocking dialog).
  // The captured Trupp restores with its full record; only the plan/map placement is gone.
  const doDelete = () => {
    const snapshot = t
    onDelete(t.id)
    toast(fillTemplate(az.removedToast, { name: t.name }), {
      icon: 'trash',
      action: { label: appConfig.copy.undo, onClick: () => onRestore(snapshot) },
    })
  }

  return (
    <div className={cx(s.card, s[`st-${status}`])}>
      <div className={s.cardBanner}>
        <span className={s.statusDot} />
        <span className={s.statusLabel}>{statusLabel}</span>
        {canEdit && status !== 'raus' && (
          <button className={s.iconBtn} aria-label={az.edit} title={az.edit} onClick={onEdit}>
            <Icon id="pen" />
          </button>
        )}
        {(t.annoId || t.entityId) ? (
          <button className={s.iconBtn} aria-label={t.entityId ? az.showOnMap : az.showOnPlan} title={t.entityId ? az.showOnMap : az.showOnPlan} onClick={() => onShowPlan(t.id)}>
            <Icon id={t.entityId ? 'map' : 'doc'} />
          </button>
        ) : canEdit && status !== 'raus' && (
          <button className={s.iconBtn} aria-label={az.place} title={az.place} onClick={() => onPlace(t.id)}>
            <Icon id="footprint" />
          </button>
        )}
        {canEdit && (
          <button className={`${s.iconBtn} ${s.danger}`} aria-label={az.remove} title={az.remove} onClick={doDelete}>
            <Icon id="trash" />
          </button>
        )}
      </div>

      <div className={s.cardName}>
        <span className={s.nameStatic}>{t.name}</span>
        {!!t.members?.filter(Boolean).length && (
          <div className={s.members}>{t.members.filter(Boolean).join(' · ')}</div>
        )}
        {(auftrag || t.ziel || t.lineNumber || t.funkkanal != null) && (
          <div className={s.tags}>
            {auftrag && <span className={cx(s.tag, s.tagAuftrag)}>{auftrag}</span>}
            {t.ziel && <span className={s.tagZiel}>{t.ziel}</span>}
            {t.lineNumber && <span className={s.tag}>{az.lineField} {t.lineNumber}</span>}
            {t.funkkanal != null && <span className={s.tag}>Kanal {t.funkkanal}</span>}
          </div>
        )}
      </div>

      {t.status === 'angemeldet' ? (
        <div className={s.preEntry}>{az.preEntryHint}</div>
      ) : (
        <div className={s.contactWrap}>
          <div
            className={cx(s.contactClock, sev === 1 && s.contactWarn, sev >= 2 && s.contactCrit)}
            role="status" aria-live={sev >= 2 ? 'assertive' : 'polite'}
            aria-label={`${clockState} — ${fmtClock(live.sinceContactSec)} ${az.sinceContact}`}
          >
            <div className={s.contactState}>{clockState}</div>
            <div className={s.contactVal}>{fmtClock(live.sinceContactSec)}</div>
            <div className={s.contactLbl}>{az.sinceContact}</div>
          </div>
          {canEdit && inField && (
            <button className={cx(s.kontaktBtn, sev === 1 && s.kontaktWarn, sev >= 2 && s.kontaktCrit)} onClick={() => onContact(t.id)}>
              <Icon id="radio" /><span>{az.actContact}</span>
            </button>
          )}
        </div>
      )}

      <div className={s.meta}>
        {t.entryTime && (
          <div className={s.metaRow}>
            <span>{az.elapsed}</span>
            <b>{fmtClock(live.elapsedSec)}</b>
          </div>
        )}
        {estimate && (
          <div className={cx(s.metaRow, s.metaEstimate)} title={estimate.source === 'history'
            ? az.estimatedHintHistory
            : fillTemplate(az.estimatedHint, { liters: dz.cylinderLiters, rate: dz.estConsumptionLPerMin })}>
            <span>{az.estimated}</span>
            <span className={s.metaEstimateValue}>
              <b className={s.metaEst}>≈ {estimate.bar} bar</b>
              <small>{estimate.source === 'history'
                ? fillTemplate(az.estimatedSourceHistory, { count: estimate.sampleCount, time: fmtTime(estimate.basedAt) })
                : fillTemplate(az.estimatedSourceFallback, { rate: dz.estConsumptionLPerMin, time: fmtTime(estimate.basedAt) })}</small>
            </span>
          </div>
        )}
        {canEdit && inField ? (
          <PressureInline key={snapBar(live.currentBar)} value={snapBar(live.currentBar)} onCommit={(bar) => onPressure(t.id, bar)} />
        ) : (
          <div className={s.metaRow}>
            <span>{az.currentPressure}</span>
            <b className={cx(lowPressure && s.metaAlarm)}>{live.currentBar} bar</b>
          </div>
        )}
        {live.lowestBar < live.currentBar && (
          <div className={s.metaRow}>
            <span>{az.lowestPressure}</span>
            <b>{live.lowestBar} bar</b>
          </div>
        )}
        {readings.length > 0 && (
          <div className={s.log}>
            <button className={s.logToggle} onClick={() => setLogOpen((o) => !o)} aria-expanded={logOpen}>
              <Icon id="history" /><span>{az.verlauf}</span>
              <Icon id={logOpen ? 'chevron-down' : 'chevron'} className={s.logChev} />
            </button>
            {logOpen && (
              <ul className={s.logList}>
                {[...readings].reverse().map((r, i) => (
                  <li key={readings.length - i} className={s.logRow}>
                    <span className={s.logTime}>{fmtTime(r.t)}</span>
                    <span className={s.logBar}>{r.bar} bar</span>
                    <span className={s.logKind}>{az.readingKind[r.kind] ?? r.kind}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {canEdit && t.status === 'angemeldet' && (
        <div className={s.actions}>
          <button className={cx(s.actBtn, s.actEnter)} onClick={() => onStatus(t.id, 'aktiv')}>
            <Icon id="flag" /><span>{az.actEnter}</span>
          </button>
        </div>
      )}
      {canEdit && inField && (
        <div className={s.actions}>
          {t.status === 'aktiv' ? (
            <button className={cx(s.actBtn, s.actRueckzug)} onClick={() => onStatus(t.id, 'rueckzug')}>
              <Icon id="undo" /><span>{az.actRueckzug}</span>
            </button>
          ) : (
            <button className={cx(s.actBtn, s.actContinue)} onClick={() => onStatus(t.id, 'aktiv')}>
              <Icon id="redo" /><span>{az.actContinue}</span>
            </button>
          )}
          <button className={cx(s.actBtn, s.actExit)} onClick={askExit}>
            <Icon id="logout" /><span>{az.actExit}</span>
          </button>
        </div>
      )}
      {status === 'raus' && (
        <>
          {t.exitTime && <div className={s.exitedNote}>{az.status.raus}: {fmtTime(t.exitTime)}</div>}
          {canEdit && (
            <div className={s.actions}>
              <button className={cx(s.actBtn, s.actReenter)} onClick={onReenter}>
                <Icon id="flag" /><span>{az.actReenter}</span>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// One shared single-screen form for create / edit / re-deploy (3am tenet: no multi-step wizard).
// Leads with the AUFTRAG (what the Trupp is sent to do — the order you check them against on every
// Kontakt), then the Trupp; the Druck section shows only when a fresh cylinder is involved
// (create + re-deploy), never on a plain edit where the live pressure must not be disturbed.
function TruppForm({
  mode, initial, roster, defaultFunkkanal, personnel, presentIds, assignedIds, onCancel, onSubmit,
}: {
  mode: FormMode
  initial?: Trupp
  roster: string[]
  defaultFunkkanal: number
  personnel: Person[]
  presentIds: Set<string>
  assignedIds: Set<string>
  onCancel: () => void
  onSubmit: (f: TruppFields) => void
}) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  const [auftrag, setAuftrag] = useState<Trupp['auftrag'] | null>(initial?.auftrag ?? null)
  const [ziel, setZiel] = useState(initial?.ziel ?? '')
  const [lineNumber, setLineNumber] = useState(initial?.lineNumber ?? '')
  const [funkkanal, setFunkkanal] = useState<number>(initial?.funkkanal ?? defaultFunkkanal)
  const [leader, setLeader] = useState<Slot>({ name: initial?.name ?? '', personId: initial?.leaderPersonId })
  const [members, setMembers] = useState<Slot[]>(
    initial?.members?.length
      ? initial.members.map((m, i) => ({ name: m, personId: initial.memberPersonIds?.[i] }))
      : [{ name: '' }, { name: '' }], // default Trupp = 1 Truppführer + 2 AdF
  )
  // a fresh cylinder for create / re-deploy; edit never touches pressure
  const [pressure, setPressure] = useState<number>(() => {
    const dz = atemschutzDoctrine()
    return mode === 'edit' ? (initial?.entryPressureBar ?? dz.defaultPressureBar) : dz.defaultPressureBar
  })
  // No autofocus: on a tablet the on-screen keyboard would immediately cover the form's other
  // fields. The EL taps the field they want first.
  // Esc closes the form (keyboard parity with the scrim/close-button)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const showPressure = mode !== 'edit'
  const isAnderes = auftrag === 'anderes'
  const auftragOk = !!auftrag && (!isAnderes || ziel.trim().length > 0)
  // a linked person already deployed in another active Trupp blocks submit (one person, one Trupp)
  const assignedConflict = useMemo(() => {
    for (const sl of [leader, ...members]) {
      if (sl.personId && assignedIds.has(sl.personId)) return sl.name.trim() || 'Diese Person'
    }
    return null
  }, [leader, members, assignedIds])
  const canSubmit = auftragOk && leader.name.trim().length > 0 && (!showPressure || pressure > 0) && !assignedConflict

  // names/ids already chosen in this form — excluded from the other slots' dropdowns
  const usedNames = new Set([leader.name.trim(), ...members.map((m) => m.name.trim())].filter(Boolean))
  const usedIds = new Set([leader.personId, ...members.map((m) => m.personId)].filter(Boolean) as string[])

  const submit = () => {
    if (!canSubmit) return
    const cleanMembers = members.filter((m) => m.name.trim())
    const memberPersonIds = cleanMembers.map((m) => m.personId).filter(Boolean) as string[]
    onSubmit({
      name: leader.name.trim(),
      members: cleanMembers.length ? cleanMembers.map((m) => m.name.trim()) : undefined,
      auftrag: auftrag ?? undefined,
      ziel: ziel.trim() || undefined,
      lineNumber: lineNumber.trim() || undefined,
      funkkanal: Number.isFinite(funkkanal) ? funkkanal : undefined,
      pressure,
      leaderPersonId: leader.name.trim() ? leader.personId : undefined,
      memberPersonIds: memberPersonIds.length ? memberPersonIds : undefined,
    })
  }

  const title = mode === 'edit' ? az.formEditTitle : mode === 'redeploy' ? az.formRedeployTitle : az.formCreateTitle
  const submitLabel = mode === 'edit' ? az.save : mode === 'redeploy' ? az.reenterSubmit : az.start

  // portal to <body> so the modal escapes the .surface stacking context (z-index 20) and covers
  // the TopBar ("+ Eintrag", z-index 40) instead of rendering beneath it
  return (
    <Overlay open onClose={onCancel} className={s.modal} ariaLabel={title}>
      <div className={s.modalHead}>
        <h3>{title}</h3>
        <button className={s.iconBtn} aria-label={az.cancel} onClick={onCancel}><Icon id="close" /></button>
      </div>

        <div className={s.modalBody}>
          <div className={s.formCol}>
            <div className={s.formSection}>{az.sectionAuftrag}</div>
            <div className={s.field}>
              <span>{az.auftragLabel}</span>
              <Segmented
                ariaLabel={az.auftragLabel}
                value={auftrag ?? undefined}
                onChange={(v) => setAuftrag(v)}
                options={cfg.auftrag.map((a) => ({ value: a.id, label: az.auftragLabels[a.id] ?? a.label }))}
              />
            </div>
            <label className={s.field}>
              <span>{az.zielLabel}</span>
              <input
                value={ziel} placeholder={isAnderes ? az.zielOtherPlaceholder : az.zielPlaceholder}
                onChange={(e) => setZiel(e.target.value)}
              />
            </label>
            <label className={s.field}>
              <span>{az.lineNumberLabel}</span>
              <input value={lineNumber} placeholder={az.lineNumberPlaceholder} onChange={(e) => setLineNumber(e.target.value)} />
            </label>
          </div>

          <div className={s.formCol}>
            <div className={s.formSection}>{az.sectionTeam}</div>
            <PersonField
              label={az.leaderLabel} placeholder={az.leaderPlaceholder}
              value={leader} onChange={setLeader}
              personnel={personnel} legacyRoster={roster} presentIds={presentIds} assignedIds={assignedIds}
              usedIds={usedIds} usedNames={usedNames}
            />
            {members.map((m, i) => (
              <PersonField
                key={i} label={`${az.memberLabel} ${i + 1}`} placeholder={az.memberPlaceholder}
                value={m} onChange={(slot) => setMembers((ms) => ms.map((x, j) => (j === i ? slot : x)))}
                personnel={personnel} legacyRoster={roster} presentIds={presentIds} assignedIds={assignedIds}
                usedIds={usedIds} usedNames={usedNames}
              />
            ))}
            <button className={s.linkBtn} onClick={() => setMembers((ms) => [...ms, { name: '' }])}>
              <Icon id="plus" /><span>{az.addMember}</span>
            </button>
          </div>

          {assignedConflict && (
            <p className={cx(s.formColWide, s.formWarn)}>
              <Icon id="warn" /><span>{fillTemplate(az.assignedConflict, { name: assignedConflict })}</span>
            </p>
          )}

          <div className={s.formColWide}>
            <div className={s.formSection}>{az.funkkanalSection}</div>
            <div className={s.field}>
              <FunkkanalStepper value={funkkanal} onChange={setFunkkanal} />
            </div>
          </div>

          {showPressure && (
            <div className={s.formColWide}>
              <div className={s.formSection}>{mode === 'redeploy' ? az.newPressureLabel : az.pressureLabel}</div>
              <div className={s.field}>
                <PressureStepper value={pressure} onChange={setPressure} />
              </div>
            </div>
          )}
        </div>

      <div className={s.modalFoot}>
        <button className={s.ghostBtn} onClick={onCancel}>{az.cancel}</button>
        <button className={s.primaryBtn} disabled={!canSubmit} onClick={submit}>{submitLabel}</button>
      </div>
    </Overlay>
  )
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
}
