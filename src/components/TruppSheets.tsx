import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, stripUnprintable } from '../lib/format'
import { cx } from '../lib/cx'
import { Overlay, SheetFoot, SheetGrab } from '../lib/overlays'
import { atemschutzDoctrine } from '../lib/deploymentConfig'
import { abbreviateName, personIdForName, rosterFromList, rosterIdByName, truppSlots } from '../lib/personnel'
import { atemschutzEquipment } from '../lib/deploymentConfig'
import type { TruppTransferState } from '../lib/atemschutz'
import { truppEditPatch, truppFieldGroupsChanged, truppFieldsOf, type TruppFieldGroup } from '../lib/atemschutz'
import { auftragSheetFields, fileGuestSlots, kanalPad, kanalSheetFields, leitungChoices, quickAuftragTypes, teamConflict, truppSheetFields, type CrewSlot } from '../lib/truppQuickEdit'
import type { LeitungOption } from '../lib/truppLines'
import type { Person, Trupp, TruppAuftrag, TruppFields } from '../types'
import { Segmented } from './Segmented'
import { ClearableInput } from './ClearableInput'
import { Stepper } from './Stepper'
import { TruppTeam } from './TruppTeam'
import { ZielChips } from './suche/SucheTrupp'
import { SavedCue } from './SavedCue'
import s from './Atemschutz.module.css'

/**
 * The phone card's mini sheets (26.09.2026, phone card slim-down — docs/planning/az-card-2026-09-26,
 * Runde 3): ONE short sheet per fact the card shows as a chip. «The card is for reading, a sheet is
 * a form»: the labels the card dropped come back in here, small and grey, one word each, and the
 * Trupp's name stands under the title so it is always clear whose sheet is open over the dimmed
 * board.
 *
 * The frame is the `.modal` head with the ✕, grown a grab bar and the push-down-to-close gesture,
 * because on a phone these ARE bottom sheets (lib/overlays · Overlay, `.miniSheet` in
 * Atemschutz.module.css); on a tablet the same frame is a centred card. The pressure picker was
 * the one sheet built otherwise (a centred card at every width) and joined them on 29.09.2026.
 *
 * ONE rule for when a mini sheet writes (29.09.2026, owner: «everything auto-saved, no manual
 * confirmations» → «save when the sheet closes»): it writes ONCE, when its answer is complete. A
 * one-question sheet (the Kanal pad, the Druck grid) is complete on the tap — tap, write, close,
 * as before. The Auftrag sheet asks three questions (Art · Ziel · Leitung), so its answer is
 * complete when it CLOSES — ✕, swipe, backdrop, Escape all write, one Verlauf row and one ↶ step
 * for the three together, nothing when nothing changed, and a confirm-with-undo toast after it is
 * the way to throw the edit away (AtemschutzView · saveQuick). A tile that wrote on its own would
 * be two rows for «Retten, 2. OG» or a sheet that shut before the Ziel was typed. The Kanal
 * STEPPER (a range too wide for a pad) is the same case as the Auftrag and writes on close too.
 * The Mannschaft sheet keeps its Speichern: its save is held while the crew is incomplete or
 * double-booked, and it files Gäste into the Anwesenheit — there ✕ is still «not now» (the big
 * form keeps drafts — TruppForm · draftKeep — because it holds a whole crew).
 *
 * Every save goes through the ONE write path (useTruppActions · editTrupp), handed the Trupp as it
 * stands now with only this sheet's fields changed (lib/truppQuickEdit): same Verlauf row, same
 * undo step, same Rapport as the big form's save.
 */

/** the title line's second row: «Hirter Stephan · Trupp 2» — whose sheet this is. ONE head for
 *  all four sheets (29.09.2026, sweep 3 T5): the title is the QUESTION (Druck · Kanal · Auftrag ·
 *  Mannschaft), this line is whose — the Trupp sheet said «Trupp 3» over «Keller Laura» and the
 *  Druck sheet «Keller Laura · Druck» on one line, three ways to say whose sheet is open. */
function truppSheetSub(t: Trupp): string {
  const az = appConfig.copy.atemschutz
  return t.no != null ? `${t.name} · ${fillTemplate(az.quickTrupp, { no: t.no })}` : t.name
}

