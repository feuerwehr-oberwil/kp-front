import { useRef, useState } from 'react'
import { pointAtField } from '../lib/pointAtField'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { Sheet, SheetClose } from '../lib/overlays'
import type { SignatureRole, SignatureStrokes } from '../lib/reportSignature'
import { isBlank } from '../lib/reportSignature'
import type { Person } from '../types'
import { Button } from './Button'
import { Icon } from '../lib/icons'
import { PersonField, type Slot } from './PersonField'
import { Segmented } from './Segmented'
import { useIsPhone } from '../lib/useIsPhone'
import { SignaturePad } from './SignaturePad'
import s from './SignatureSheet.module.css'

// «Rapport unterschreiben» — the one place a signature is drawn (Rapport · Unterschriften card).
// The role is a CHOICE in the form («Unterschreibt als»), the Segmented's blue, not a tab: it is an
// answer, not a place (docs/ui-conventions · Selected). The name is the roster picker, prefilled;
// for the Einsatzleiter it IS the Rapport's Einsatzleiter, written back when the signature is made.
// An open Rapport without an Einsatzende says so above the pad, with «Jetzt eintragen»: the close
// would write one later, which changes the signed part and voids the signature (owner, 14.11.2026).
// ⚠️ `swipeToClose={false}`: the pad owns the vertical gesture — a downward stroke of a signature
// must never dismiss the sheet it is being written on.

export interface SignSubmit {
  role: SignatureRole
  slot: Slot
  strokes: SignatureStrokes
}

export function SignatureSheet({
  open, onClose, initialRole, signedRoles, elName, kdtName, summary, placeDate, onViewPdf, onSign,
  personnel, presentIds, rolesById, onAddGuest, onSetEndNow,
}: {
  open: boolean
  onClose: () => void
  initialRole: SignatureRole
  /** roles whose signature still holds — offered, but greyed with their time */
  signedRoles: Partial<Record<SignatureRole, string>>
  elName: Slot
  kdtName: Slot
  summary: { einsatz: string; zeiten?: string; personen: number; positionen: number }
  placeDate: string
  onViewPdf?: () => void
  onSign: (v: SignSubmit) => Promise<boolean>
  personnel: Person[]
  presentIds: Set<string>
  rolesById?: Map<string, string>
  onAddGuest?: (name: string) => string | undefined
  /** set only while the Einsatzende is empty on an open Rapport: writes «jetzt» into it */
  onSetEndNow?: () => void
}) {
  const S = appConfig.copy.signature
  const [role, setRole] = useState<SignatureRole>(initialRole)
  const [names, setNames] = useState<Record<SignatureRole, Slot>>({ el: elName, kdt: kdtName })
  const [strokes, setStrokes] = useState<SignatureStrokes | null>(null)
  const [busy, setBusy] = useState(false)
  const slot = names[role]
  const ready = !isBlank(strokes) && !!slot.name.trim() && !busy
  // a blocked «Bestätigen» points at what is missing – the name, else the pad (ui-conventions ·
  // F2, duck sweep ELEM.4); only a signature in flight (`busy`) is natively disabled
  const nameRef = useRef<HTMLDivElement>(null)
  const padRef = useRef<HTMLDivElement>(null)
  const pointAtMissing = () => (!slot.name.trim()
    ? pointAtField(nameRef.current, { focus: nameRef.current?.querySelector<HTMLElement>('input') })
    : pointAtField(padRef.current?.querySelector<HTMLElement>('[role="img"]')))

  const submit = async () => {
    if (!ready || !strokes) return
    setBusy(true)
    try {
      if (await onSign({ role, slot: { ...slot, name: slot.name.trim() }, strokes })) onClose()
    } finally {
      setBusy(false)
    }
  }

  // on a phone the pad must be on screen without scrolling: the name's hint goes (the picker still
  // says which name it is) and the PDF button says «PDF»
  const phone = useIsPhone()
  const NO_IDS = new Set<string>()
  return (
    <Sheet open={open} onClose={onClose} fit sheetClassName={s.sheet} title={S.sheetTitle} swipeToClose={false}
      footer={<>
        <SheetClose>{S.cancel}</SheetClose>
        <Button variant="primary" disabled={busy} aria-disabled={!ready} onClick={ready ? () => void submit() : pointAtMissing}>{S.confirm}</Button>
      </>}
    >
      {/* What is signed, in two lines beside the PDF it prints as — the same on every device
          (owner, 15.10.2026: one compact block, a real button instead of an underlined link) */}
      <div className={s.whatLine}>
        <span className={s.whatText}>
          <b>{summary.einsatz}</b>
          <span>{[phone ? undefined : summary.zeiten, fillTemplate(S.personen, { n: summary.personen }), fillTemplate(S.positionen, { n: summary.positionen })].filter(Boolean).join(' · ')}</span>
        </span>
        {/* «PDF», the word the Rapport head uses for the same document on a phone */}
        {onViewPdf && <Button icon={<Icon id="doc" />} onClick={onViewPdf} aria-label={S.viewPdf}>{phone ? appConfig.copy.preflight.pdfShort : S.viewPdf}</Button>}
      </div>
      {onSetEndNow && (
        <div className={s.endMissing} role="status">
          <Icon id="warn" />
          <span className={s.endText}>{S.endMissing}</span>
          <Button onClick={onSetEndNow}>{S.endNow}</Button>
        </div>
      )}
      <div className={s.field}>
        <span className={s.label}>{S.signsAs}</span>
        <Segmented<SignatureRole>
          ariaLabel={S.signsAs}
          value={role}
          onChange={(r) => { if (r !== role) { setRole(r); setStrokes(null) } }}
          options={([['el', S.roleEl], ['kdt', S.roleKdt]] as const).map(([v, label]) => ({
            value: v,
            disabled: !!signedRoles[v] && v !== role,
            label: signedRoles[v] ? <>{label} <span className={s.done}>✓ {signedRoles[v]}</span></> : label,
          }))}
        />
      </div>
      <div className={s.field} ref={nameRef}>
        <PersonField
          label={S.name} placeholder={S.namePlaceholder}
          value={slot}
          onChange={(next) => setNames((n) => ({ ...n, [role]: next }))}
          personnel={personnel} legacyRoster={[]} presentIds={presentIds}
          assignedIds={NO_IDS} usedIds={NO_IDS} usedNames={NO_IDS}
          rolesById={rolesById}
          onAddGuest={role === 'el' ? onAddGuest : undefined}
          rankFirst officerFilter
        />
        {!phone && <span className={s.hint}>{role === 'el' ? S.elNameHint : S.kdtNameHint}</span>}
      </div>
      <div ref={padRef}>
        <SignaturePad
          value={strokes} onChange={setStrokes}
          placeDate={placeDate}
          clearLabel={S.clear} hint={S.padHint} ariaLabel={S.padAria} compact={phone}
        />
      </div>
    </Sheet>
  )
}
