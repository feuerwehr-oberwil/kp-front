import { appConfig } from '../config/appConfig'
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

// ── Auf der Karte: the partners the Kroki already shows ──────────────────────────────────────
//
// A «Bereich Polizei» on the map IS the statement «die Polizei war da» — an hour later somebody
// ticks the same fact a second time on the Rapport, from memory. This reads it back off the
// symbols (appConfig.symbols.partnerOrgSymbols).
//
// It only ever OFFERS. The Rapport is what somebody wrote, not what the app worked out, so the
// strip states what it read and the ticks happen on a tap — the same promise as the Gerettete
// strip (lib/gerettete) and the Material surface's «Gesetzt, aber nicht erfasst».

/** The bits of a placed symbol this reads — Lage entities and plan-board annotations alike. */
export interface PartnerCandidate {
  /** the object's own id — the SAME id on both views of one record (see below) */
  id?: string
  symbol?: string
}

/**
 * Which of the station's own organisations are standing on the Lage and the plans.
 *
 * Returns them in the STATION's spelling and the station's order, so each one ticks the checklist
 * row it belongs to; an organisation the list does not carry is never invented (the mapping's
 * aliases exist so a list that says «Rettungsdienst» still recognises the Sanitäts-Bereich).
 *
 * ⚠️ IDS COLLIDE BY DESIGN — and that is why this returns a SET of names rather than counting
 * anything. Since the unified-objects rework `entities` and `board` are two VIEWS of the same
 * records (lib/tacticalObjects · viewsOf), and the caller hands us their union: a Polizei-Bereich
 * near one georeferenced plan arrives twice, near two plans three times. «Polizei» twice is still
 * «Polizei», so no dedup pass is needed here — unlike geretteteFromLage, which adds up counts and
 * has to skip a repeated id.
 */
export function partnerOrgsFromLage(
  placed: readonly PartnerCandidate[], presets: readonly string[],
): string[] {
  const map = appConfig.symbols.partnerOrgSymbols
  const onMap = new Set<string>()
  for (const p of placed) {
    for (const alias of (p.symbol && map[p.symbol]) || []) onMap.add(key(alias))
  }
  return presets.filter((o) => onMap.has(key(o)))
}

/** What is left to offer: the organisations the Kroki shows that the sheet does not record yet.
 *  Null when there is nothing — an already ticked organisation is not offered again, and the
 *  strip therefore disappears by itself on the tap that applies it («weg damit» and «stimmt» are
 *  the same tap, exactly as on the Gerettete strip). */
export function partnerOrgOffer(
  lage: readonly string[], partners: readonly PartnerContact[],
): string[] | null {
  const open = unlistedPartnerOrgs(lage, partners)
  return open.length ? open : null
}
