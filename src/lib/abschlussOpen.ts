import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import type { AbschlussStep } from './abschluss'
import type { ConfirmItem } from './overlays/ConfirmCard'

/**
 * The still-open points of «Einsatz abschliessen», as things you can TAP.
 *
 * The print side has said them as links since the `ConfirmItem` list went in: «Noch offen:
 * Zeiten» named the gap, the operator closed the dialog and then hunted for the Zeiten
 * themselves. The Abschluss confirm — the other door onto the same list, and the one that ends
 * the Einsatz — was still plain text (18.09.2026). Same failure, worse moment: it is the last
 * screen before the Akte closes.
 *
 * So the list lives here, once, and both callers ask it for rows. The Abschluss knows about two
 * open points the Rapport's own «noch offen» chips do not — a Trupp nobody reported back in, and
 * captures still sitting on this device — and those get targets too.
 */
export type AbschlussOpenPoint =
  | { kind: 'step'; step: AbschlussStep }
  /** Trupps still recorded as being out there (lib/atemschutz · truppStillDeployed) */
  | { kind: 'trupps'; n: number }
  /** photos/audio still in this device's upload queue */
  | { kind: 'media'; n: number }
  /** people the Suche still lists as missing (lib/suche · vermisstCount) — «2 Personen noch
   *  vermisst: Einsatz trotzdem beenden?» (24.09.2026) */
  | { kind: 'vermisst'; n: number }
  /** Bereiche not abgesucht — a HINT only: an area nobody needed to search is no gap */
  | { kind: 'bereiche'; names: string[] }

/** Where each kind of open point is answered. Every kind has one — see the note on `media`. */
export interface AbschlussOpenTargets {
  /** open the Rapport ON that Mindestangabe (ReportPreflight · requestReportStep) */
  step: (step: AbschlussStep) => void
  /** the Atemschutz-Tafel, where a Trupp is reported back in */
  trupps: () => void
  /** ⚠️ Not a surface: an upload is answered by getting a connection, so the target is the
   *  Bereitschaft sheet — the one place that says what is still outstanding and carries «Jetzt
   *  synchronisieren». There is nothing else to point at, and pointing at nothing was the bug. */
  media: () => void
  /** the Suche, where a person is found or entwarnt and an area marked (optional: a caller that
   *  has no Suche never produces these points) */
  suche?: () => void
}

export function abschlussOpenPoints(
  missing: AbschlussStep[], truppsStillOut: number, pendingMedia: number,
  suche?: { vermisst: number; openBereiche: string[] },
): AbschlussOpenPoint[] {
  return [
    // the missing come FIRST: of everything on this list, it is the one that is about a person
    ...(suche && suche.vermisst > 0 ? [{ kind: 'vermisst', n: suche.vermisst } as const] : []),
    ...missing.map((step): AbschlussOpenPoint => ({ kind: 'step', step })),
    ...(truppsStillOut > 0 ? [{ kind: 'trupps', n: truppsStillOut } as const] : []),
    ...(pendingMedia > 0 ? [{ kind: 'media', n: pendingMedia } as const] : []),
    ...(suche && suche.openBereiche.length ? [{ kind: 'bereiche', names: suche.openBereiche } as const] : []),
  ]
}

/** What a point is CALLED — the same words the Rapport's chips and the print warning use. */
export function abschlussOpenLabel(p: AbschlussOpenPoint): string {
  const P = appConfig.copy.preflight
  switch (p.kind) {
    case 'step': return appConfig.copy.abschluss.steps[p.step]
    case 'trupps': return fillTemplate(P.truppsDeployedConfirm, { n: p.n })
    case 'media': return fillTemplate(P.pendingMediaConfirm, { n: p.n })
    case 'vermisst': return p.n === 1 ? appConfig.copy.suche.abschlussVermisstOne : fillTemplate(appConfig.copy.suche.abschlussVermisst, { n: p.n })
    case 'bereiche': return fillTemplate(appConfig.copy.suche.abschlussBereiche, { list: p.names.join(', ') })
  }
}

/**
 * Does this point make the Abschluss an «trotzdem»?
 *
 * ⚠️ Pending media does NOT (unchanged): it is a fact about this device, not a gap in the
 * record, and the Abschluss drains the queue itself before it hands over. It is on the list
 * because the operator is about to walk away, not because something is missing.
 * ⚠️ Nor does a Bereich not abgesucht (24.09.2026): a hint — a storey nobody had to search is no
 * gap. A person still MISSING does, and first.
 */
export const countsAsOpen = (p: AbschlussOpenPoint): boolean => p.kind !== 'media' && p.kind !== 'bereiche'

/** The rows the confirm renders. Tapping one resolves the ask `false` (going there is not going
 *  ahead) and then navigates — see overlays/ConfirmCard · ConfirmItem. */
export function abschlussOpenItems(points: AbschlussOpenPoint[], go: AbschlussOpenTargets): ConfirmItem[] {
  return points.map((p) => ({
    label: abschlussOpenLabel(p),
    onClick: () => {
      if (p.kind === 'step') go.step(p.step)
      else if (p.kind === 'trupps') go.trupps()
      else if (p.kind === 'vermisst' || p.kind === 'bereiche') go.suche?.()
      else go.media()
    },
  }))
}

/**
 * The words on the Rapport head's ONE Kontrolle chip (23.09.2026): what is still open for the
 * Abschluss, and how many warnings about the record there are — «4 noch offen», «1 Hinweis»,
 * «2 Hinweise», «4 noch offen · 2 Hinweise». It used to read «{n} Hinweis(e)» for both summed,
 * so four missing Mindestangaben announced themselves as four «Hinweise» — a word for something
 * to note, on the things that have to be filled in.
 */
export function controlChipLabel(open: number, hints: number): string {
  const P = appConfig.copy.preflight
  return [
    open > 0 ? fillTemplate(P.controlOpen, { n: open }) : '',
    hints === 1 ? P.controlHint : hints > 1 ? fillTemplate(P.controlHints, { n: hints }) : '',
  ].filter(Boolean).join(' · ')
}
