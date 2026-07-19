// UN-number → hazardous-substance reference lookup.
//
// Backs the Gefahrentafel auto-fill: a firefighter types the 4-digit UN number
// from the orange ADR plate, and we surface the substance + its key hazard data
// (ADR class, placard labels, Kemler/Gefahrnummer, packing group).
//
// ── Source ────────────────────────────────────────────────────────────────────
// Normalised from the official UNECE ADR 2023 "Table A" (Chapter 3.2 — the
// alphabetical list of dangerous goods), via the machine-readable extract
//   https://github.com/rkstgr/adr-substances  (file ADR2023_Substances.csv)
// which mirrors Table A as published by UNECE (https://unece.org/adr — the ADR
// agreement text is an intergovernmental public document). Substance names and
// column headers in that source are German; English names below are a small
// curated set for the most common substances — name_en is null when we have no
// verified translation (we do NOT machine-translate safety data).
//
// ⚠️ ACCURACY CAVEAT: this dataset has NOT yet been reviewed by a domain expert.
// It must be checked by a qualified firefighter / dangerous-goods officer before
// any operational use. The Kemler/Gefahrnummer is taken verbatim from the source
// and is empty for many entries (e.g. class 1 explosives) — that is expected.

import raw from '../data/unHazard.json'
import { appConfig } from '../config/appConfig'

export interface UnHazardEntry {
  /** 4-digit UN number as a string, e.g. "1203" (leading zeros preserved). */
  un: string
  /** Substance name in German (from ADR Table A), e.g. "BENZIN oder OTTOKRAFTSTOFF". */
  name_de: string | null
  /** English name — curated, null when not verified. */
  name_en: string | null
  /** ADR hazard class, e.g. "3" (flammable liquid), "2" (gas). */
  class: string | null
  /** ADR classification code, e.g. "F1", "2TOC". */
  classificationCode: string | null
  /** Packing group I / II / III, or null when not applicable. */
  packingGroup: 'I' | 'II' | 'III' | null
  /** Placard (Gefahrzettel) classes, e.g. ["2.3", "5.1", "8"]. */
  hazardLabels: string[]
  /** Orange-plate hazard identification number (Kemler / Gefahrnummer), e.g. "33". */
  hazardNumber: string | null
  /** True when the substance is prohibited from transport under ADR. */
  transportProhibited?: boolean
}

const entries = raw as UnHazardEntry[]

// Index by normalised UN key for O(1) lookup.
const byUn = new Map<string, UnHazardEntry>()
for (const e of entries) byUn.set(normalizeUN(e.un), e)

/** Strip a leading "UN"/"UN-"/spaces and drop leading zeros for matching. */
export function normalizeUN(un: string): string {
  return un
    .trim()
    .toUpperCase()
    .replace(/^UN[\s-]*/, '')
    .replace(/\s+/g, '')
    .replace(/^0+(?=\d)/, '')
}

/**
 * Look up a UN number. Accepts "1203", "UN 1203", "un-1203", "0004", etc.
 * Returns the matching entry, or null if unknown.
 */
export function lookupUN(un: string): UnHazardEntry | null {
  if (!un) return null
  return byUn.get(normalizeUN(un)) ?? null
}

/** The full normalised dataset (read-only). */
export function allEntries(): readonly UnHazardEntry[] {
  return entries
}

// ── Kemler / Gefahrnummer decoding ──────────────────────────────────────────────
// The orange-plate hazard-identification number (Kemler code) tells responders the
// nature of the hazard at a glance — crucially whether WATER may be used. We decode it
// locally (no lookup needed) so the "können wir löschen / was ist sonst gefährlich?"
// question is answered offline. Each digit names a hazard; a doubled digit intensifies
// it; a leading "X" means the substance reacts dangerously with water. The digit→meaning labels
// are user-facing copy (appConfig.copy.contextPanel.kemler), read inside decodeKemler.

export interface KemlerInfo {
  /** leading "X" — reacts dangerously with water (do NOT use water to extinguish) */
  reactsWithWater: boolean
  /** human-readable hazard meanings (German), primary hazard first */
  hazards: string[]
}

/** Decode a Kemler/Gefahrnummer (e.g. "33", "X323", "268") into its hazard meanings.
 *  Returns null when there's nothing decodable. */
export function decodeKemler(code: string | null | undefined): KemlerInfo | null {
  if (!code) return null
  const raw = code.trim().toUpperCase()
  const reactsWithWater = raw.startsWith('X')
  const digits = raw.replace(/^X/, '')
  if (!/^\d{2,4}$/.test(digits)) return reactsWithWater ? { reactsWithWater, hazards: [] } : null
  const cp = appConfig.copy.contextPanel
  const hazards: string[] = []
  for (let i = 0; i < digits.length; i++) {
    const d = digits[i]
    if (i > 0 && d === '0') continue // trailing 0 = no additional hazard
    if (i > 0 && d === digits[i - 1]) { hazards.push(cp.kemlerDoubled); continue }
    const meaning = cp.kemler[d]
    if (meaning && !hazards.includes(meaning)) hazards.push(meaning)
  }
  return { reactsWithWater, hazards }
}
