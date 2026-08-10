import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, stripUnprintable } from '../lib/format'
import { confirmDialog, toast } from '../lib/ui'
import { cx } from '../lib/cx'
import { Segmented } from './Segmented'
import { Stepper } from './Stepper'
import { Menu, Overlay } from '../lib/overlays'
import { contactSeverity, deriveTruppLive, estimatePressure, fmtClock, pressureAlarm, type TruppLive } from '../lib/atemschutz'
import { isPresent } from '../lib/attendanceIntervals'
import { ortOf } from '../lib/attendanceOrt'
import { truppStatusLabel } from '../lib/report'
import type { AttendanceState, Person, Trupp, TruppFields } from '../types'
import { abbreviateName, assignedPersonIds, rosterFromList, rosterIdByName, truppSlots } from '../lib/personnel'
import { truppLineNo, type LeitungOption } from '../lib/truppLines'
import { ClearableInput } from './ClearableInput'
import type { Slot } from './PersonField'
import { TruppTeam } from './TruppTeam'
import { ensureNotifyPermission, unlockAlarm } from '../lib/alarm'
import { atemschutzDoctrine } from '../lib/deploymentConfig'
import { useKeptState } from '../lib/draftKeep'
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
  trupps, truppColors, canEdit, personnel, attendance, muted, onToggleMuted, onAddGuest, order = 'dringlichkeit', onOrder, onMove, createTrupp, placeTrupp, placeTargets, focusTruppOnPlan, recordContact, recordPressure, setTruppStatus, editTrupp, reactivateTrupp, deleteTrupp, restoreTrupp, leitungOptions, showTruppLine, truppsWithLine, pickTruppLine, unlinkTruppLine,
  intervalMin = atemschutzDoctrine().contactIntervalMin, graceSec = atemschutzDoctrine().contactGraceSec,
  defaultFunkkanal = atemschutzDoctrine().defaultFunkkanal,
  focus,
}: {
  trupps: Trupp[]
  /** trupp id → the colour it wears on the Lage / plan (useTruppActions · truppColors). Every
   *  Trupp has an entry: placed colour, then decided colour, then its automatic palette slot. */
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
  /** put a hand-typed Gast on the Anwesenheit — a Gast under PA was at the Einsatz, and a name
   *  that only ever existed on a Trupp card reaches neither the Personalblatt nor the export */
  onAddGuest?: (name: string) => string | undefined
  /** «point at THAT Trupp» — set by a locked Anwesenheit row. The nonce makes a repeat tap point
   *  again; the card scrolls itself into view and flashes, then the mark clears on its own. */
  focus?: { id: string; nonce: number } | null
}) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  // the shared create / edit / re-deploy form — null when closed
  const [form, setForm] = useState<{ mode: FormMode; trupp?: Trupp } | null>(null)
  /**
   * «zeig mir den» from THIS surface — the header's überfällig badge. The `focus` prop covers
   * the jump in from somewhere else (a locked Anwesenheit row); this is the same mark set from
   * inside, so the badge behaves like the app-wide TopBar chip it mirrors instead of being the
   * one warning on the screen that does nothing when you press it.
   *
   * The later nonce wins, so whichever pointed last is the one the board obeys.
   */
  const [selfFocus, setSelfFocus] = useState<{ id: string; nonce: number } | null>(null)
  const activeFocus = (selfFocus?.nonce ?? -1) > (focus?.nonce ?? -1) ? selfFocus : focus
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
  const overdueTrupps = trupps.filter((t) => live.get(t.id)?.status === 'ueberfaellig')
  const overdueCount = overdueTrupps.length
  // the one the badge jumps to: longest out of contact, which is the same card the board's own
  // sort puts at the top — so the jump lands where the eye was already being sent
  const mostOverdue = [...overdueTrupps]
    .sort((a, b) => (live.get(b.id)?.sinceContactSec ?? 0) - (live.get(a.id)?.sinceContactSec ?? 0))[0]
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
  // …and which of them are still at the Magazin. Somebody at the Magazin usually cannot go under
  // PA at all, so the picker says so and sinks them below the crew on scene (see TruppTeam).
  const stationIds = useMemo(
    () => new Set(Object.entries(attendance)
      .filter(([, a]) => isPresent(a) && ortOf(a) === 'station')
      .map(([id]) => id)),
    [attendance],
  )

  // Who is already spoken for: the Bemerkung on their Anwesenheits-Zeile is where a job ends up
  // («Einsatzleiter», «Fahrer TLF» — lib/roleAssignment). Putting the Einsatzleiter under PA is
  // allowed and sometimes right; the picker only says it out loud before it happens.
  const rolesById = useMemo(
    () => new Map(
      Object.entries(attendance)
        .map(([id, a]) => [id, (a.note ?? '').trim()] as const)
        .filter(([, note]) => note.length > 0),
    ),
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
      flash={activeFocus?.id === t.id}
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
        {mostOverdue && (
          /* ⚠️ A BUTTON. It used to be a <div>: the loudest thing on the screen, saying that a
              Trupp is out of contact, and pressing it did nothing — so on a board with eight
              cards the answer to «welcher denn?» was still a scroll. It now points at the same
              card the app-wide TopBar chip points at (the most overdue one, which is also the
              one sortTrupps floats to the top), and a repeat press points again. */
          <button
            type="button" className={s.overdueBadge}
            aria-live="assertive"
            title={fillTemplate(az.overdueBadgeGo, { name: mostOverdue.name })}
            aria-label={fillTemplate(az.overdueBadgeGo, { name: mostOverdue.name })}
            onClick={() => setSelfFocus({ id: mostOverdue.id, nonce: Date.now() })}
          >
            <Icon id="warn" /><span>{az.overdueBadge.replace('{n}', String(overdueCount))}</span>
          </button>
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
          personnel={personnel} presentIds={presentIds} stationIds={stationIds} rolesById={rolesById}
          assignedIds={assignedPersonIds(trupps.filter((t) => t.id !== form.trupp?.id))}
          leitungOptions={leitungOptions(form.trupp?.id)}
          onAddGuest={onAddGuest}
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
function PressureStepper({ value, onChange, compact }: { value: number; onChange: (v: number) => void; compact?: boolean }) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  const dz = atemschutzDoctrine()
  const dec = useHoldRepeat(() => onChange(snapBar(value - dz.pressureStep)))
  const inc = useHoldRepeat(() => onChange(snapBar(value + dz.pressureStep)))
  const edit = useTapToType({ min: 0, max: dz.pressureMax, onCommit: (v) => onChange(snapBar(v)), clamp: snapBar })
  return (
    <div className={cx(s.stepper, compact && s.stepperSmall)}>
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
function FunkkanalStepper({ value, onChange, compact }: { value: number; onChange: (v: number) => void; compact?: boolean }) {
  const az = appConfig.copy.atemschutz
  const dz = atemschutzDoctrine()
  const clamp = (v: number) => Math.max(dz.funkkanalMin, Math.min(dz.funkkanalMax, v))
  const dec = useHoldRepeat(() => onChange(clamp(value - 1)))
  const inc = useHoldRepeat(() => onChange(clamp(value + 1)))
  const edit = useTapToType({ min: dz.funkkanalMin, max: dz.funkkanalMax, onCommit: onChange })
  return (
    <div className={cx(s.stepper, compact && s.stepperSmall)}>
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
  t, live, now, color, canEdit, intervalMin, graceSec, flash, onContact, onPressure, onStatus, onEdit, onReenter, onDelete, onRestore, onPlace, onShowPlan, onMove, onPickLine, onShowLine, hasLine,
}: {
  t: Trupp; live: TruppLive; now: number; canEdit: boolean
  /** the colour this Trupp wears on the Lage / plan (useTruppActions · truppColors) — set for
   *  every Trupp, automatic ones included */
  color?: string
  intervalMin: number; graceSec: number
  onContact: (id: string) => void
  onPressure: (id: string, bar: number) => void
  onStatus: (id: string, status: Trupp['status']) => void
  /** this is the card somebody was just sent to — scroll it under their eyes and mark it */
  flash?: boolean
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
  // «Draussen» on a Trupp that never went under PA claims it came out of something. Only that
  // one word differs — the state, the section and the actions are the same (truppNeverDeployed).
  const statusLabel = status === 'raus' ? truppStatusLabel(t) : (az.status[status] ?? status)
  const [logOpen, setLogOpen] = useState(false)
  // ⚠️ The jump has to LAND. Switching to the Überwachung and leaving a wall of cards was the
  // complaint: on a long list the Trupp somebody was sent to was off-screen, so the answer to
  // «why can I not tick this person» was still a search. `flash` flips false→true per jump
  // (the nonce upstream), so a repeat tap scrolls again.
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!flash) return
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [flash])
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
    <div ref={cardRef} className={cx(s.card, s[`st-${status}`], flash && s.cardFlash)}>
      <div className={s.cardBanner}>
        {/* ⚠️ NO dot in front of the status. A card already carries one coloured disc — the
            Truppfarbe beside the name, which is the Trupp's identity on the Lage and the plan.
            A second disc at the top of the same card, in a status colour, was read as that
            identity: «warum ist Trupp 2 plötzlich grün». The word is the state, the top border
            and the banner tint already carry its colour, and the one dot on the card means the
            one thing. */}
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
            read as the same Trupp. EVERY Trupp has one, the automatically-coloured ones included
            (useTruppActions · truppColors) — a hole in this column read as «no colour» on a board
            where colour is identity. */}
        <div className={s.nameRow}>
          {color && <span className={s.nameDot} style={{ background: color }} aria-hidden />}
          <span className={s.nameStatic}>{t.name}</span>
        </div>
        {!!t.members?.filter(Boolean).length && (
          <div className={s.members}>{t.members.filter(Boolean).join(' · ')}</div>
        )}
        <div className={s.tags}>
            {/* ⚠️ The Auftrag is optional in the form (it must never hold a Trupp at the door),
                so its ABSENCE has to be visible — a Trupp with no job on the card is a question
                the Überwacher has to be able to see, not one nobody thinks to ask. */}
            {auftrag
              ? <span className={cx(s.tag, s.tagAuftrag)}>{auftrag}</span>
              : <button type="button" className={cx(s.tag, s.tagAuftragOpen)} onClick={onEdit}>{az.auftragOpen}</button>}
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
          {/* The Sicherungstrupp that was never needed. Until 08.08. the only way to close one
              was the bin — which throws away the one record that says a crew stood ready, on a
              document that is the legal account of the Einsatz. This closes it like any other
              Trupp: under «Draussen», break clock running, «Wieder einrücken» right there.
              ⚠️ LEFT of «Eingerückt», which is the shape every other pair on this card has:
              the quiet way out on the left, the action the card exists for on the right, under
              the thumb. It read the other way round for one afternoon (09.08.). */}
          <button className={cx(s.actBtn, s.actStandDown)} title={az.actNotDeployedHint}
            onClick={() => onStatus(t.id, 'raus')}>
            <Icon id="logout" /><span>{az.actNotDeployed}</span>
          </button>
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
          {t.exitTime && <div className={s.exitedNote}>{truppStatusLabel(t)}: {fmtTime(t.exitTime)}</div>}
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
  mode, initial, roster, defaultFunkkanal, personnel, presentIds, stationIds, assignedIds, rolesById, leitungOptions, onAddGuest, onCancel, onSubmit,
}: {
  mode: FormMode
  initial?: Trupp
  roster: string[]
  defaultFunkkanal: number
  personnel: Person[]
  presentIds: Set<string>
  stationIds: Set<string>
  assignedIds: Set<string>
  /** who already holds a job on this Einsatz (Anwesenheits-Bemerkung), so the picker can say
   *  «schon: Einsatzleiter» beside a name — a hint, never a block */
  rolesById: Map<string, string>
  onCancel: () => void
  /** the Leitungen drawn on either surface (lib/truppLines · leitungOptions) — offered as
   *  quick-picks so the number is chosen from what exists, not typed blind */
  leitungOptions: LeitungOption[]
  /** record a hand-typed Gast on the Anwesenheit as well — being put in a Trupp IS being here */
  onAddGuest?: (name: string) => string | undefined
  /** `standby` (re-deploy only) parks the Trupp as Reserve instead of sending it straight in */
  onSubmit: (f: TruppFields, standby?: boolean) => void
}) {
  const az = appConfig.copy.atemschutz // read per-render so the resolved locale applies
  // ⚠️ The typed Trupp survives a mis-tap. Only «Abbrechen» throws it away — an ✕ or a tap on
  // the backdrop is «not now», and losing three names and a Ziel to a fat finger at 3am is the
  // expensive half of that pair (see lib/draftKeep, the same rule the Gast name follows).
  const draftKey = `atemschutz:trupp:${mode}:${initial?.id ?? 'new'}`
  // The two roster indexes the slot resolution needs: name → id, and id → Person (to check that
  // a stored positional id really belongs to the name beside it — see lib/personnel · truppSlots).
  const rosterByName = useMemo(() => rosterIdByName(personnel), [personnel])
  const rosterById = useMemo(() => rosterFromList(personnel), [personnel])

  const [auftrag, setAuftrag, clearAuftrag] = useKeptState<Trupp['auftrag'] | null>(`${draftKey}:auftrag`, initial?.auftrag ?? null)
  const [ziel, setZiel, clearZiel] = useKeptState(`${draftKey}:ziel`, initial?.ziel ?? '')
  // Leitung: numeric since 2026-08-05. A Trupp carrying only the old free text starts empty and
  // keeps that text visible underneath — the record stays as its Überwacher typed it, and a
  // legacy «1» still auto-matches the drawn Leitung 1 (lib/truppLines · truppLineNo).
  const [lineNo, setLineNo] = useState<number | null>(initial?.lineNo ?? null)
  const legacyLine = initial?.lineNo == null ? initial?.lineNumber?.trim() : undefined
  const [funkkanal, setFunkkanal] = useState<number>(initial?.funkkanal ?? defaultFunkkanal)
  // null = automatic (the station colour for this Auftrag, else the next free palette colour).
  // A picked colour is used as picked, duplicates included — see Trupp.color.
  const [color, setColor] = useState<string | null>(initial?.color ?? null)
  // ONE list, leader first (see TruppTeam): `team[0]` IS the Gruppenführer, which is also the
  // order the card, the Rapport and the map tag print. The record on disk keeps its old shape
  // (`name` + `members`), so nothing that ever read a Trupp has to change.
  const [team, setTeam, clearTeam] = useKeptState<Slot[]>(
    `${draftKey}:team`,
    initial ? truppSlots(initial, rosterByName, rosterById) : [],
  )
  // ⚠️ …and the KEPT DRAFT gets the same treatment. `useKeptState` restores whatever was in the
  // browser, which on a device that has been open across a roster sync (or across a demo reset)
  // is a team of bare names — so the form re-badged three roster members «Gast» while the Trupp
  // on disk had their ids all along. Re-linking on open is idempotent and never invents an id.
  useEffect(() => {
    const linked = team.map((sl) => (sl.personId ? sl : { ...sl, personId: rosterByName.get(sl.name.trim().toLowerCase()) }))
    if (linked.some((sl, i) => sl.personId !== team[i].personId)) setTeam(linked)
    // once per mount: the roster is stable while a modal is open, and re-running on `team`
    // would fight the operator's own edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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

  // ⚠️ Shown in EVERY mode, including 'edit'. Hiding it there meant a mistyped Eingangsdruck could
  // never be corrected — and it is the number the Verbrauch and the tiefster Druck on the Rapport
  // are measured against. In edit mode it corrects what was recorded; it never counts as a contact.
  const showPressure = true
  const isEdit = mode === 'edit'
  const isAnderes = auftrag === 'anderes'
  // ⚠️ The Auftrag no longer BLOCKS. It is behind the fold now, and a Trupp standing at the door
  // must not wait on a field — the Überwachung exists to run a clock, and the job can be filled
  // in a tap later (the card says «Auftrag offen» until it is). «Anderes» still needs its word:
  // it is a label that says nothing on its own.
  const auftragOk = !isAnderes || ziel.trim().length > 0
  // A linked person already deployed in another active Trupp blocks submit (one person, one
  // Trupp). The picker no longer OFFERS one — but an existing Trupp being edited can still carry
  // somebody who was assigned elsewhere in the meantime, and that has to be sayable.
  const assignedConflict = useMemo(() => {
    for (const sl of team) {
      if (sl.personId && assignedIds.has(sl.personId)) return sl.name.trim() || az.assignedFallbackName
    }
    return null
  }, [team, assignedIds])
  const canSubmit = auftragOk && (team[0]?.name.trim().length ?? 0) > 0 && (!showPressure || pressure > 0) && !assignedConflict

  const dropDraft = () => { clearAuftrag(); clearZiel(); clearTeam() }
  const submit = (standby = false) => {
    if (!canSubmit) return
    dropDraft()
    const cleanMembers = team.slice(1).filter((m) => m.name.trim())
    const memberPersonIds = cleanMembers.map((m) => m.personId).filter(Boolean) as string[]
    onSubmit({
      name: team[0].name.trim(),
      members: cleanMembers.length ? cleanMembers.map((m) => m.name.trim()) : undefined,
      auftrag: auftrag ?? undefined,
      ziel: ziel.trim() || undefined,
      lineNo: lineNo ?? undefined,
      funkkanal: Number.isFinite(funkkanal) ? funkkanal : undefined,
      pressure,
      leaderPersonId: team[0].personId,
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
          {/* ⚠️ ORDER. What starts the clock comes first: who goes in, and with how much air.
              Everything else is refinement and lives one tap away — on a phone the old order put
              five optional fields between the EL and the two mandatory ones. */}
          <div className={s.formCol}>
            <div className={s.field}>
              <span>{az.sectionTeam}</span>
            {/* One list, leader first. A Trupp is valid with exactly one name (the
                Gruppenführer), so a two-person Trupp, a four-person Trupp and a mis-tap are all
                one tap apart — which the three fixed slots could not do. */}
            <TruppTeam
              value={team} onChange={setTeam}
              personnel={personnel} legacyRoster={roster} presentIds={presentIds} stationIds={stationIds}
              assignedIds={assignedIds} rolesById={rolesById} onAddGuest={onAddGuest}
            />
            </div>
          </div>

          <div className={s.formCol}>
            {showPressure && (
              <div className={s.field}>
                <span>{mode === 'redeploy' ? az.newPressureLabel : isEdit ? az.editPressureLabel : az.pressureLabel}</span>
                <PressureStepper value={pressure} onChange={setPressure} compact />
                {/* said out loud, because the same ± on the CARD does the opposite: there it is a
                    Druckmeldung and resets the contact clock. Here it corrects the record. */}
                {isEdit && <p className={s.fieldNote}>{az.editPressureHint}</p>}
              </div>
            )}

            {/* Kanal rides with the Druck: two short numbers between two big buttons, the pair
                you set on every single Trupp. Everything below is the Auftrag — worth having,
                never a reason to hold a Trupp at the door.
                ⚠️ No section headings in here. Uppercase labels over rules cut the form into
                four boxes and each rule cost a row, in a modal sized to a tablet; every field
                already says what it is, and «AUFTRAG» over a field called «Auftrag / Ziel» was
                the same word twice. */}
            <div className={s.field}>
              <span>{az.funkkanalSection}</span>
              <FunkkanalStepper value={funkkanal} onChange={setFunkkanal} compact />
            </div>

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
              {/* ✕: a Trupp that comes back and goes in again gets a NEW order, and the old one
                  is not a starting point for typing it — «2. OG Wohnung Nord, 2 Personen
                  vermisst» had to be select-all-deleted by hand on a phone, mid-Einsatz. */}
              <ClearableInput
                value={ziel} placeholder={isAnderes ? az.zielOtherPlaceholder : az.zielPlaceholder}
                // caps chosen so the card's one-line Ziel and the Leitung chip can't be blown out:
                // «2. OG Wohnung Nord, 2 Personen vermisst» is 39 chars, a Leitung is «1»–«12»
                maxLength={60}
                clearLabel={az.zielClear}
                onChange={(v) => setZiel(stripUnprintable(v))}
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
                {/* The Leitungen that are actually DRAWN. Typing a number blind is how the two
                    sides end up disagreeing — the hose usually exists long before anyone
                    registers the Trupp. A number someone else is on stays pickable (real
                    incidents need corrections) but says whose it is. */}
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
        </div>

      <div className={s.modalFoot}>
        {/* the house button family — three private classes here were the last of this modal's own
            design system (see Atemschutz.module.css · .modal) */}
        {/* the ONLY control that throws the draft away — ✕ and the backdrop keep it */}
        <button className="ip-btn ghost" onClick={() => { dropDraft(); onCancel() }}>{az.cancel}</button>
        {/* Re-deploy forks here: a re-equipped Trupp is just as often held back as Sicherungstrupp
            as it is sent straight in. Both buttons take the same filled-in form, so the choice
            costs nothing — and «Bereitstellen» is the one that must NOT start a contact clock.
            It is also what actually happens first: a Trupp comes out, gets a fresh bottle and
            waits. So on re-deploy «Bereitstellen» carries the primary weight and «Einrücken»
            steps back — the ORDER stays as it was, only the emphasis swaps, so nobody has to
            re-learn where the button is. */}
        {mode === 'redeploy' && (
          <button className="ip-btn primary" disabled={!canSubmit} onClick={() => submit(true)} title={az.reenterStandbyHint}>
            {az.reenterStandby}
          </button>
        )}
        <button className={mode === 'redeploy' ? 'ip-btn' : 'ip-btn primary'} disabled={!canSubmit} onClick={() => submit()}>{submitLabel}</button>
      </div>
    </Overlay>
  )
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
}
