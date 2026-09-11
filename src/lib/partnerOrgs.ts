import type { PartnerContact } from './workspace'

/**
 * Partnerorganisationen — the rule both surfaces that record them follow.
 *
 * The Rapport sheet (ReportPreflight) and the Erfassungs-Poster (capture/CaptureApp) ask the
 * same question with the same checklist, and both let an organisation the station's list does
 * not carry be typed. The matching and the de-duplication used to be written out twice, which
 * is the shape of duplication that drifts: one surface trimmed, the other did not.
 */

/** One organisation, however it was spelled: trimmed and case-folded. «Polizei», «polizei » and
 *  « POLIZEI» are one organisation, and one organisation gets one row. */
const key = (o?: string): string => (o ?? '').trim().toLowerCase()

/** The station's own organisations that are NOT on this incident yet — what the add picker
 *  offers without typing. Whatever is already recorded has its own row above it, and offering
 *  it again would put one organisation in two places with two different remarks. */
export function unlistedPartnerOrgs(
  presets: readonly string[], partners: readonly PartnerContact[],
): string[] {
  return presets.filter((o) => !partners.some((p) => key(p.org) === key(o)))
}

/**
 * Search-to-create: the typed (or picked) name IS the new row.
 *
 * Returns the next list, or `null` when there is nothing to add — an empty name, or one the
 * sheet already carries. Null rather than the unchanged list, so a caller never writes a no-op
 * to the blob and never reports «gespeichert» for a row nobody got.
 *
 * ⚠️ A name the station's list carries is appended AS THAT organisation, so its checklist row
 * ticks on instead of a second, free row standing beside it. The checklist itself is untouched
 * by all of this: an unticked row still proves the organisation was considered.
 */
export function addPartnerOrg(
  partners: readonly PartnerContact[], typed: string,
): PartnerContact[] | null {
  const org = typed.trim()
  if (!org) return null
  if (partners.some((p) => key(p.org) === key(org))) return null
  return [...partners, { org }]
}
