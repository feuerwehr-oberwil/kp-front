// «Angaben» on the capture page: Einsatzleiter, Kontaktperson (+ Telefon), Gerettete and the
// Kurzbericht. Unconditional — its fields are the rapport's own, not station config.

import { appConfig } from '../config/appConfig'
import { telHref } from '../lib/format'
import { Icon } from '../lib/icons'
import { Combo } from '../components/Combo'
import { Stepper } from '../components/Stepper'
import type { ReportMeta } from '../lib/workspace'
import type { IncidentMeta, Workspace } from '../lib/incidents'
import type { CaptureAction, CapturePerson } from '../lib/captureClient'
import { AccSection } from './AccSection'
import { DraftField } from './DraftField'


/** the shell's wiring for one section (CaptureApp owns which one is open) */
type Shell = { open: boolean; onToggle: () => void; sectionRef: (el: HTMLElement | null) => void }

type Props = Shell & {
  incident: IncidentMeta
  rm: ReportMeta | undefined
  roster: CapturePerson[]
  rankOf: (name: string) => string | undefined
  kontaktperson: string | undefined
  kontaktTel: string | undefined
  savedPersonen: number | null
  savedTiere: number | null
  setGerettete: (personen: number | null, tiere: number | null) => void
  run: (action: CaptureAction) => Promise<Workspace | null>
  /** the debounced text fields' meta save — bypasses run()'s busy gate (CaptureApp · flushMeta) */
  flushMeta: (patch: Partial<ReportMeta>) => Promise<boolean>
  markPickedPresent: (name: string, saved: Workspace, note?: string) => Promise<void>
  savedToast: () => void
}

/** The Angaben section. */
export function AngabenSection({
  open, onToggle, sectionRef, incident, rm, roster, rankOf, kontaktperson, kontaktTel, savedPersonen, savedTiere,
  setGerettete, run, flushMeta, markPickedPresent, savedToast,
}: Props) {
  const C = appConfig.copy.capture
  return (
    <AccSection open={open} label={C.sectionAngaben} sub={rm?.einsatzleiter ?? '—'} onToggle={onToggle} sectionRef={sectionRef}>
      <div className="cv-row" data-step="einsatzleiter">
        <span>{C.einsatzleiter}</span>
        <div className="cv-rueck-name">
          <Combo
            value={rm?.einsatzleiter ?? ''}
            options={roster.map((p) => p.display_name)}
            placeholder={C.rueckName}
            allowCustom
            officerFilter
            rankOf={rankOf}
            onChange={(v) => {
              void run({ kind: 'setMeta', patch: { einsatzleiter: v || undefined } }).then(async (saved) => {
                if (!saved) return
                savedToast()
                // the Einsatzleiter was there, and the Personalblatt should say WHY the
                // name is on it — the Bemerkung only fills an empty one
                await markPickedPresent(v, saved, appConfig.copy.anwesenheit.roleEinsatzleiter)
              })
            }}
          />
        </div>
      </div>
      <div className="cv-row" data-step="kontaktperson">
        <span>{C.kontaktperson}</span>
        <div className="cv-row-controls cv-kontakt">
          <DraftField key={`${incident.id}:kontaktperson`} incidentId={incident.id} field="kontaktperson"
            saved={kontaktperson ?? ''} className="cv-input cv-kontakt-name" placeholder={C.kontaktpersonPlaceholder}
            ariaLabel={C.kontaktperson} autoCapitalize="words" enterKeyHint="done"
            commit={async (raw) => {
              const v = raw.trim()
              if (v === (kontaktperson ?? '')) return true
              const ok = await flushMeta({ kontaktperson: v })
              if (ok) savedToast()
              return ok
            }} />
          <DraftField key={`${incident.id}:kontaktpersonTelefon`} incidentId={incident.id} field="kontaktpersonTelefon"
            saved={kontaktTel ?? ''} className="cv-input cv-kontakt-tel" placeholder={C.kontaktpersonTelefonPlaceholder}
            ariaLabel={C.kontaktpersonTelefon} tel enterKeyHint="done"
            commit={async (raw) => {
              const v = raw.trim()
              if (v === (kontaktTel ?? '')) return true
              const ok = await flushMeta({ kontaktpersonTelefon: v })
              if (ok) savedToast()
              return ok
            }} />
          {/* dials the SAVED number — this surface lives on the phone in someone's hand */}
          {telHref(kontaktTel) && (
            <a className="cv-call" href={telHref(kontaktTel)}
              aria-label={C.kontaktpersonCall} title={C.kontaktpersonCall}>
              <Icon id="phone" />
            </a>
          )}
        </div>
      </div>
      <div className="cv-row">
        <span>{C.gerettete}</span>
        {/* «–» while unanswered and the ✕ only with a value — the Rapport's Gerettete pair, one
            look for one question (29.09.2026) */}
        <div className="cv-row-controls cv-counts">
          <label className="cv-count-row"><span>{C.gerettetePersonen}</span>
            <Stepper value={savedPersonen} min={0} max={999} seed={1} ariaLabel={C.gerettetePersonen}
              onChange={(v) => setGerettete(v, savedTiere)}
              onClear={savedPersonen != null ? () => setGerettete(null, savedTiere) : undefined} canClear />
          </label>
          <label className="cv-count-row"><span>{C.geretteteTiere}</span>
            <Stepper value={savedTiere} min={0} max={999} seed={1} ariaLabel={C.geretteteTiere}
              onChange={(v) => setGerettete(savedPersonen, v)}
              onClear={savedTiere != null ? () => setGerettete(savedPersonen, null) : undefined} canClear />
          </label>
        </div>
      </div>
      {/* Kurzbericht lives HERE (moved from its own Bericht section 2026-07-18 —
          one section fewer; Bemerkungen dropped: it only duplicated confusion) */}
      <div className="cv-row top" data-step="kurzbericht">
        <span>{C.kurzberichtHead}</span>
        <DraftField key={`${incident.id}:summary`} incidentId={incident.id} field="summary"
          textarea saved={rm?.summary ?? ''} className="cv-input cv-textarea" placeholder={C.kurzberichtPlaceholder}
          ariaLabel={C.kurzberichtHead} autoCapitalize="sentences"
          commit={async (raw) => {
            const v = raw.trim()
            if (v === (rm?.summary ?? '')) return true
            const ok = await flushMeta({ summary: v || undefined })
            if (ok) savedToast()
            return ok
          }} />
      </div>
    </AccSection>
  )
}