function MiniSheet({ title, sub, ariaLabel, onClose, children, footer, className, closeLabel }: {
  title: ReactNode; sub?: string; ariaLabel: string; onClose: () => void; children: ReactNode; footer?: ReactNode; className?: string
  /** the ✕'s name: «Abbrechen» where closing throws the answer away, «Schliessen» where it saves */
  closeLabel?: string
}) {
  const az = appConfig.copy.atemschutz
  return (
    <Overlay open onClose={onClose} className={cx(s.modal, s.miniSheet, className)} ariaLabel={ariaLabel}>
      <SheetGrab />
      <div className={s.modalHead}>
        <h3>{title}{sub && <small className={s.miniSub}>{sub}</small>}</h3>
        <button type="button" className="ip-x" aria-label={closeLabel ?? az.cancel} onClick={onClose}><Icon id="close" /></button>
      </div>
      <div className={s.miniBody}>{children}</div>
      {footer}
    </Overlay>
  )
}

/**
 * The save-on-close door of a mini sheet (29.09.2026): `close` is what ✕, swipe, backdrop and
 * Escape all call. Nothing the sheet asks changed ⇒ it just closes and writes nothing. Otherwise
 * only the groups THIS sheet touched go onto the Trupp as it stands NOW (lib/atemschutz ·
 * truppEditPatch — another device's change to a field the sheet did not touch survives), through
 * `onSave` with `closing`, so the write raises the confirm-with-undo toast. A save the operator
 * declined (the Leitung question's «Abbrechen») keeps the sheet open with everything still picked;
 * a second close while that question is up is ignored, so one close is at most one write.
 */
function useSaveOnClose(t: Trupp, groups: readonly TruppFieldGroup[], what: string,
  onSave: (f: TruppFields, closing?: { what: string }) => Promise<boolean> | boolean, onClose: () => void) {
  // the Trupp as the sheet OPENED it — what «did the operator change anything» is measured against
  const [opened] = useState(() => truppFieldsOf(t))
  const busy = useRef(false)
  return async (mine: TruppFields) => {
    if (busy.current) return
    const touched = truppFieldGroupsChanged(opened, mine).filter((g) => groups.includes(g))
    if (!touched.length) { onClose(); return }
    busy.current = true
    try {
      if (await onSave(truppEditPatch(t, mine, touched), { what })) onClose()
    } finally { busy.current = false }
  }
}

/**
 * The ONE pressure picker (24.09.2026, Übung 23.09.): three columns — 300…220, 200…120, 100…20 —
 * in steps of 20, and a tap SAVES. Used for a Druckmeldung from the phone (row and card) and for
 * the Restdruck at «Raus melden» on every width.
 *
 * ⚠️ Why a grid and not the ± stepper the card has: a Druckmeldung arrives over the radio as one
 * number while the other hand holds the handset. A stepper is five to ten taps and a «Bestätigen»;
 * this is one. 20-bar steps because nobody reads a gauge closer than that under a mask («nobody
 * counts that exact», maintainer, 24.09.) — so there is deliberately no «genau…» way out.
 * The column a value sits in is its meaning at a glance: full · half · at or below the line (red).
 * The last known value is outlined, so the eye starts where the Trupp was — which is why the hint
 * no longer says «Zuletzt 240 bar» too (29.09.2026).
 * A MiniSheet since 29.09.2026 (sweep 3 T5): it was a centred card with no grab bar, the one
 * sheet of the four built differently; now it rises from the bottom on a phone like Kanal,
 * Auftrag and Trupp, with the same head, and is the same centred card as they are on a tablet.
 */
const PRESSURE_GRID: number[][] = [[300, 280, 260, 240, 220], [200, 180, 160, 140, 120], [100, 80, 60, 40, 20]]

