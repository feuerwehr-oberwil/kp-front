// «Partnerorganisationen» on the capture page.
// ⚠️ Partnerorganisationen and Beilagen used to be two rows INSIDE Angaben. Each grows
// into a stack of its own, and a label sitting in the left gutter next to a three-row
// block lines up with nothing — so they became sections like Personen and Material.
// Every block on this page now opens and closes the same way.
// the same two fields the tablet asks for: which organisation (the station's own
// list, free text allowed) and one free line for whatever is worth saying. It rides
// `reportMeta`, which the poster already reads and writes — nothing new is exposed.

import type { Dispatch, SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { Icon } from '../lib/icons'
import type { PartnerContact } from '../lib/workspace'
import type { Workspace } from '../lib/incidents'
import type { CaptureAction } from '../lib/captureClient'
import { AccSection } from './AccSection'


/** the shell's wiring for one section (CaptureApp owns which one is open) */
type Shell = { open: boolean; onToggle: () => void; sectionRef: (el: HTMLElement | null) => void }

type Props = Shell & {
  busy: boolean
  partners: PartnerContact[]
  /** the station's list, ticked or not, then anything recorded that is not on it (`i` = index in partners, −1 = unticked) */
  partnerRows: { org: string; i: number; custom: boolean }[]
  partnerDraft: string
  setPartnerDraft: Dispatch<SetStateAction<string>>
  commitPartner: () => void
  savePartner: (i: number, over: Partial<PartnerContact>) => void
  removePartner: (i: number) => void
  run: (action: CaptureAction) => Promise<Workspace | null>
}

/** The Partnerorganisationen section: one tick row per organisation, then the type-to-add field. */
export function PartnerSection({
  open, onToggle, sectionRef, busy, partners, partnerRows, partnerDraft, setPartnerDraft, commitPartner, savePartner,
  removePartner, run,
}: Props) {
  const C = appConfig.copy.capture
  return (
    <AccSection open={open} label={C.partnersHead}
      sub={partners.length ? fillTemplate(C.partnerCount, { n: partners.length }) : C.partnerNone}
      onToggle={onToggle} sectionRef={sectionRef}>
      <div className="cv-partners">
        {partnerRows.map((r) => {
          const on = r.i >= 0
          return (
            <div className={`cv-partner${on ? ' on' : ''}`} key={r.custom ? `c${r.i}` : r.org}>
              {/* a free row names itself in its own field — see the Rapport sheet */}
              <button
                type="button" className={`cv-partner-tick${r.custom ? ' bare' : ''}`}
                role="checkbox" aria-checked={on} disabled={busy} aria-label={r.org || C.partnerOrg}
                onClick={() => (on
                  ? removePartner(r.i)
                  : void run({ kind: 'setMeta', patch: { partnerContacts: [...partners, { org: r.org }] } }))}
              >
                <span className="cv-partner-box">{on && <Icon id="check" />}</span>
                {!r.custom && <span className="cv-partner-org">{r.org}</span>}
              </button>
              {on && r.custom && (
                <input
                  className="cv-input cv-partner-name" defaultValue={partners[r.i].org ?? ''}
                  placeholder={C.partnerOrg} aria-label={C.partnerOrg} disabled={busy}
                  onBlur={(e) => savePartner(r.i, { org: e.target.value.trim() })}
                />
              )}
              {on && (
                <input
                  className="cv-input" defaultValue={partners[r.i].note ?? ''} placeholder={C.partnerNote}
                  aria-label={`${r.org || C.partnerOrg} – ${C.partnerNote}`} disabled={busy}
                  onBlur={(e) => savePartner(r.i, { note: e.target.value.trim() || undefined })}
                />
              )}
              {on && r.custom && (
                <button type="button" className="cv-btn cv-btn-ghost" aria-label={C.partnerRemove}
                  title={C.partnerRemove} disabled={busy} onClick={() => removePartner(r.i)}>
                  <Icon id="trash" />
                </button>
              )}
            </div>
          )
        })}
        {/* the list covers the usual partners; the unexpected one still has to fit — and
            it fits by being TYPED, not by opening a blank row first (see addPartner).
            ⚠️ A PLAIN field since 18.09.2026, not a picker: the menu suggested the
            station's own organisations, i.e. the very rows standing above it.
            A <fieldset> because `run()` drops a save that lands while another is in
            flight: an add nobody can see fail is worse than a control that is briefly
            not tappable. */}
        <fieldset className="cv-partner-add" disabled={busy}>
          <input
            className="cv-input" value={partnerDraft} placeholder={C.partnerPlaceholder} aria-label={C.partnerAdd}
            maxLength={80}
            onChange={(e) => setPartnerDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitPartner() } }}
          />
          <button type="button" className="cv-btn cv-btn-ghost" title={C.partnerAdd} aria-label={C.partnerAdd}
            disabled={!partnerDraft.trim()} onClick={commitPartner}>
            <Icon id="plus" />
          </button>
        </fieldset>
      </div>
    </AccSection>
  )
}
