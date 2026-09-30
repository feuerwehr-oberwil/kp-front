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
import { TruppTeam } from './TruppTeam'
import s from './Atemschutz.module.css'

/**
 * The phone card's mini sheets (26.09.2026, phone card slim-down — docs/planning/az-card-2026-09-26,
 * Runde 3): ONE short sheet per fact the card shows as a chip. «The card is for reading, a sheet is
 * a form»: the labels the card dropped come back in here, small and grey, one word each, and the
 * Trupp's name stands under the title so it is always clear whose sheet is open over the dimmed
 * board.
 *
 * The frame is the PressureSheet's — the same `.modal` head with the ✕ — grown a grab bar and the
 * push-down-to-close gesture, because on a phone these ARE bottom sheets (lib/overlays · Overlay,
 * `.miniSheet` in Atemschutz.module.css); on a tablet the same frame is a centred card, like the
 * pressure picker. ✕, backdrop and the swipe are «not now»: a mini sheet holds one to three
 * answers, and re-typing a Ziel costs less than a draft store for it would (the big form keeps
 * drafts — TruppForm · draftKeep — because it holds a whole crew).
 *
 * Every save goes through the ONE write path (useTruppActions · editTrupp), handed the Trupp as it
 * stands now with only this sheet's fields changed (lib/truppQuickEdit): same Verlauf row, same
 * undo step, same Rapport as the big form's save.
 */

/** the title line's second row: «Hirter Stephan · Trupp 2» — whose sheet this is */
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
  const onRef = useRef<HTMLButtonElement>(null)
  // a long pad opens ON the current channel, not at 1
  useEffect(() => { onRef.current?.scrollIntoView?.({ block: 'center' }) }, [])
  const pick = async (n: number) => {
    if (n === t.funkkanal) { onClose(); return }
    if (await onSave(kanalSheetFields(t, n))) onClose()
  }
  const clamp = (v: number) => Math.max(dz.funkkanalMin, Math.min(dz.funkkanalMax, v))
  return (
    <MiniSheet title={az.funkkanalUnit} sub={truppSheetSub(t)} ariaLabel={`${az.funkkanalUnit} · ${t.name}`} onClose={onClose} className={pad ? s.miniSheetPad : undefined}
      footer={pad ? undefined : (
        <SheetFoot className={s.modalFoot}>
          <button type="button" className="ip-btn primary" onClick={() => void pick(typed)}>{az.save}</button>
        </SheetFoot>
      )}>
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
        </div>
      )}
    </MiniSheet>
  )
}

/**
 * «Auftrag» — the six tiles of the Trupp's Art (the sheet's title is their label), «Ziel» over a
 * text field with the Suche's places as quick-picks under it, «Leitung» over «keine · Ltg 1 · …»
 * from the hoses actually drawn, and one Speichern. The one-Leitung-one-Trupp question is the
 * board's (AtemschutzView · confirmLineTake, the same helper the form's save goes through), so
 * `onSave` resolves false when the operator said no and the sheet simply stays open.
 */
export function AuftragSheet({ t, leitungOptions, lite = false, onSave, onClose }: {
  t: Trupp
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
  const lines = leitungChoices(t, leitungOptions)
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
      {/* the Suche's places as quick-picks — for EVERY Auftrag here (the form shows them under
          «Absuchen» only): a Löschtrupp sent to «2. OG» picks the storey the Suche already named */}
      {!lite && (
        <div className={s.field}>
          <span>{az.editFieldLabels.lineNo}</span>
          <LeitungChips value={lineNo} options={lines} onChange={setLineNo} />
        </div>
      )}
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
 * «Trupp 2» — «Mannschaft» over the form's own crew picker (TruppTeam: chips with ✕, «Person
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
  const title = t.no != null ? fillTemplate(az.quickTrupp, { no: t.no }) : t.name
  return (
    <MiniSheet title={title} sub={t.no != null ? t.name : undefined} ariaLabel={`${title} · ${az.editFieldLabels.crew}`} onClose={onClose}
      className={s.miniSheetTall}
      footer={(
        <SheetFoot className={s.modalFoot}>
          <button type="button" className={cx('ip-btn primary', !canSave && s.btnBlocked)} aria-disabled={!canSave} onClick={() => void save()}>{az.save}</button>
        </SheetFoot>
      )}>
      <div ref={teamRef} className={s.field}>
        <span>{az.editFieldLabels.crew}</span>
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