export function PressureSheet({ t, title, hint, last, alarmBar, onPick, onClose, footer }: {
  /** whose reading — the head's second line (truppSheetSub) */
  t: Trupp
  /** the question: «Druck», or «Restdruck» at «Raus melden» */
  title: string
  hint?: string
  /** the Trupp's current bar — its nearest grid value is outlined */
  last: number
  /** this Trupp's turn-back line (lib/atemschutz · alarmBarFor) — values at or below it are red */
  alarmBar: number
  onPick: (bar: number) => void
  onClose: () => void
  /** a second way out that is not a number (the exit's «Ohne Druck raus») */
  footer?: { label: string; onClick: () => void }
}) {
  // DOWN to the grid, never up: a Trupp last read at 250 has not got 260 (clamped to the grid's ends)
  const near = Math.min(300, Math.max(20, Math.floor(last / 20) * 20))
  return (
    <MiniSheet title={title} sub={truppSheetSub(t)} ariaLabel={`${title} · ${t.name}`} onClose={onClose}
      footer={footer && <button type="button" className={s.pressureSheetFooter} onClick={footer.onClick}>{footer.label}</button>}>
      <div className={s.pressureGrid}>
        {PRESSURE_GRID.map((col, i) => (
          <div key={i} className={s.pressureCol}>
            {col.map((bar) => (
              <button key={bar} type="button"
                className={cx(s.pressureCell, bar <= alarmBar && s.pressureCellLow, bar === near && s.pressureCellLast)}
                onClick={() => onPick(bar)}>
                {bar}
              </button>
            ))}
          </div>
        ))}
      </div>
      {/* under the grid, like the Kanal pad's hint: what a tap does */}
      {hint && <p className={s.miniHint}>{hint}</p>}
    </MiniSheet>
  )
}

/**
 * «Kanal» — a pad of the station's channel range, the current one marked; ONE tap picks, writes
 * and closes (the hint under the pad says so, because the sheet has no Speichern). A range too
 * wide for a pad (lib/truppQuickEdit · KANAL_PAD_MAX) gets the form's stepper, which writes when
 * the sheet closes (29.09.2026 — it had a Speichern; see the rule at the top of this file).
 */
export function KanalSheet({ t, onSave, onClose }: {
  t: Trupp
  /** the one write (AtemschutzView · saveQuick → editTrupp); resolves once written. `closing` =
   *  written by a close, which raises the confirm-with-undo toast */
  onSave: (f: TruppFields, closing?: { what: string }) => Promise<boolean> | boolean
  onClose: () => void
}) {
  const az = appConfig.copy.atemschutz
  const dz = atemschutzDoctrine()
  const pad = kanalPad(dz.funkkanalMin, dz.funkkanalMax)
  const current = t.funkkanal ?? dz.defaultFunkkanal
  const [typed, setTyped] = useState<number>(current)
  const onRef = useRef<HTMLButtonElement>(null)
  // a long pad opens ON the current channel, not at 1
  useEffect(() => { onRef.current?.scrollIntoView?.({ block: 'center' }) }, [])
  const pick = async (n: number) => {
    if (n === t.funkkanal) { onClose(); return }
    if (await onSave(kanalSheetFields(t, n))) onClose()
  }
  const clamp = (v: number) => Math.max(dz.funkkanalMin, Math.min(dz.funkkanalMax, v))
  const saveOnClose = useSaveOnClose(t, ['funkkanal'], `${az.funkkanalUnit} · ${t.name}`, onSave, onClose)
  // the pad's ✕ is «not now» (a tap is the answer); the stepper's ✕ is the save
  const close = pad ? onClose : () => void saveOnClose(kanalSheetFields(t, typed))
  return (
    <MiniSheet title={az.funkkanalUnit} sub={truppSheetSub(t)} ariaLabel={`${az.funkkanalUnit} · ${t.name}`} onClose={close} className={pad ? s.miniSheetPad : undefined}
      closeLabel={pad ? undefined : appConfig.copy.closeDialog}>
      {pad ? (
        <>
          <div className={s.pad} role="group" aria-label={az.funkkanalUnit}>
            {pad.map((n) => (
              <button key={n} ref={n === current ? onRef : undefined} type="button" aria-pressed={n === current}
                className={cx(s.padKey, n === current && s.padKeyOn)} onClick={() => void pick(n)}>{n}</button>
            ))}
          </div>
          <p className={s.miniHint}>{az.kanalSheetHint}</p>
        </>
      ) : (
        <div className={s.field}>
          <span>{az.editFieldLabels.funkkanal}</span>
          <div className={s.padStepper}>
            <button type="button" className={s.padKey} aria-label={az.funkkanalDown} onClick={() => setTyped(clamp(typed - 1))}><Icon id="minus" /></button>
            <b className={s.padValue}>{typed}</b>
            <button type="button" className={s.padKey} aria-label={az.funkkanalUp} onClick={() => setTyped(clamp(typed + 1))}><Icon id="plus" /></button>
          </div>
          <SavedCue />
        </div>
      )}
    </MiniSheet>
  )
}

