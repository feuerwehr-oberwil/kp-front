import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { signedIndex } from './floorPack'
import type { AlignmentListItem, MarkerWarning } from './planAlignmentApi'

/**
 * «Der Export ist falsch» – said out loud, wherever a plan is looked at (16.09.2026).
 *
 * A plan PDF can prepare itself with `§` markers, and when it gets them wrong the worker writes
 * NO floors: the admin saw an object at «Vorschlag bereit» with an empty Geschoss list and no
 * idea that a `§4OG]` was missing and a `§[EG` sat off the page (Allschwilerstrasse 100). The
 * backend now reports each fault as a CODE (`app/plan_markers.py` · `MarkerWarning`); this is the
 * one place that turns codes into German sentences and the one warn note every surface draws.
 *
 * ⚠️ The codes are the contract, not the sentences: a locale that has no key for a code renders
 * the code itself rather than nothing, so a new backend code is visible (and ugly) instead of
 * silent. Add it to `admin.alignment.markerWarnings` in de first, then the overlays.
 */
export const markerWarnings = (item: { marker_notes: AlignmentListItem['marker_notes'] }): MarkerWarning[] =>
  item.marker_notes?.warnings ?? []

/** True where a plan's own markers need fixing – what turns a Status badge amber. */
export const hasMarkerWarnings = (item: { marker_notes: AlignmentListItem['marker_notes'] } | null | undefined): boolean =>
  !!item && markerWarnings(item).length > 0

/** −0.0276, with a real minus sign: this is a coordinate, and it is read, not computed with. */
const number = (v: number) => v.toFixed(4).replace('-', '−')

/** One warning as its German sentence; an unknown code prints itself rather than disappearing. */
export function markerWarningText(warning: MarkerWarning): string {
  const W = appConfig.copy.admin.alignment.markerWarnings as Record<string, string>
  const template = W[warning.code]
  if (!template) return warning.code
  return fillTemplate(template, {
    tag: warning.tag ?? '',
    have: warning.have ?? '',
    label: warning.label ?? '',
    page: warning.page ?? '',
    other: warning.other ?? '',
    axis: warning.axis ?? '',
    count: warning.count ?? '',
    detail: warning.detail ?? '',
    storey: warning.storey != null ? signedIndex(warning.storey) : '',
    side: warning.side === 'tl' ? W.sideTl : warning.side === 'br' ? W.sideBr : '',
    value: warning.value != null ? number(warning.value) : '',
  })
}

/**
 * The compact warn note under the full-screen editor's header: one line per fault, then the one
 * sentence that says where the fix belongs. No heading and no chrome – it stands in the same
 * amber band as «Dieser Stand wurde ersetzt» (`.adm-align-notice`), because it answers the same
 * kind of question.
 */
export function MarkerNotes({ item }: { item: { marker_notes: AlignmentListItem['marker_notes'] } }) {
  const W = appConfig.copy.admin.alignment.markerWarnings
  const warnings = markerWarnings(item)
  if (!warnings.length) return null
  return <div className="adm-align-notice adm-marker-notes" role="status">
    <ul>{warnings.map((w, i) => <li key={i}>{markerWarningText(w)}</li>)}</ul>
    <p>{W.fix}</p>
  </div>
}
