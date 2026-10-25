// «Zeiten» on the capture page: the Alarmierungs- (Gruppen) and Ausrückzeiten (Fahrzeuge) grid,
// the same rows as the EL's Rapport form (lib/alarmzeiten).

import { appConfig } from '../config/appConfig'
import { fillTemplate, hhmm } from '../lib/format'
import { TimeField } from '../components/TimeField'
import { fahrzeugRows, gruppenRows } from '../lib/alarmzeiten'
import type { ReportMeta } from '../lib/workspace'
import { AccSection } from './AccSection'

/** the shell's wiring for one section (CaptureApp owns which one is open) */
type Shell = { open: boolean; onToggle: () => void; sectionRef: (el: HTMLElement | null) => void }

type Props = Shell & {
  busy: boolean
  rm: ReportMeta | undefined
  zeitDays: Date[]
  gruppenCfg: Parameters<typeof gruppenRows>[0]
  fahrzeugeCfg: Parameters<typeof fahrzeugRows>[0]
  onGruppeZeit: (id: string, hhmm: string | null, day?: Date) => void
  onFahrzeugZeit: (id: string, hhmm: string | null, day?: Date) => void
}

/** The Zeiten section: one TimeField per configured Gruppe and Fahrzeug. */
export function ZeitenSection({ open, onToggle, sectionRef, busy, rm, zeitDays, gruppenCfg, fahrzeugeCfg, onGruppeZeit, onFahrzeugZeit }: Props) {
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
                <TimeField ariaLabel={c.label} value={hhmm(v?.alarmedAt)} disabled={busy} days={zeitDays}
                  valueDay={v?.alarmedAt ? new Date(v.alarmedAt) : undefined}
                  onCommit={(hhmm, day) => onGruppeZeit(c.id, hhmm, day)} />
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
                <TimeField ariaLabel={c.label} value={hhmm(v?.ausgerueckt)} disabled={busy} days={zeitDays}
                  valueDay={v?.ausgerueckt ? new Date(v.ausgerueckt) : undefined}
                  onCommit={(hhmm, day) => onFahrzeugZeit(c.id, hhmm, day)} />
              </span>
            ))}
          </div>
        </>
      )}
    </AccSection>
  )
}
