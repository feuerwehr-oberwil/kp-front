import { appConfig } from '../config/appConfig'
import type { Trupp, TruppAuftrag, TruppFields } from '../types'
import { isAtemschutzTrupp, truppFieldsOf } from './atemschutz'
import type { LeitungOption } from './truppLines'

/**
 * The phone card's mini sheets — Kanal · Auftrag · Trupp (26.09.2026, phone card slim-down,
 * docs/planning/az-card-2026-09-26 · Runde 3).
 *
 * The opened phone card stopped being a place to READ everything and went back to «unit, verb,
 * value»; what it no longer says in words it says as tappable facts, and each fact opens ONE
 * short sheet for that fact alone. Every sheet writes through `editTrupp` with the fields the
 * Trupp has NOW and only its own group changed (`truppFieldsOf`), so the Verlauf row, the undo
 * step and the Rapport are exactly what the big form's save produces — there is no second write
 * path, only more doors to the one that exists.
 *
 * This module is the pure half: what a sheet offers and what it hands the write. The frames live
 * in components/TruppSheets.
 */

/**
 * How many channels a keypad can honestly show. The doctrine's ceiling is a FREE number (the
 * shipped default is 9999 — digital and relay schemes count that high, appConfig · funkkanalMax),
 * and a pad of 2 500 rows is not a pad. Up to a Handfunk's 1–99 the sheet lays every channel out
 * as a key (scrolled to the current one); above that the stepper the form uses takes over, with
 * a Speichern of its own.
 */
export const KANAL_PAD_MAX = 99

/** The channels a Kanal sheet lays out as keys — `min…max` inclusive, or `null` when the station's
 *  range is too wide for a pad (KANAL_PAD_MAX) or nonsensical (max below min). */
export function kanalPad(min: number, max: number): number[] | null {
  const lo = Math.ceil(min), hi = Math.floor(max)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null
  const n = hi - lo + 1
  if (n > KANAL_PAD_MAX) return null
  return Array.from({ length: n }, (_, i) => lo + i)
}

/** The Auftrag tiles a sheet offers THIS Trupp — the list that matches its Art, as the form does
 *  (a Verkehrstrupp was once offered «Löschen»); labels localised through copy · auftragLabels. */
export function quickAuftragTypes(t: Trupp): { id: TruppAuftrag; label: string }[] {
  const cfg = appConfig.atemschutz
  const az = appConfig.copy.atemschutz
  const list: readonly { id: TruppAuftrag; label: string }[] = isAtemschutzTrupp(t) ? cfg.auftrag : cfg.auftragEinfach
  return list.map((a) => ({ id: a.id, label: az.auftragLabels[a.id] ?? a.label }))
}

/**
 * The Leitung chips: every hose actually DRAWN (lib/truppLines · leitungOptions, a number somebody
 * else is on stays pickable and says so) — plus this Trupp's own stored number when nothing drawn
 * carries it, so the chip that is «on» is always on screen and a Leitung a hose was deleted under
 * can still be let go of. Ascending, one chip per number.
 */
export function leitungChoices(t: Trupp, options: readonly LeitungOption[]): LeitungOption[] {
  const out = [...options]
  const own = t.lineNo
  if (own != null && Number.isFinite(own) && !out.some((o) => o.no === own)) out.push({ no: own, onPlan: false })
  return out.sort((a, b) => a.no - b.no)
}

/** What the Auftrag sheet's Speichern hands `editTrupp`: the Trupp as it stands, with ITS three
 *  fields replaced — an empty Ziel and «keine» Leitung clear theirs (absent, never ''), as the
 *  form's save does. */
export function auftragSheetFields(t: Trupp, v: { auftrag: TruppAuftrag | null | undefined; ziel: string; lineNo: number | null }): TruppFields {
  return truppFieldsOf(t, {
    auftrag: v.auftrag ?? undefined,
    ziel: v.ziel.trim() || undefined,
    lineNo: v.lineNo ?? undefined,
  })
}

/** …and the Kanal sheet's one tap: the same Trupp, one channel. */
export function kanalSheetFields(t: Trupp, funkkanal: number): TruppFields {
  return truppFieldsOf(t, { funkkanal })
}
