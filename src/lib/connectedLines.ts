import { fmtDistance, pathLengthM } from './geo'
import { lineLabel } from './lineDecor'
import type { LineAttachment, LngLat } from '../types'

// its own module, not lineDecor.tsx: a plain function beside components costs the Fast-refresh
// boundary a warning (react-refresh/only-export-components)

/**
 * A line's row under «Verbundene Linien» (29.09.2026, sweep K11). Two rows «Linie ›» «Linie ›»
 * could not be told apart without tapping both, so a line with no name of its own (no label, no
 * Leitung number) says what DOES tell it apart: its length and its far end — «Linie · 42 m →
 * Hydrant H-142». A named or numbered line keeps its name («Leitung 1»); the name already differs.
 * `selfId` is the object whose panel lists it (its own end is not news); `nameOf` names the far
 * end's object, undefined when it is not one we can name (a live layer feature).
 */
export function connectedLineLabel(
  d: { label?: string; lineNo?: number; content?: string; coords: LngLat[]; startAttachment?: LineAttachment; endAttachment?: LineAttachment },
  selfId: string,
  nameOf: (id: string) => string | undefined,
): string {
  const base = lineLabel(d)
  if (d.label || d.lineNo != null) return base
  const far = [d.endAttachment, d.startAttachment].find((a) => a?.target.kind === 'object' && a.target.id !== selfId)
  const farName = far?.target.kind === 'object' ? nameOf(far.target.id) : undefined
  const len = d.coords.length >= 2 ? fmtDistance(pathLengthM(d.coords)) : ''
  return [base, len].filter(Boolean).join(' · ') + (farName ? ` → ${farName}` : '')
}
