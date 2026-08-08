import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { confirmDialog, toast } from '../lib/ui'
import { cx } from '../lib/cx'
import { Segmented } from './Segmented'
import { Stepper } from './Stepper'
import { Menu, Overlay } from '../lib/overlays'
import { contactSeverity, deriveTruppLive, estimatePressure, fmtClock, pressureAlarm, type TruppLive } from '../lib/atemschutz'
import type { AttendanceState, Person, Trupp, TruppFields } from '../types'
import { abbreviateName, assignedPersonIds } from '../lib/personnel'
import { truppLineNo, type LeitungOption } from '../lib/truppLines'
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

/** How the board is arranged — mirrors Prefs.atemschutzOrder. */
export type TruppOrder = 'dringlichkeit' | 'manuell' | 'auftrag' | 'name'

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
  trupps, truppColors, canEdit, personnel, attendance, muted, onToggleMuted, order = 'dringlichkeit', onOrder, onMove, createTrupp, placeTrupp, placeTargets, focusTruppOnPlan, recordContact, recordPressure, setTruppStatus, editTrupp, reactivateTrupp, deleteTrupp, restoreTrupp, leitungOptions, showTruppLine, truppsWithLine, pickTruppLine, unlinkTruppLine,
  intervalMin = atemschutzDoctrine().contactIntervalMin, graceSec = atemschutzDoctrine().contactGraceSec,
  defaultFunkkanal = atemschutzDoctrine().defaultFunkkanal,
}: {
  trupps: Trupp[]
  /** trupp id → the colour it wears on the Lage / plan (useTruppActions · truppColors). Missing
   *  for a Trupp that is neither placed nor deliberately coloured — its automatic colour is only
   *  settled at placement. */
  truppColors: Record<string, string>
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
  /** how the board is arranged (device pref) — überfällig floats regardless, see sortTrupps */
  order?: TruppOrder
  onOrder?: (o: TruppOrder) => void
  /** move a card one slot in the hand-set order; only offered while that order is the one shown */
  onMove?: (id: string, dir: -1 | 1) => void
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
  /** `standby` re-registers the Trupp as Reserve (angemeldet) instead of sending it straight in */
  reactivateTrupp: (id: string, f: TruppFields, standby?: boolean) => void
  deleteTrupp: (id: string) => void
  /** undo for deleteTrupp — re-adds the captured Trupp (minus its removed placement) */
  restoreTrupp: (t: Trupp) => void
  /** the drawn Leitungen offered in the form, excluding the edited Trupp's own from «taken» */
  leitungOptions: (exceptTruppId?: string) => LeitungOption[]
  /** jump to the Leitung a Trupp works on (Lage or Plan) */
  showTruppLine: (id: string) => void
  /** ids of Trupps whose Leitung is actually drawn somewhere */
  truppsWithLine: ReadonlySet<string>
  /** arm «Leitung wählen»: the next tap on a hose line (Lage or Plan) links it to this Trupp */
  pickTruppLine: (id: string) => void
  /** release a Trupp's Leitung — used when another Trupp takes it over (confirmed Ablösung) */
  unlinkTruppLine: (id: string) => void
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
  /**
   * How the board is arranged. Whatever is chosen, ÜBERFÄLLIG still floats to the top: a card
   * that can hide off-screen is the one failure mode this screen exists to prevent, and it is not
   * a preference. Below that line:
   *   · «wie gesetzt»  — the hand-set order (Trupp.order, synced), so a card keeps its slot and
   *                      «Trupp 2 is the second one» stays true for the whole Einsatz
   *   · «Dringlichkeit» — longest since Funkkontakt first (what the board always did)
   *   · «Auftrag» / «Name» — for a board big enough to look things up in
   * The MODE is per-device (a way of looking); the hand-set order is synced (it is data).
   */
  const orderKey = (t: Trupp) => trupps.findIndex((x) => x.id === t.id)
  const sortTrupps = (list: Trupp[]) => [...list].sort((a, b) => {
    const overdue = Number(live.get(b.id)?.status === 'ueberfaellig') - Number(live.get(a.id)?.status === 'ueberfaellig')
    if (overdue) return overdue
    if (order === 'name') return a.name.localeCompare(b.name, 'de') || orderKey(a) - orderKey(b)
    if (order === 'auftrag') {
      return (auftragTypeLabel(a) ?? '￿').localeCompare(auftragTypeLabel(b) ?? '￿', 'de') || orderKey(a) - orderKey(b)
    }
    if (order === 'dringlichkeit') {
      const sev = (live.get(b.id)?.sinceContactSec ?? -1) - (live.get(a.id)?.sinceContactSec ?? -1)
      if (sev) return sev
    }
    return (a.order ?? orderKey(a)) - (b.order ?? orderKey(b))
  })
  const activeTrupps = sortTrupps(trupps.filter((t) => t.status !== 'raus'))
  const done = sortTrupps(trupps.filter((t) => t.status === 'raus'))

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

  const submitForm = async (f: TruppFields, standby = false) => {
    if (!form) return
    // One Leitung, one Trupp. Typing a number that someone else is already on used to save
    // silently and leave two Trupps claiming one hose — the tag then picked one of them and the
    // Überwacher had no way of knowing. Name both and let the operator decide: a takeover IS the
    // normal case (Ablösung), it just has to be said out loud. Cancel returns to the form with
    // everything still typed.
    const clash = f.lineNo == null ? undefined
      : trupps.find((t) => t.id !== form.trupp?.id && t.status !== 'raus' && truppLineNo(t) === f.lineNo)
    if (clash) {
      const ok = await confirmDialog({
        title: fillTemplate(az.lineTakeTitle, { n: String(f.lineNo) }),
        message: fillTemplate(az.lineTakeMsg, { n: String(f.lineNo), from: clash.name, to: f.name }),
        confirmLabel: az.lineTakeConfirm,
        cancelLabel: appConfig.copy.cancel,
      })
      if (!ok) return
      unlinkTruppLine(clash.id) // the previous Trupp lets go — its Leitung is now this one's
    }
    if (form.mode === 'create') {
      createTrupp({
        id: `tr${Date.now()}`,
        name: f.name, members: f.members, auftrag: f.auftrag, ziel: f.ziel, lineNo: f.lineNo, funkkanal: f.funkkanal,
        leaderPersonId: f.leaderPersonId, memberPersonIds: f.memberPersonIds,
        entryPressureBar: f.pressure, entryTime: '', lastContactTime: '', lowestBar: f.pressure,
        status: 'angemeldet', readings: [],
      })
    } else if (form.mode === 'edit' && form.trupp) {
      editTrupp(form.trupp.id, f)
    } else if (form.mode === 'redeploy' && form.trupp) {
      reactivateTrupp(form.trupp.id, f, standby)
    }
    setForm(null)
  }

  const cards = (list: Trupp[]) => list.map((t) => (
    <TruppCard
      key={t.id} t={t} live={live.get(t.id)!} now={now} color={truppColors[t.id]} canEdit={canEdit} intervalMin={intervalMin} graceSec={graceSec}
      onContact={recordContact} onPressure={recordPressure} onStatus={setTruppStatus}
      onEdit={() => openForm('edit', t)} onReenter={() => openForm('redeploy', t)}
      onDelete={deleteTrupp} onRestore={restoreTrupp} onPlace={handlePlace} onShowPlan={focusTruppOnPlan}
      onMove={order === 'manuell' ? onMove : undefined}
      onPickLine={pickTruppLine}
      onShowLine={showTruppLine} hasLine={truppsWithLine.has(t.id)}
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
        {/* ⚠️ A MENU, not a segmented control. Four options laid out in full needed ~380px in a
            header that also carries a title, a subtitle, an überfällig badge, the alarm toggle and
            «Neuer Trupp» — so it grew over the subtitle and covered the sentence explaining what
            the board is. A way of LOOKING at the board is not worth a permanent strip of the one
            screen that exists to show overdue Trupps; behind its own icon it costs 44px and the
            current choice still shows as a tick when it is opened. */}
        {trupps.length > 1 && onOrder && (
          <Menu
            trigger={
              <button type="button" className={s.orderBtn} aria-label={az.orderLabel} title={az.orderLabel}>
                <Icon id="filter" />
              </button>
            }
            popupClassName="rp-print-menu"
            itemClassName={() => 'rp-print-menu-item'}
            items={[
              { kind: 'head' as const, label: az.orderLabel },
              {
                kind: 'radio' as const,
                value: order,
                onChange: (v: string) => onOrder(v as TruppOrder),
                options: [
                  { value: 'dringlichkeit', label: az.orderUrgency },
                  { value: 'manuell', label: az.orderManual },
                  { value: 'auftrag', label: az.orderAuftrag },
                  { value: 'name', label: az.orderName },
                ],
              },
            ]}
          />
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
          leitungOptions={leitungOptions(form.trupp?.id)}
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
      <button type="button" className={s.stepBtn} aria-label={fillTemplate(az.pressureDown, { step: dz.pressureStep })} {...dec}>
        <Icon id="minus" />
      </button>
      {edit.editing ? (
        <div className={s.stepVal}><input className={s.stepInput} {...edit.inputProps} /><span>bar</span></div>
      ) : (
        <button type="button" className={s.stepVal} onClick={() => edit.start(value)} title={appConfig.copy.stepper.typeToEnter}><b>{value}</b><span>bar</span></button>
      )}
      <button type="button" className={s.stepBtn} aria-label={fillTemplate(az.pressureUp, { step: dz.pressureStep })} {...inc}>
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
  // flag the PENDING value too, so the Überwacher sees «that reading is at the Alarmdruck»
  // while dialling it in – before committing, not after
  const low = pressureAlarm(bar, dz.alarmBar)
  return (
    <div className={s.pressureBlock}>
      <div className={s.pressureRow}>
        <span className={s.pressureLbl}>{az.currentPressure}</span>
        <div className={s.pressureCtl}>
          <button type="button" className={s.pBtn} aria-label={fillTemplate(az.pressureDown, { step: dz.pressureStep })} {...dec}>
            <Icon id="minus" />
          </button>
          {edit.editing ? (
            <span className={cx(s.pVal, dirty && s.pPending, low && s.metaAlarm)}><input className={s.pInput} {...edit.inputProps} /><span>bar</span></span>
          ) : (
            <button type="button" className={cx(s.pVal, s.pValBtn, dirty && s.pPending, low && s.metaAlarm)} onClick={() => edit.start(bar)} title={appConfig.copy.stepper.typeToEnter}>{bar}<span>bar</span></button>
          )}
          <button type="button" className={s.pBtn} aria-label={fillTemplate(az.pressureUp, { step: dz.pressureStep })} {...inc}>
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
  t, live, now, color, canEdit, intervalMin, graceSec, onContact, onPressure, onStatus, onEdit, onReenter, onDelete, onRestore, onPlace, onShowPlan, onMove, onPickLine, onShowLine, hasLine,
}: {
  t: Trupp; live: TruppLive; now: number; canEdit: boolean
  /** the colour this Trupp wears on the Lage / plan (useTruppActions · truppColors); absent while
   *  it is neither placed nor deliberately coloured */
  color?: string
  intervalMin: number; graceSec: number
  onContact: (id: string) => void
  onPressure: (id: string, bar: number) => void
  onStatus: (id: string, status: Trupp['status']) => void
  onEdit: () => void
  onReenter: () => void
  onDelete: (id: string) => void
  /** present only while the hand-set order is the one on screen (see AtemschutzView) */
  onMove?: (id: string, dir: -1 | 1) => void
  onRestore: (t: Trupp) => void
  onPlace: (id: string) => void
  onShowPlan: (id: string) => void
  /** start «Leitung wählen» — the next tap on a hose (Lage or Plan) links it to this Trupp */
  onPickLine: (id: string) => void
  /** jump to the drawn Leitung (Lage or Plan) — the counterpart of «auf Plan zeigen» */
  onShowLine: (id: string) => void
  /** is there actually a hose drawn for this Trupp? Decides whether the chip is a jump or plain
   *  text — a button that goes nowhere is worse than no button. */
  hasLine: boolean
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
  // Planungshilfe: measured consumption history wins; the configured assumption is used only
  // until enough confirmed Druck values exist. It never replaces a reading or drives an alarm.
  const estimate = inField ? estimatePressure(t, now, dz.cylinderLiters, dz.estConsumptionLPerMin) : null
  const readings = t.readings ?? []
  // Alarmdruck – EITHER the logged Druck or the expected-pressure Schätzung is enough. Air burns
  // down between radio checks, so a reading that still looked fine at the last Kontakt is exactly
  // how a Trupp slips past its turn-back pressure unnoticed. Visual only: the contact clock stays
  // the single audible alarm (see lib/atemschutz).
  const pressureLow = pressureAlarm(live.currentBar, dz.alarmBar)
  const estimateLow = pressureAlarm(estimate?.bar ?? null, dz.alarmBar)
  const airLow = inField && (pressureLow || estimateLow)
  // name the source when ONLY the projection has crossed – an estimate must never read as a
  // logged measurement (same rule the Schätzung row itself follows)
  const airNote = !airLow ? null
    : fillTemplate(pressureLow ? az.alarmNote : az.alarmNoteEst, { bar: dz.alarmBar })

  // The Leitung chip: the numeric field, else the free text an older record still carries. Shown
  // as typed either way — an incident is a legal record, so nothing rewrites what was entered.
  const lineTag = t.lineNo != null ? String(t.lineNo) : t.lineNumber?.trim()

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
        {/* The actions ride in their own group so they wrap as a block if a card ever gets narrow
            enough — the status word must never be the thing that gets abbreviated. */}
        <div className={s.cardActs}>
          {/* Only while the hand-set order is the one on screen: moving a card under any other
              sort would rearrange something the sort is about to rearrange back. */}
          {onMove && canEdit && (
            <>
              <button className={s.iconBtn} aria-label={az.moveBack} title={az.moveBack} onClick={() => onMove(t.id, -1)}>
                <Icon id="chevron-left" />
              </button>
              <button className={s.iconBtn} aria-label={az.moveForward} title={az.moveForward} onClick={() => onMove(t.id, 1)}>
                <Icon id="chevron" />
              </button>
            </>
          )}
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
          {/* The Leitung this Trupp works on — the same shape as the placement button above it:
              nothing drawn yet ⇒ pick one, drawn ⇒ GO there. Letting go of a Leitung is not an
              icon: it is clearing the number in the form (or «Kein Trupp» on the line itself),
              which is where the operator already is when they change their mind. */}
          {hasLine ? (
            <button className={s.iconBtn} aria-label={az.lineShow} title={az.lineShow} onClick={() => onShowLine(t.id)}>
              <Icon id="drop" />
            </button>
          ) : canEdit && status !== 'raus' && (
            <button className={s.iconBtn} aria-label={az.linePick} title={az.linePick} onClick={() => onPickLine(t.id)}>
              <Icon id="drop" />
            </button>
          )}
          {canEdit && (
            <button className={`${s.iconBtn} ${s.danger}`} aria-label={az.remove} title={az.remove} onClick={doDelete}>
              <Icon id="trash" />
            </button>
          )}
        </div>
      </div>

      <div className={s.cardName}>
        {/* the colour this Trupp wears on the Lage / plan, so the card and the symbol out there
            read as the same Trupp. Absent while the colour is still automatic AND unplaced —
            that one is only settled at placement, and a guess here would change under them. */}
        <div className={s.nameRow}>
          {color && <span className={s.nameDot} style={{ background: color }} aria-hidden />}
          <span className={s.nameStatic}>{t.name}</span>
        </div>
        {!!t.members?.filter(Boolean).length && (
          <div className={s.members}>{t.members.filter(Boolean).join(' · ')}</div>
        )}
        {(auftrag || t.ziel || lineTag || t.funkkanal != null) && (
          <div className={s.tags}>
            {auftrag && <span className={cx(s.tag, s.tagAuftrag)}>{auftrag}</span>}
            {t.ziel && <span className={s.tagZiel}>{t.ziel}</span>}
            {/* the numeric Leitung, else the free text an older record still carries verbatim */}
            {lineTag && (hasLine ? (
              <button type="button" className={cx(s.tag, s.tagGo)} title={az.lineShow} onClick={() => onShowLine(t.id)}>
                {az.lineField} {lineTag}<Icon id="chevron" />
              </button>
            ) : (
              <span className={s.tag}>{az.lineField} {lineTag}</span>
            ))}
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

      {airNote && (
        <div className={s.airNote} role="status" aria-live="polite">
          <Icon id="warn" /><span>{airNote}</span>
        </div>
      )}

      <div className={s.meta}>
        {t.entryTime && (
          <div className={s.metaRow}>
            <span>{az.elapsed}</span>
            <b>{fmtClock(live.elapsedSec)}</b>
          </div>
        )}
        {/* The break clock. Once a Trupp is out its Einsatzzeit is finished and stands still —
            what the Überwacher needs from then on is how long the crew has been resting before
            it can be sent in again, so that is the number that keeps running. */}
        {live.outSec != null && (
          <div className={s.metaRow}>
            <span>{az.outFor}</span>
            <b>{fmtClock(live.outSec)}</b>
          </div>
        )}
        {estimate && (
          <div className={cx(s.metaRow, s.metaEstimate)} title={estimate.source === 'history'
            ? az.estimatedHintHistory
            : fillTemplate(az.estimatedHint, { liters: dz.cylinderLiters, rate: dz.estConsumptionLPerMin })}>
            <span className={s.metaEstLabel}>{az.estimated}</span>
            <b className={cx(s.metaEst, estimateLow && s.metaAlarm)}>≈ {estimate.bar} bar</b>
            <small className={s.metaEstSource}>{estimate.source === 'history'
              ? fillTemplate(az.estimatedSourceHistory, { count: estimate.sampleCount, time: fmtTime(estimate.basedAt) })
              : fillTemplate(az.estimatedSourceFallback, { rate: dz.estConsumptionLPerMin, time: fmtTime(estimate.basedAt) })}</small>
          </div>
        )}
        {canEdit && inField ? (
          <PressureInline key={snapBar(live.currentBar)} value={snapBar(live.currentBar)} onCommit={(bar) => onPressure(t.id, bar)} />
        ) : (
          <div className={s.metaRow}>
            <span>{az.currentPressure}</span>
            <b className={cx(pressureLow && s.metaAlarm)}>{live.currentBar} bar</b>
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
  mode, initial, roster, defaultFunkkanal, personnel, presentIds, assignedIds, leitungOptions, onCancel, onSubmit,
}: {
  mode: FormMode
  initial?: Trupp
  roster: string[]
  defaultFunkkanal: number
  personnel: Person[]
  presentIds: Set<string>
  assignedIds: Set<string>
  onCancel: () => void
  /** the Leitungen drawn on either surface (lib/truppLines · leitungOptions) — offered as
   *  quick-picks so the number is chosen from what exists, not typed blind */
  leitungOptions: LeitungOption[]
  /** `standby` (re-deploy only) parks the Trupp as Reserve instead of sending it straight in */
  onSubmit: (f: TruppFields, standby?: boolean) => void
}) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  const [auftrag, setAuftrag] = useState<Trupp['auftrag'] | null>(initial?.auftrag ?? null)
  const [ziel, setZiel] = useState(initial?.ziel ?? '')
  // Leitung: numeric since 2026-08-05. A Trupp carrying only the old free text starts empty and
  // keeps that text visible underneath — the record stays as its Überwacher typed it, and a
  // legacy «1» still auto-matches the drawn Leitung 1 (lib/truppLines · truppLineNo).
  const [lineNo, setLineNo] = useState<number | null>(initial?.lineNo ?? null)
  const legacyLine = initial?.lineNo == null ? initial?.lineNumber?.trim() : undefined
  const [funkkanal, setFunkkanal] = useState<number>(initial?.funkkanal ?? defaultFunkkanal)
  // null = automatic (the station colour for this Auftrag, else the next free palette colour).
  // A picked colour is used as picked, duplicates included — see Trupp.color.
  const [color, setColor] = useState<string | null>(initial?.color ?? null)
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

  const submit = (standby = false) => {
    if (!canSubmit) return
    const cleanMembers = members.filter((m) => m.name.trim())
    const memberPersonIds = cleanMembers.map((m) => m.personId).filter(Boolean) as string[]
    onSubmit({
      name: leader.name.trim(),
      members: cleanMembers.length ? cleanMembers.map((m) => m.name.trim()) : undefined,
      auftrag: auftrag ?? undefined,
      ziel: ziel.trim() || undefined,
      lineNo: lineNo ?? undefined,
      funkkanal: Number.isFinite(funkkanal) ? funkkanal : undefined,
      pressure,
      leaderPersonId: leader.name.trim() ? leader.personId : undefined,
      memberPersonIds: memberPersonIds.length ? memberPersonIds : undefined,
      color, // null = automatic
    }, standby)
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
                // caps chosen so the card's one-line Ziel and the Leitung chip can't be blown out:
                // «2. OG Wohnung Nord, 2 Personen vermisst» is 39 chars, a Leitung is «1»–«12»
                maxLength={60}
                onChange={(e) => setZiel(e.target.value)}
              />
            </label>
            {/* The SAME 1–99 number the DrawEditor stamps on a hose — one type on both sides is
                what lets a Trupp and a drawn Leitung find each other without anyone re-typing
                anything (lib/truppLines). A Trupp recorded before this was free text keeps its
                text below; it is never rewritten. */}
            <div className={cx(s.field, s.lineField)}>
              <span>{az.lineNoLabel}</span>
              {/* stepper and the drawn Leitungen share ONE row: the stepper is for a number that
                  isn't drawn yet, the chips are the common case, and stacking them cost three
                  rows of a form that has to fit on a tablet in one glance */}
              <div className={s.lineRow}>
                <Stepper
                  value={lineNo} min={1} max={99} placeholder="–"
                  onChange={setLineNo} onClear={() => setLineNo(null)} canClear={lineNo != null}
                  ariaLabel={az.lineNoLabel}
                />
              {/* The Leitungen that are actually DRAWN. Typing a number blind is how the two sides
                  end up disagreeing — the hose usually exists long before anyone registers the
                  Trupp. A number someone else is on stays pickable (real incidents need
                  corrections) but says whose it is. */}
                {leitungOptions.length > 0 && (
                  <div className={s.lineOpts}>
                    <span className={s.lineOptsLabel}>{az.lineOptsLabel}</span>
                    {leitungOptions.map((o) => (
                      <button
                        key={o.no} type="button"
                        className={cx(s.lineOpt, lineNo === o.no && s.on, !!o.takenBy && s.taken)}
                        title={o.takenBy ? fillTemplate(az.lineOptTaken, { name: o.takenBy }) : undefined}
                        onClick={() => setLineNo(o.no)}
                      >
                        {o.no}{o.onPlan ? ' ·\u00a0P' : ''}{o.takenBy ? ` · ${abbreviateName(o.takenBy)}` : ''}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {legacyLine && <p className={s.fieldNote}>{fillTemplate(az.lineLegacyNote, { value: legacyLine })}</p>}
            </div>
          </div>

          <div className={s.formCol}>
            <div className={s.formSection}>{az.sectionTeam}</div>
            <PersonField
              label={az.leaderLabel} placeholder={az.leaderPlaceholder}
              value={leader} onChange={setLeader}
              personnel={personnel} legacyRoster={roster} presentIds={presentIds} assignedIds={assignedIds}
              usedIds={usedIds} usedNames={usedNames}
            />
            {/* Every AdF row is removable, including the two the form starts with. A Trupp needs
                exactly one name to be valid — the Gruppenführer — so a two-person Trupp, a
                four-person Trupp and a row added by mistake are all reachable from here.
                Removing by INDEX (not by value) so identical empty rows can't collapse together. */}
            {members.map((m, i) => (
              <PersonField
                key={i} label={`${az.memberLabel} ${i + 1}`} placeholder={az.memberPlaceholder}
                value={m} onChange={(slot) => setMembers((ms) => ms.map((x, j) => (j === i ? slot : x)))}
                onRemove={() => setMembers((ms) => ms.filter((_, j) => j !== i))}
                removeLabel={fillTemplate(az.removeMember, { n: i + 1 })}
                personnel={personnel} legacyRoster={roster} presentIds={presentIds} assignedIds={assignedIds}
                usedIds={usedIds} usedNames={usedNames}
              />
            ))}
            <button className={s.linkBtn} onClick={() => setMembers((ms) => [...ms, { name: '' }])}>
              <Icon id="plus" /><span>{az.addMember}</span>
            </button>
            {/* The colour this Trupp wears on the Lage and on the plan. «Automatisch» is the
                normal case (every Trupp a different one); picking is for when the EL would rather
                read the picture by role — «alle Löschtrupps rot» — and a duplicate is then the
                point, not a mistake, so nothing here refuses one. */}
            <div className={s.field}>
              <span>{az.colorLabel}</span>
              <div className={s.colorRow}>
                <button
                  type="button" className={cx(s.colorAuto, color == null && s.on)} aria-pressed={color == null}
                  title={az.colorAutoHint} onClick={() => setColor(null)}
                >{az.colorAuto}</button>
                {appConfig.drawing.teamColors.map((c) => (
                  <button
                    key={c} type="button" className={cx(s.colorDot, color === c && s.on)} style={{ background: c }}
                    aria-label={c} aria-pressed={color === c} onClick={() => setColor(c)}
                  />
                ))}
              </div>
            </div>
          </div>

          {assignedConflict && (
            <p className={cx(s.formColWide, s.formWarn)}>
              <Icon id="warn" /><span>{fillTemplate(az.assignedConflict, { name: assignedConflict })}</span>
            </p>
          )}

          {/* Kanal and Druck side by side where there is room. Each stepper is one short number
              between two big buttons, so full-width rows made the modal scroll for two values
              that fit next to each other — and pushed the confirm button off a laptop screen.
              `auto-fit` rather than a fixed pair: with no Druck (a Trupp that carries none) the
              Kanal simply fills the row instead of leaving a hole beside it. */}
          <div className={s.stepperPair}>
            <div className={s.formCol}>
              <div className={s.formSection}>{az.funkkanalSection}</div>
              <div className={s.field}>
                <FunkkanalStepper value={funkkanal} onChange={setFunkkanal} />
              </div>
            </div>

            {showPressure && (
              <div className={s.formCol}>
                <div className={s.formSection}>{mode === 'redeploy' ? az.newPressureLabel : az.pressureLabel}</div>
                <div className={s.field}>
                  <PressureStepper value={pressure} onChange={setPressure} />
                </div>
              </div>
            )}
          </div>
        </div>

      <div className={s.modalFoot}>
        <button className={s.ghostBtn} onClick={onCancel}>{az.cancel}</button>
        {/* Re-deploy forks here: a re-equipped Trupp is just as often held back as Sicherungstrupp
            as it is sent straight in. Both buttons take the same filled-in form, so the choice
            costs nothing — and «Bereitstellen» is the one that must NOT start a contact clock.
            It is also what actually happens first: a Trupp comes out, gets a fresh bottle and
            waits. So on re-deploy «Bereitstellen» carries the primary weight and «Einrücken»
            steps back — the ORDER stays as it was, only the emphasis swaps, so nobody has to
            re-learn where the button is. */}
        {mode === 'redeploy' && (
          <button className={s.primaryBtn} disabled={!canSubmit} onClick={() => submit(true)} title={az.reenterStandbyHint}>
            {az.reenterStandby}
          </button>
        )}
        <button className={mode === 'redeploy' ? s.secondaryBtn : s.primaryBtn} disabled={!canSubmit} onClick={() => submit()}>{submitLabel}</button>
      </div>
    </Overlay>
  )
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
}
