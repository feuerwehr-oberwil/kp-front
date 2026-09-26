import type { ReportMeta } from './workspace'
import { jsonEqual } from './jsonEqual'

/**
 * What ONE step back on the Einsatzrapport is.
 *
 * The Rapport is the one record surface that had no way back at all (field report 18.09.2026:
 * «Rettungen eingetragen, Zahl war falsch, Rückgängig macht nichts»). It could not simply join
 * the timeline the way Mittel and the Checklisten did, because it does not write once per
 * action: every textarea on it persists on every KEYSTROKE (see ReportPreflight · persist), so
 * a checkpoint per write would have filled the whole history with one Kurzbericht and made ↶
 * give back a single character.
 *
 * So a write is classified here, and the answer is the same shape the Verlauf logger already
 * uses one level up: a burst of typing in the same field is ONE step, and anything that makes a
 * value or a row appear or disappear is its own.
 */

/** ⚠️ Not the operator's edits. `reportMadeAt`, `printJob` and `krokiPrint` are written by the
 *  app — a PDF was produced, a print job is outstanding, the last print was framed like this —
 *  and a ↶ that offered to take one of those back would be answering a question nobody asked.
 *  A write that touches only these lays no step down at all. */
export const REPORT_MACHINE_FIELDS: readonly (keyof ReportMeta)[] = ['reportMadeAt', 'printJob', 'krokiPrint']

/**
 * A restored snapshot, with the app's own bookkeeping taken from the LIVE state instead.
 *
 * Those fields lay no step down (above), so they ride along inside whatever step stands — and a
 * ↶ of that step would hand back the bookkeeping as it was when the step was taken. That wipes
 * a `printJob` that is still outstanding: `settlePrintJob` then finds nothing to stamp and the
 * «in der Warteschlange» / «Rapport erstellt» marks are simply gone, for an undo of a sentence
 * somebody typed. So they ride OUTSIDE the snapshot: a step back moves the operator's Rapport
 * and leaves the machine's answer about the world exactly as it is.
 */
export function keepMachineFields(restored: ReportMeta, live: ReportMeta): ReportMeta {
  const out: Record<string, unknown> = { ...restored }
  for (const k of REPORT_MACHINE_FIELDS) {
    if (live[k] === undefined) delete out[k]
    else out[k] = live[k]
  }
  return out as ReportMeta
}

/** How long a burst of typing stays ONE step. Deliberately the same beat as the Verlauf's
 *  `META_LOG_SETTLE_MS`: what reaches the record as one line is what ↶ takes back as one step. */
export const REPORT_COALESCE_MS = 4000

export interface ReportStep {
  /** which edit this is — two writes with the same key, close enough together, are one step */
  key: string
  /** something appeared or disappeared: always its own step, however fast it followed the last
   *  one. «Keine» on the Rettungen deletes both counts; unticking a Partnerorganisation deletes
   *  its Bemerkung with it — those are exactly the presses somebody wants back, and folding one
   *  into the keystrokes before it would hand back the typing instead. */
  structural: boolean
}

const same = (a: unknown, b: unknown) => jsonEqual(a ?? null, b ?? null)

/** The `ReportMeta` fields this write moved — by value, so a re-serialised identical list is
 *  not a change (the sheet rebuilds its arrays on every render). */
export function changedReportFields(prev: ReportMeta, next: ReportMeta): (keyof ReportMeta)[] {
  const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)])
  return [...keys]
    .filter((k) => !same(prev[k as keyof ReportMeta], next[k as keyof ReportMeta]))
    .sort() as (keyof ReportMeta)[]
}

/**
 * Classify one Rapport write. `null` = nothing an operator would want back (no change at all,
 * or only the app's own bookkeeping).
 */
export function reportStep(prev: ReportMeta, next: ReportMeta): ReportStep | null {
  const changed = changedReportFields(prev, next)
  if (!changed.length) return null
  if (changed.every((k) => REPORT_MACHINE_FIELDS.includes(k))) return null
  let structural = false
  const parts = changed.map((k) => {
    const a = prev[k]
    const b = next[k]
    if (Array.isArray(a) || Array.isArray(b)) {
      const an = Array.isArray(a) ? a.length : 0
      const bn = Array.isArray(b) ? b.length : 0
      // a row appeared or went — a Partnerorganisation, a Gruppe's Alarmzeit, a Fahrzeugzeile.
      // The LENGTH rides in the key as well, so the edits either side of it can never merge
      // across the add: «Sanität ergänzt» and «Bemerkung getippt» are two different things.
      if (an !== bn) structural = true
      return `${k}#${bn}`
    }
    // a value was CLEARED (the ✕ on a Stepper, «Entfällt», the trash on a free row)
    if (b === undefined && a !== undefined) structural = true
    return k as string
  })
  return { key: parts.join('+'), structural }
}

/** Does this write belong to the step that already stands? Only a non-structural write, on the
 *  same field(s), within the burst window. */
export function foldsIntoPrevious(
  last: { key: string; at: number } | null,
  cur: ReportStep,
  now: number,
  windowMs = REPORT_COALESCE_MS,
): boolean {
  if (!last || cur.structural) return false
  return last.key === cur.key && now - last.at <= windowMs && now >= last.at
}
