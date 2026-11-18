// «Material» on the capture page: the WHOLE catalogue as optimistic steppers, plus the recorded
// lines that are not a plain catalogue row. State and the debounced flush live in CaptureApp.

import type { Dispatch, SetStateAction } from 'react'
import { appConfig } from '../config/appConfig'
import { unitLabel } from '../lib/format'
import { SearchField } from '../components/SearchField'
import { Stepper } from '../components/Stepper'
import { Button } from '../components/Button'
import { currentLineFor, type CurrentMittel } from '../lib/mittel'
import type { MittelEntry } from '../types'
import type { ReportMeta } from '../lib/workspace'
import type { DeploymentMittelItem } from '../lib/deploymentConfig'
import type { Workspace } from '../lib/incidents'
import type { CaptureAction } from '../lib/captureClient'
import { AccSection } from './AccSection'

/** What a stepper writes a line against (lib/captureClient · setMittel). */
export type MatProbe = { materialId?: string; label: string; unit: string; sourceId?: string; sourceLabel?: string }

/** the shell's wiring for one section (CaptureApp owns which one is open) */
type Shell = { open: boolean; onToggle: () => void; sectionRef: (el: HTMLElement | null) => void }

type Props = Shell & {
  busy: boolean
  rm: ReportMeta | undefined
  mittel: MittelEntry[]
  /** the visible recorded lines (lib/mittel · visibleMittel) — counted in the head */
  lines: CurrentMittel[]
  /** the catalogue, grouped by category and filtered by the search */
  shownGroups: readonly (readonly [string, readonly DeploymentMittelItem[]])[]
  extraLines: CurrentMittel[]
  matSearch: string
  setMatSearch: Dispatch<SetStateAction<string>>
  /** optimistic counts not yet flushed, by line key */
  matPending: Record<string, number>
  stepMittel: (key: string, probe: MatProbe, displayed: number, delta: number) => void
  run: (action: CaptureAction) => Promise<Workspace | null>
}

/** The Material section: «Nichts verwendet», the catalogue steppers and the extra lines. */
export function MaterialSection({
  open, onToggle, sectionRef, busy, rm, mittel, lines, shownGroups, extraLines, matSearch, setMatSearch, matPending,
  stepMittel, run,
}: Props) {
  const C = appConfig.copy.capture
  const AB = appConfig.copy.abschluss
  return (
    <AccSection open={open} label={C.sectionMaterial} sub={C.mittelCount(lines.length)} onToggle={onToggle}
      step="mittel" sectionRef={sectionRef}>
      <div className="cv-search-row cv-sticky-search">
        <SearchField className="cv-search" placeholder={C.searchMaterial} aria-label={C.searchMaterial} value={matSearch} onChange={setMatSearch} />
      </div>
      {/* «Nichts verwendet» — the same tick the tablet's Rapport carries (lib/abschluss ·
          stepDone). Without it the Material chip in the «noch offen» list could not be
          cleared from this page at all: an Einsatz where nothing was used is a legitimate
          rapport, but only once somebody has SAID so.
          The «Entfällt» model, as on the tablet's Rapport (owner, duck sweep ELEM.9,
          17.11.2026): a button that SETS the answer; answered, the dashed read-out and
          «Ändern» (docs/ui-conventions.md · Editor sheets: «none»). It goes away with the
          first line, which answers the step instead. */}
      {lines.length === 0 && (rm?.mittelConfirmedNone ? (
        <div className="rz-none cv-none">
          <span className="rz-none-val">{AB.mittelNone}</span>
          <Button disabled={busy}
            onClick={() => { void run({ kind: 'setMeta', patch: { mittelConfirmedNone: false } }) }}>
            {appConfig.copy.preflight.entfaelltUndo}
          </Button>
        </div>
      ) : (
        <Button className="cv-none" disabled={busy}
          onClick={() => { void run({ kind: 'setMeta', patch: { mittelConfirmedNone: true } }) }}>
          {AB.mittelNone}
        </Button>
      ))}
      {shownGroups.map(([cat, items]) => (
        <div key={cat || '_'} className="cv-matgroup">
          {cat && <div className="cv-matgroup-head">{cat}</div>}
          <ul className="cv-mittel">
            {items.map((item) => {
              const key = `mat:${item.id}`
              const probe = { materialId: item.id, label: item.label, unit: item.unit || appConfig.mittel.defaultUnit }
              const serverCur = currentLineFor(mittel, { ...probe, sourceId: undefined, sourceLabel: undefined })?.menge ?? 0
              const cur = matPending[key] ?? serverCur
              return (
                <li key={item.id} className={cur > 0 ? 'used' : ''}>
                  <span className="cv-mittel-label">{item.label}</span>
                  <Stepper value={cur} min={0} max={9999} ariaLabel={`${item.label} ${unitLabel(probe.unit)}`}
                    format={(v) => `${v} ${unitLabel(probe.unit)}`}
                    onChange={(v) => stepMittel(key, probe, cur, v - cur)} />
                </li>
              )
            })}
          </ul>
        </div>
      ))}
      {extraLines.length > 0 && (
        <div className="cv-matgroup">
          <div className="cv-matgroup-head">{C.mittelExtra}</div>
          <ul className="cv-mittel">
            {extraLines.map((l) => {
              const probe = { materialId: l.materialId, label: l.label, unit: l.unit, sourceId: l.sourceId, sourceLabel: l.sourceLabel }
              const cur = matPending[l.key] ?? l.menge
              return (
                <li key={l.key} className="used">
                  <span className="cv-mittel-label">{l.label}{l.sourceLabel ? ` · ${l.sourceLabel}` : ''}</span>
                  <Stepper value={cur} min={0} max={9999} ariaLabel={`${l.label}${l.sourceLabel ? ` · ${l.sourceLabel}` : ''}`}
                    format={(v) => `${v}${l.unit ? ` ${unitLabel(l.unit)}` : ''}`}
                    onChange={(v) => stepMittel(l.key, probe, cur, v - cur)} />
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </AccSection>
  )
}
