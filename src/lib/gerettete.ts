// «Gerettete» on the Rapport, read off the Lage.
//
// The Rettungs-Symbol already carries both numbers: its count stepper reads «Anzahl Personen» on
// this symbol and the second field is «Anzahl Tiere» (config/appConfig · VKF Rettungen). So the
// Rapport was asking for a figure that had been standing on the map all along, and somebody had
// to re-count the Kroki by eye at the end of an Einsatz to answer it.
//
// This only ever OFFERS the number. The Rapport is what somebody wrote, not what the app worked
// out — so the strip in the form states its source and fills the fields on a tap, exactly like
// the Material surface's «Gesetzt, aber nicht erfasst» (lib/mittel · mittelRecommendations).

import { appConfig } from '../config/appConfig'

/** The bits of a placed symbol this reads — Lage entities and plan-board annotations alike. */
export interface RescueCandidate {
  /** the object's own id — the SAME id on both views of one record (see geretteteFromLage) */
  id?: string
  symbol?: string
  count?: number
  fields?: Record<string, string>
}

export interface GeretteteCount {
  personen: number
  tiere: number
}

/** The «Anzahl Tiere» field, as configured on the Rettungs-Symbol. */
const TIERE_FIELD = 'Anzahl Tiere'

function num(v: string | undefined): number {
  const n = Number.parseInt((v ?? '').trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Add up every Rettungs-Symbol standing on the Lage and the plans.
 *
 * Counts them ALL, whatever their Status — «vermisst», «eingesperrt» and «gerettet» are states a
 * symbol passes THROUGH, and at the end of an Einsatz the ones still reading «vermisst» are
 * normally just the ones nobody went back to re-tap. Filtering on the status would quietly drop
 * real rescues; over-offering is visible and one tap away from being corrected, which is the
 * safer way round for a number that goes on a Rapport.
 *
 * ⚠️ An unset count is ONE person, animals or not. The editors store the stepper's 1 as
 * `undefined` (IncidentWorkspace / Whiteboard normalise it away) and the stepper's floor is 1 —
 * the panel literally reads «Anzahl Personen: 1» on such a symbol, so counting it as 0 would
 * silently lose the person on «1 Person und 3 Tiere». An animals-only rescue is unrepresentable
 * in the editor; until it is, the symbol counts the person its panel shows (decided 11.09.).
 *
 * ⚠️ IDS COLLIDE BY DESIGN, so one record is counted ONCE. Since the unified-objects rework
 * `entities` and `board` are two VIEWS of the same records (lib/tacticalObjects · viewsOf,
 * lib/planProjection · projectOnto), and the caller hands us their union: a rescue near one
 * georeferenced plan arrives twice, near two plans three times, `count` carried verbatim. A
 * candidate without an id is its own record — the dedup only ever skips a repeated id.
 */
export function geretteteFromLage(placed: readonly RescueCandidate[]): GeretteteCount {
  const rescue = appConfig.symbols.rescueName
  const seen = new Set<string>()
  let personen = 0
  let tiere = 0
  for (const p of placed) {
    if (p.symbol !== rescue) continue
    if (p.id != null) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
    }
    const animals = num(p.fields?.[TIERE_FIELD])
    tiere += animals
    personen += p.count ?? 1
  }
  return { personen, tiere }
}

/** Is there anything to offer, and does it differ from what the form already says? A strip that
 *  repeats the figure already in the field is noise — and it must come back when either side
 *  moves, which is why the caller compares values rather than remembering it was dismissed. */
export function geretteteOffer(
  lage: GeretteteCount,
  form: { personen?: number; tiere?: number },
): GeretteteCount | null {
  if (!lage.personen && !lage.tiere) return null
  if ((form.personen ?? 0) === lage.personen && (form.tiere ?? 0) === lage.tiere) return null
  return lage
}