/**
 * «Auftrag» — the six tiles of the Trupp's Art (the sheet's title is their label), «Ziel» over a
 * text field with the Suche's places as quick-picks under it, «Leitung» over «keine · Ltg 1 · … · Nr. …»
 * from the hoses actually drawn — and no Speichern: closing the sheet writes the three together
 * (29.09.2026, see the rule at the top of this file), and says so in one quiet line under them.
 * The one-Leitung-one-Trupp question is the board's (AtemschutzView · confirmLineTake, the same
 * helper the form's save goes through), so `onSave` resolves false when the operator said no and
 * the sheet simply stays open. Nothing here can be invalid — every answer may be empty — so a
 * close never has a reason to refuse.
 */
export function AuftragSheet({ t, zielChoices, leitungOptions, lite = false, onSave, onClose }: {
  t: Trupp
  /** the Suche's places (AtemschutzView · zielChoices) — quick-picks under the Ziel field */
  zielChoices?: readonly string[]
  /** the Leitungen drawn on either surface (lib/truppLines · leitungOptions) */
  leitungOptions: readonly LeitungOption[]
  /** the handed-over Tafel has no picture to read a hose number off — no Leitung row (as the form) */
  lite?: boolean
  /** `closing` = written by a close, which raises the confirm-with-undo toast (saveQuick) */
  onSave: (f: TruppFields, closing?: { what: string }) => Promise<boolean> | boolean
  onClose: () => void
}) {
  const az = appConfig.copy.atemschutz
  const [auftrag, setAuftrag] = useState<TruppAuftrag | null | undefined>(t.auftrag)
  const [ziel, setZiel] = useState(t.ziel ?? '')
  const [lineNo, setLineNo] = useState<number | null>(t.lineNo ?? null)
  const types = quickAuftragTypes(t)
  const saveOnClose = useSaveOnClose(t, ['auftrag', 'ziel', 'lineNo'], `${az.editFieldLabels.auftrag} · ${t.name}`, onSave, onClose)
  const close = () => void saveOnClose(auftragSheetFields(t, { auftrag, ziel, lineNo }))
  return (
    <MiniSheet title={az.editFieldLabels.auftrag} sub={truppSheetSub(t)} ariaLabel={`${az.editFieldLabels.auftrag} · ${t.name}`} onClose={close}
      closeLabel={appConfig.copy.closeDialog}>
      {/* the same control as the form's «Art» — three tiles a row inside `.field` */}
      <div className={s.field}>
        <Segmented ariaLabel={az.editFieldLabels.auftrag} value={auftrag ?? undefined} onChange={(v) => setAuftrag(v)}
          options={types.map((a) => ({ value: a.id, label: a.label }))} />
      </div>
      <label className={s.field}>
        <span>{az.editFieldLabels.ziel}</span>
        <ClearableInput value={ziel} placeholder={az.zielPlaceholder} maxLength={60} clearLabel={az.zielClear}
          onChange={(v) => setZiel(stripUnprintable(v))} />
      </label>
      {/* the Suche's places as SHORTCUTS for every Auftrag — the form shows the same row under the
          same condition (29.09.2026, T12): a Löschtrupp sent to «2. OG» picks the storey the Suche
          already named */}
      {zielChoices && zielChoices.length > 0 && <ZielChips choices={zielChoices} onPick={setZiel} />}
      {!lite && <LeitungField label={az.editFieldLabels.lineNo} value={lineNo} options={leitungOptions} onChange={setLineNo} />}
      <SavedCue />
    </MiniSheet>
  )
}

/**
 * «keine · Ltg 1 · Ltg 2 · Müller H.» — the Leitung as chips from what is actually DRAWN, the
 * selected one filled. ONE component for the Auftrag sheet and the big form (27.09.2026, slim
 * sweep item 6: the form had a «Leitung Nr.» stepper with a «Gezeichnet:» line under it), so the
 * two never disagree about what a Leitung looks like. A number another Trupp is on stays pickable
 * (corrections happen) but wears the dashed edge and says whose it is; the one-Leitung-one-Trupp
 * question is asked at the save (AtemschutzView · confirmLineTake). `children` is the form's
 * trailing «Nr. …» chip — a number nobody has drawn yet.
 */
