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
import { auftragSheetFields, fileGuestSlots, kanalPad, kanalSheetFields, leitungChoices, quickAuftragTypes, teamConflict, truppSheetFields, type CrewSlot } from '../lib/truppQuickEdit'
import type { LeitungOption } from '../lib/truppLines'
import type { Person, Trupp, TruppAuftrag, TruppFields } from '../types'
import { Segmented } from './Segmented'
import { ClearableInput } from './ClearableInput'
import { Stepper } from './Stepper'
import { useHoldRepeat } from '../lib/useHoldRepeat'
import { useTapToType } from '../lib/useTapToType'
import { TruppTeam } from './TruppTeam'
import { ZielChips } from './suche/SucheTrupp'
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
 * the one sheet built otherwise (a centred card at every width) and joined them on 29.09.2026. ✕, backdrop and the swipe are «not now»: a mini sheet holds one to three
 * answers, and re-typing a Ziel costs less than a draft store for it would (the big form keeps
 * drafts — TruppForm · draftKeep — because it holds a whole crew).
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

function MiniSheet({ title, sub, ariaLabel, onClose, children, footer, className }: {
  title: ReactNode; sub?: string; ariaLabel: string; onClose: () => void; children: ReactNode; footer?: ReactNode; className?: string
}) {
  const az = appConfig.copy.atemschutz
  return (
    <Overlay open onClose={onClose} className={cx(s.modal, s.miniSheet, className)} ariaLabel={ariaLabel}>
      <SheetGrab />
      <div className={s.modalHead}>
        <h3>{title}{sub && <small className={s.miniSub}>{sub}</small>}</h3>
        <button type="button" className="ip-x" aria-label={az.cancel} onClick={onClose}><Icon id="close" /></button>
      </div>
      <div className={s.miniBody}>{children}</div>
      {footer}
    </Overlay>
  )
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
  return (
    <MiniSheet title={title} sub={truppSheetSub(t)} ariaLabel={`${title} · ${t.name}`} onClose={onClose}
      footer={footer && <button type="button" className={s.pressureSheetFooter} onClick={footer.onClick}>{footer.label}</button>}>
      <PressureGrid value={last} alarmBar={alarmBar} onPick={onPick} />
      {/* under the grid, like the Kanal pad's hint: what a tap does */}
      {hint && <p className={s.miniHint}>{hint}</p>}
    </MiniSheet>
  )
}

/**
 * The grid itself — ONE control for every pressure the app asks by tap: the Druck sheet above, and
 * the Trupp form's Eingangsdruck (30.09.2026, owner: «neuer Eingangsdruck / Funkkanal … should also
 * follow the new easy tap format»; it was the ± stepper with tap-to-type). Same three columns, same
 * red line, same 20-bar steps.
 * Two ways to mark `value`: in the sheet it is the LAST reading — outlined, and a tap saves a new one;
 * in the form (`chosen`) it is the ANSWER — the one picked cell wears the choice fill (`--sel`), and a
 * tap only changes the answer. A value the grid does not hold (a 290 recorded before 30.09.) is
 * outlined at its step below, like a last reading, and nothing is filled until a cell is tapped.
 */
