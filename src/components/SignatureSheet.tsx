import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { Sheet, SheetClose } from '../lib/overlays'
import type { SignatureRole, SignatureStrokes } from '../lib/reportSignature'
import { isBlank } from '../lib/reportSignature'
import type { Person } from '../types'
import { Button } from './Button'
import { PersonField, type Slot } from './PersonField'
import { Segmented } from './Segmented'
import { useIsPhone } from '../lib/useIsPhone'
import { SignaturePad } from './SignaturePad'
import s from './SignatureSheet.module.css'

// «Rapport unterschreiben» — the one place a signature is drawn (Rapport · Unterschriften card).
// The role is a CHOICE in the form («Unterschreibt als»), the Segmented's blue, not a tab: it is an
// answer, not a place (docs/ui-conventions · Selected). The name is the roster picker, prefilled;
// for the Einsatzleiter it IS the Rapport's Einsatzleiter, written back when the signature is made.
// ⚠️ `swipeToClose={false}`: the pad owns the vertical gesture — a downward stroke of a signature
// must never dismiss the sheet it is being written on.

export interface SignSubmit {
  role: SignatureRole
  slot: Slot
  strokes: SignatureStrokes
}

export function SignatureSheet({
  open, onClose, initialRole, signedRoles, elName, kdtName, summary, placeDate, onViewPdf, onSign,
  personnel, presentIds, rolesById, onAddGuest,
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
}) {
  const S = appConfig.copy.signature
  const [role, setRole] = useState<SignatureRole>(initialRole)
  const [names, setNames] = useState<Record<SignatureRole, Slot>>({ el: elName, kdt: kdtName })
  const [strokes, setStrokes] = useState<SignatureStrokes | null>(null)
  const [busy, setBusy] = useState(false)
  const roleLabel = role === 'el' ? S.roleEl : S.roleKdt
  const slot = names[role]
  const ready = !isBlank(strokes) && !!slot.name.trim() && !busy

  const submit = async () => {
    if (!ready || !strokes) return
    setBusy(true)
    try {
      if (await onSign({ role, slot: { ...slot, name: slot.name.trim() }, strokes })) onClose()
    } finally {
      setBusy(false)
    }
  }

  // on a phone the pad must be on screen without scrolling: the summary shrinks to one line and
  // the name's hint goes (the picker still says which name it is)
  const phone = useIsPhone()
  const NO_IDS = new Set<string>()
  return (
    <Sheet open={open} onClose={onClose} fit sheetClassName={s.sheet} title={S.sheetTitle} swipeToClose={false}
      footer={<>
        <SheetClose>{S.cancel}</SheetClose>
        <Button variant="primary" disabled={!ready} onClick={() => void submit()}>{S.confirm}</Button>
      </>}
    >
      {phone ? (
        <p className={s.whatLine}>
          <span>{[summary.einsatz, fillTemplate(S.personen, { n: summary.personen }), fillTemplate(S.positionen, { n: summary.positionen })].join(' · ')}</span>
          {onViewPdf && <button type="button" className={s.whatPdf} onClick={onViewPdf}>{S.viewPdf}</button>}
        </p>
      ) : (
      <dl className={s.what}>
        <div className={s.whatHead}>
          <span>{S.whatHead}</span>
          {onViewPdf && <button type="button" className={s.whatPdf} onClick={onViewPdf}>{S.viewPdf}</button>}
        </div>
        <dt>{S.whatEinsatz}</dt><dd>{summary.einsatz}</dd>
        {summary.zeiten && <><dt>{S.whatZeiten}</dt><dd>{summary.zeiten}</dd></>}
        <dt>{S.whatPersonal}</dt><dd>{fillTemplate(S.personen, { n: summary.personen })}</dd>
        <dt>{S.whatMaterial}</dt><dd>{fillTemplate(S.positionen, { n: summary.positionen })}</dd>
      </dl>
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
      <div className={s.field}>
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
      <SignaturePad
        value={strokes} onChange={setStrokes}
        caption={fillTemplate(S.padCaption, { role: roleLabel })}
        placeDate={placeDate}
        clearLabel={S.clear} hint={S.padHint} ariaLabel={S.padAria}
      />
      <p className={s.note}>{S.lockNote}</p>
    </Sheet>
  )
}