export function LeitungChips({ value, options, onChange, ariaLabel, children }: {
  value: number | null
  /** lowest number first, the current value among them (lib/truppQuickEdit · leitungChoices) */
  options: readonly LeitungOption[]
  onChange: (n: number | null) => void
  ariaLabel?: string
  children?: ReactNode
}) {
  const az = appConfig.copy.atemschutz
  return (
    <div className={s.miniChips} role="group" aria-label={ariaLabel ?? az.editFieldLabels.lineNo}>
      <button type="button" aria-pressed={value == null} className={cx(s.miniChip, value == null && s.miniChipOn)}
        onClick={() => onChange(null)}>{az.lineNone}</button>
      {options.map((o) => (
        <button key={o.no} type="button" aria-pressed={value === o.no}
          className={cx(s.miniChip, value === o.no && s.miniChipOn, !!o.takenBy && value !== o.no && s.miniChipTaken)}
          title={o.takenBy ? fillTemplate(az.lineOptTaken, { name: o.takenBy }) : undefined}
          onClick={() => onChange(o.no)}>
          {fillTemplate(az.lineChip, { n: o.no })}{o.onPlan ? ' · P' : ''}{o.takenBy ? ` · ${abbreviateName(o.takenBy)}` : ''}
        </button>
      ))}
      {children}
    </div>
  )
}

/**
 * «Leitung»: the chips from what is drawn, and «Nr. …» for a number nobody has drawn yet — the
 * hose may be laid before anybody draws it. ONE field for the form and the Auftrag sheet
 * (29.09.2026, sweep 3 T12: the sheet had no «Nr. …», so a Leitung set in one door could not be
 * set in the other). «Nr. …» is a door, not a value: it opens the stepper and steps aside (a filled
 * «Nr. …» beside a filled «keine» read as two answers), and the number typed then stands as its
 * own chip. Open by itself while the value IS such a number (a kept draft, an edit), so the
 * stepper never hides the number it holds. `children` goes under it (the form's legacy note).
 */
export function LeitungField({ label, value, options, onChange, children }: {
  label: string
  value: number | null
  /** the Leitungen drawn on either surface (lib/truppLines · leitungOptions) */
  options: readonly LeitungOption[]
  onChange: (n: number | null) => void
  children?: ReactNode
}) {
  const az = appConfig.copy.atemschutz
  const [typing, setTyping] = useState(() => value != null && !options.some((o) => o.no === value))
  const choices = useMemo(() => leitungChoices(value, options), [value, options])
  return (
    <div className={s.field}>
      <span>{label}</span>
      <LeitungChips value={value} options={choices} onChange={onChange} ariaLabel={label}>
        {!typing && (
          <button type="button" className={s.miniChip} onClick={() => setTyping(true)}>{az.lineTyped}</button>
        )}
      </LeitungChips>
      {typing && (
        <Stepper
          value={value} min={1} max={99} placeholder="–"
          onChange={onChange} onClear={() => onChange(null)} canClear={value != null}
          ariaLabel={az.lineTyped}
        />
      )}
      {children}
    </div>
  )
}

/**
 * The sentence under a crew that names a person who is in another Trupp — and, where that Trupp
 * has not gone in, the one tap that takes them out of it (lib/truppQuickEdit · teamConflict). ONE
 * row for the big form and the Trupp sheet (26.09.2026): the form used to draw it inline. Two
 * buttons inside one warn field, never a button inside a button: the sentence points at the crew
 * (`onPoint`), the action moves the person.
 */
export function TeamConflictRow({ conflict, toName, onPoint, onTransfer, className }: {
  conflict: NonNullable<ReturnType<typeof teamConflict>>
  /** the Gruppenführer this crew is forming — the other Trupp's Verlauf row says where they went */
  toName: string
  onPoint?: () => void
  onTransfer?: (personId: string, toName: string) => void
  className?: string
}) {
  const az = appConfig.copy.atemschutz
  return (
    <div className={cx('form-warn', s.formWarn, className)}>
      <Icon id="warn" />
      <button type="button" className={cx('form-warn-text', s.formWarnText)} onClick={onPoint}>
        {fillTemplate(conflict.state === 'deployed' ? az.assignedConflictDeployed : az.assignedConflict, { name: conflict.name })}
      </button>
      {conflict.state === 'ready' && onTransfer && (
        <button type="button" className="form-warn-act" onClick={() => onTransfer(conflict.personId, toName)}>
          {az.assignedTransfer}
        </button>
      )}
    </div>
  )
}

