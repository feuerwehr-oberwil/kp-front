import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate, stripUnprintable } from '../lib/format'
import { cx } from '../lib/cx'
import { Overlay, SheetFoot, SheetGrab } from '../lib/overlays'
import { atemschutzDoctrine } from '../lib/deploymentConfig'
import { abbreviateName } from '../lib/personnel'
import { auftragSheetFields, kanalPad, kanalSheetFields, leitungChoices, quickAuftragTypes } from '../lib/truppQuickEdit'
import type { LeitungOption } from '../lib/truppLines'
import type { Trupp, TruppAuftrag, TruppFields } from '../types'
import { Segmented } from './Segmented'
import { ClearableInput } from './ClearableInput'
import { ZielChips } from './suche/SucheTrupp'
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
        <button type="button" className={s.iconBtn} aria-label={az.cancel} onClick={onClose}><Icon id="close" /></button>
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
    <MiniSheet title={az.funkkanalUnit} sub={truppSheetSub(t)} ariaLabel={`${az.funkkanalUnit} · ${t.name}`} onClose={onClose}
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
      {zielChoices && zielChoices.length > 0 && <ZielChips choices={zielChoices} value={ziel} onPick={setZiel} />}
      {!lite && (
        <div className={s.field}>
          <span>{az.editFieldLabels.lineNo}</span>
          <div className={s.miniChips} role="group" aria-label={az.editFieldLabels.lineNo}>
            <button type="button" aria-pressed={lineNo == null} className={cx(s.miniChip, lineNo == null && s.miniChipOn)}
              onClick={() => setLineNo(null)}>{az.lineNone}</button>
            {lines.map((o) => (
              <button key={o.no} type="button" aria-pressed={lineNo === o.no}
                className={cx(s.miniChip, lineNo === o.no && s.miniChipOn, !!o.takenBy && lineNo !== o.no && s.miniChipTaken)}
                title={o.takenBy ? fillTemplate(az.lineOptTaken, { name: o.takenBy }) : undefined}
                onClick={() => setLineNo(o.no)}>
                {fillTemplate(az.lineChip, { n: o.no })}{o.onPlan ? ' · P' : ''}{o.takenBy ? ` · ${abbreviateName(o.takenBy)}` : ''}
              </button>
            ))}
          </div>
        </div>
      )}
    </MiniSheet>
  )
}
