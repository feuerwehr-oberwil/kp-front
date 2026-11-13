// «Zeiten» on the capture page: the Alarmierungs- (Gruppen) and Ausrückzeiten (Fahrzeuge) grid,
// the same rows as the EL's Rapport form (lib/alarmzeiten).

import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { DateTimeField } from '../components/TimeField'
import { fahrzeugRows, gruppenRows } from '../lib/alarmzeiten'
import type { ReportMeta } from '../lib/workspace'
import { AccSection } from './AccSection'

/** the shell's wiring for one section (CaptureApp owns which one is open) */
type Shell = { open: boolean; onToggle: () => void; sectionRef: (el: HTMLElement | null) => void }

type Props = Shell & {
  busy: boolean
  rm: ReportMeta | undefined
  zeitDays: Date[]
  /** the Alarmierung — where an empty row's picker opens */
  alarmIso: string
  gruppenCfg: Parameters<typeof gruppenRows>[0]
  fahrzeugeCfg: Parameters<typeof fahrzeugRows>[0]
  onGruppeZeit: (id: string, iso: string | null) => void
  onFahrzeugZeit: (id: string, iso: string | null) => void
}

/** The Zeiten section: one date + time field per configured Gruppe and Fahrzeug. */
export function ZeitenSection({ open, onToggle, sectionRef, busy, rm, zeitDays, alarmIso, gruppenCfg, fahrzeugeCfg, onGruppeZeit, onFahrzeugZeit }: Props) {
  const C = appConfig.copy.capture
  return (
    <AccSection open={open} label={C.sectionZeiten} sub={fillTemplate(C.zeitenFilled, { n: (rm?.gruppen ?? []).filter((g) => g.alarmedAt).length + (rm?.fahrzeuge ?? []).filter((f) => f.ausgerueckt).length })}
      onToggle={onToggle} sectionRef={sectionRef}>
      {gruppenRows(gruppenCfg, rm?.gruppen).length > 0 && (
        <>
          <div className="cv-subhead">{C.gruppenHead}</div>
          <div className="cv-zgrid">
            {gruppenRows(gruppenCfg, rm?.gruppen).map(({ config: c, value: v }) => (
              <span key={c.id} className="cv-zrow">
                <span className="cv-zname">{c.label}{c.color ? ` (${c.color})` : ''}</span>
                <DateTimeField ariaLabel={c.label} value={v?.alarmedAt} disabled={busy} days={zeitDays}
                  opensOn={alarmIso} onCommit={(iso) => onGruppeZeit(c.id, iso)} />
              </span>
            ))}
          </div>
        </>
      )}
      {fahrzeugRows(fahrzeugeCfg, rm?.fahrzeuge).length > 0 && (
        <>
          <div className="cv-subhead">{C.fahrzeugeHead}</div>
          <div className="cv-zgrid">
            {fahrzeugRows(fahrzeugeCfg, rm?.fahrzeuge).map(({ config: c, value: v }) => (
              <span key={c.id} className="cv-zrow">
                <span className="cv-zname">{c.label}</span>
                <DateTimeField ariaLabel={c.label} value={v?.ausgerueckt} disabled={busy} days={zeitDays}
                  opensOn={alarmIso} onCommit={(iso) => onFahrzeugZeit(c.id, iso)} />
              </span>
            ))}
          </div>
        </>
      )}
    </AccSection>
  )
}