export function PressureGrid({ value, alarmBar, onPick, chosen = false, ariaLabel }: {
  value: number
  /** values at or below it are red (lib/atemschutz · alarmBarFor) */
  alarmBar: number
  onPick: (bar: number) => void
  /** the form's answer, not the last reading — see above */
  chosen?: boolean
  ariaLabel?: string
}) {
  const picked = chosen && PRESSURE_GRID.some((col) => col.includes(value)) ? value : null
  // DOWN to the grid, never up: a Trupp last read at 250 has not got 260 (clamped to the grid's ends)
  const near = picked == null ? Math.min(300, Math.max(20, Math.floor(value / 20) * 20)) : null
  return (
    <div className={cx(s.pressureGrid, chosen && s.pressureGridForm)} role="group" aria-label={ariaLabel}>
      {PRESSURE_GRID.map((col, i) => (
        <div key={i} className={s.pressureCol}>
          {col.map((bar) => (
            <button key={bar} type="button" aria-pressed={chosen ? bar === picked : undefined}
              className={cx(s.pressureCell, bar <= alarmBar && s.pressureCellLow, bar === near && s.pressureCellLast, bar === picked && s.pressureCellOn)}
              onClick={() => onPick(bar)}>
              {bar}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * «Kanal» — a pad of the station's channel range, the current one marked; ONE tap picks, writes
 * and closes (the hint under the pad says so, because the sheet has no Speichern). A range too
 * wide for a pad (lib/truppQuickEdit · KANAL_PAD_MAX) gets the form's stepper and a Speichern.
 */
export function KanalSheet({ t, onSave, onClose }: {
  t: Trupp
  /** the one write (AtemschutzView · saveQuick → editTrupp); resolves once written */
  onSave: (f: TruppFields) => Promise<boolean> | boolean
  onClose: () => void
}) {
  const az = appConfig.copy.atemschutz
  const dz = atemschutzDoctrine()
  const pad = kanalPad(dz.funkkanalMin, dz.funkkanalMax)
  const current = t.funkkanal ?? dz.defaultFunkkanal
  const [typed, setTyped] = useState<number>(current)
  const pick = async (n: number) => {
    if (n === t.funkkanal) { onClose(); return }
    if (await onSave(kanalSheetFields(t, n))) onClose()
  }
  return (
    <MiniSheet title={az.funkkanalUnit} sub={truppSheetSub(t)} ariaLabel={`${az.funkkanalUnit} · ${t.name}`} onClose={onClose} className={pad ? s.miniSheetPad : undefined}
      footer={pad ? undefined : (
        <SheetFoot className={s.modalFoot}>
          <button type="button" className="ip-btn primary" onClick={() => void pick(typed)}>{az.save}</button>
        </SheetFoot>
      )}>
      {pad ? (
        <>
          <KanalPicker value={current} onPick={(n) => void pick(n)} />
          <p className={s.miniHint}>{az.kanalSheetHint}</p>
        </>
      ) : (
        <div className={s.field}>
          <span>{az.editFieldLabels.funkkanal}</span>
          <KanalPicker value={typed} onPick={setTyped} />
        </div>
      )}
    </MiniSheet>
  )
}

/**
 * The Kanal control — ONE for the Kanal sheet and the Trupp form (30.09.2026, the form's «Funkkanal»
 * joins the tap format): the station's channels as keys, the chosen one filled, while the range fits
 * a pad (lib/truppQuickEdit · kanalPad); above that the ± stepper, hold to repeat and tap the value
 * to type (a 1–9999 scheme is not stepped one by one). The pad opens ON the current channel.
 * `capped`: the form's pad is a short box of its own that scrolls (three rows, the fourth cut to say
 * so) — a 1–99 pad inline would push the rest of the form a screen down; the sheet's pad scrolls
 * with the sheet. ⚠️ Only ITS box is scrolled to the key, never the form around it: an edit form
 * opens with this pad mounted, and `scrollIntoView` would have scrolled the whole form down to it.
 */
export function KanalPicker({ value, onPick, capped = false }: {
  value: number
  onPick: (n: number) => void
  capped?: boolean
}) {
  const az = appConfig.copy.atemschutz
  const dz = atemschutzDoctrine()
  const pad = kanalPad(dz.funkkanalMin, dz.funkkanalMax)
  const boxRef = useRef<HTMLDivElement>(null)
  const onRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const key = onRef.current, box = boxRef.current
    if (!key || !box) return
    // (`.padCapped` is positioned, so a key's offsetTop is measured inside the box)
    if (capped) box.scrollTop = key.offsetTop - (box.clientHeight - key.offsetHeight) / 2
    else key.scrollIntoView?.({ block: 'center' })
    // once, at mount: a tap must not re-centre the box under the finger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!pad) return <FunkkanalStepper value={value} onChange={onPick} />
  return (
    <div ref={boxRef} className={cx(s.pad, capped && s.padCapped)} role="group" aria-label={az.funkkanalUnit}>
      {pad.map((n) => (
        <button key={n} ref={n === value ? onRef : undefined} type="button" aria-pressed={n === value}
          className={cx(s.padKey, n === value && s.padKeyOn)} onClick={() => onPick(n)}>{n}</button>
      ))}
    </div>
  )
}

// The Funkkanal ± stepper — the Kanal control where the station's range is too wide for a pad:
// hold to repeat, tap the value to type an exact channel. Clamped to the configured range.
// (It was the Trupp form's own; since 30.09.2026 the sheet's fallback too, via KanalPicker.)
function FunkkanalStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const az = appConfig.copy.atemschutz
  const dz = atemschutzDoctrine()
  const clamp = (v: number) => Math.max(dz.funkkanalMin, Math.min(dz.funkkanalMax, v))
  const dec = useHoldRepeat(() => onChange(clamp(value - 1)))
  const inc = useHoldRepeat(() => onChange(clamp(value + 1)))
  const edit = useTapToType({ min: dz.funkkanalMin, max: dz.funkkanalMax, onCommit: onChange })
  return (
    <div className={cx(s.stepper, s.stepperSmall)}>
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

/**
 * «Auftrag» — the six tiles of the Trupp's Art (the sheet's title is their label), «Ziel» over a
 * text field with the Suche's places as quick-picks under it, «Leitung» over «keine · Ltg 1 · … · Nr. …»
 * from the hoses actually drawn, and one Speichern. The one-Leitung-one-Trupp question is the
 * board's (AtemschutzView · confirmLineTake, the same helper the form's save goes through), so
 * `onSave` resolves false when the operator said no and the sheet simply stays open.
 */
export function AuftragSheet({ t, zielChoices, leitungOptions, lite = false, onSave, onClose }: {
  t: Trupp
  /** the Suche's places (AtemschutzView · zielChoices) — quick-picks under the Ziel field */
  zielChoices?: readonly string[]
  /** the Leitungen drawn on either surface (lib/truppLines · leitungOptions) */
  leitungOptions: readonly LeitungOption[]
  /** the handed-over Tafel has no picture to read a hose number off — no Leitung row (as the form) */
  lite?: boolean
  onSave: (f: TruppFields) => Promise<boolean> | boolean
  onClose: () => void
}) {
  const az = appConfig.copy.atemschutz
  const [auftrag, setAuftrag] = useState<TruppAuftrag | null | undefined>(t.auftrag)
  const [ziel, setZiel] = useState(t.ziel ?? '')
  const [lineNo, setLineNo] = useState<number | null>(t.lineNo ?? null)
  const types = quickAuftragTypes(t)
  const save = async () => {
    if (await onSave(auftragSheetFields(t, { auftrag, ziel, lineNo }))) onClose()
  }
  return (
    <MiniSheet title={az.editFieldLabels.auftrag} sub={truppSheetSub(t)} ariaLabel={`${az.editFieldLabels.auftrag} · ${t.name}`} onClose={onClose}
      footer={(
        <SheetFoot className={s.modalFoot}>
          <button type="button" className="ip-btn primary" onClick={() => void save()}>{az.save}</button>
        </SheetFoot>
      )}>
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
