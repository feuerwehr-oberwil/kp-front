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
 * ⚠️ An untouched count on a symbol that DOES state animals contributes no person. The count
 * stepper is empty until somebody sets it, and a Stall with twelve cows is «12 Tiere», not
 * «1 Person und 12 Tiere» — reading the default as a person would invent people out of every
 * animal rescue. Everywhere else an unset count means the one thing the symbol marks.
 */
export function geretteteFromLage(placed: readonly RescueCandidate[]): GeretteteCount {
  const rescue = appConfig.symbols.rescueName
  let personen = 0
  let tiere = 0
  for (const p of placed) {
    if (p.symbol !== rescue) continue
    const animals = num(p.fields?.[TIERE_FIELD])
    tiere += animals
    personen += p.count ?? (animals ? 0 : 1)
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