/**
 * «Mannschaft» (the sheet's title since 29.09.2026; it was «Trupp 2») — the form's own crew picker (TruppTeam: chips with ✕, «Person
 * suchen …», the Gruppenführer hint), «Ausrüstung» over the station's toggles, one Speichern. The
 * same record, the same helpers as the form (lib/truppQuickEdit · crewFields / fileGuestSlots /
 * teamConflict); the Gäste typed here reach the Anwesenheit at the save, as the form's do. Only an
 * Atemschutz-Trupp is asked its Ausrüstung — a work squad takes no Retthaube in.
 */
export function TruppSheet({ t, personnel, legacyRoster, presentIds, stationIds, assignedIds, rolesById, transferState, onTransfer, onAddGuest, onSave, onClose }: {
  t: Trupp
  personnel: Person[]
  legacyRoster: string[]
  presentIds: Set<string>
  stationIds: Set<string>
  /** who is in another ACTIVE Trupp — the picker greys them, the save is held while one is in the crew */
  assignedIds: Set<string>
  rolesById: Map<string, string>
  transferState?: (personId: string) => TruppTransferState
  onTransfer?: (personId: string, toName: string) => void
  onAddGuest?: (name: string) => string | undefined
  onSave: (f: TruppFields) => Promise<boolean> | boolean
  onClose: () => void
}) {
  const az = appConfig.copy.atemschutz
  const rosterByName = useMemo(() => rosterIdByName(personnel), [personnel])
  const rosterById = useMemo(() => rosterFromList(personnel), [personnel])
  const [team, setTeam] = useState<CrewSlot[]>(() =>
    truppSlots(t, rosterByName, rosterById).map((sl) => (sl.personId ? sl : { ...sl, personId: personIdForName(rosterByName, sl.name) })))
  const [equipment, setEquipment] = useState<string[]>(t.equipment ?? [])
  const toggle = (id: string) => setEquipment(equipment.includes(id) ? equipment.filter((x) => x !== id) : [...equipment, id])
  const conflict = teamConflict(team, assignedIds, transferState, az.assignedFallbackName)
  const leaderOk = (team[0]?.name.trim().length ?? 0) > 0
  const canSave = leaderOk && !conflict
  const teamRef = useRef<HTMLDivElement>(null)
  const isPa = t.kind !== 'einfach'
  const save = async () => {
    if (!canSave) { teamRef.current?.scrollIntoView?.({ block: 'center' }); return }
    // the Gäste are filed NOW, at the save — never on a tap in the picker — and their ids ride
    // over the crew's (the form's `fileCrew`, same order of operations)
    const f = truppSheetFields(t, team, equipment, atemschutzEquipment().map((e) => e.id))
    if (await onSave({ ...f, ...fileGuestSlots(team, onAddGuest) })) onClose()
  }
  // the question, like its three siblings (T5): «Mannschaft», whose under it
  const title = az.editFieldLabels.crew
  return (
    <MiniSheet title={title} sub={truppSheetSub(t)} ariaLabel={`${title} · ${t.name}`} onClose={onClose}
      className={s.miniSheetTall}
      footer={(
        <SheetFoot className={s.modalFoot}>
          <button type="button" className={cx('ip-btn primary', !canSave && s.btnBlocked)} aria-disabled={!canSave} onClick={() => void save()}>{az.save}</button>
        </SheetFoot>
      )}>
      {/* no «Mannschaft» label over the picker: the title says it (as the Auftrag's tiles) */}
      <div ref={teamRef} className={s.field}>
        <TruppTeam value={team} onChange={setTeam} phone
          personnel={personnel} legacyRoster={legacyRoster} presentIds={presentIds} stationIds={stationIds}
          assignedIds={assignedIds} rolesById={rolesById} />
      </div>
      {conflict && <TeamConflictRow conflict={conflict} toName={team[0]?.name.trim() ?? ''} onTransfer={onTransfer}
        onPoint={() => teamRef.current?.scrollIntoView?.({ block: 'center' })} />}
      {isPa && (
        <div className={s.field}>
          <span>{az.equipmentLabel}</span>
          <div className={s.miniChips} role="group" aria-label={az.equipmentLabel}>
            {atemschutzEquipment().map((e) => {
              const on = equipment.includes(e.id)
              return (
                <button key={e.id} type="button" role="checkbox" aria-checked={on}
                  className={cx(s.miniChip, on && s.miniChipOn)} onClick={() => toggle(e.id)}>
                  {az.equipmentLabels[e.id] ?? e.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </MiniSheet>
  )
}
