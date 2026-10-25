// --- Rapportangaben that BOTH sides write ----------------------------------------------------
//
// The Rapport is not a dialog: it is opened early in an Einsatz and left open for hours, while
// the workspace syncs every few seconds and the Einsatzleiter fills in the same sheet on the
// iPad next to it. Every field used to be seeded from `reportMeta` ONCE, at mount, and then
// ignored the prop for the rest of the Einsatz — so the form showed the state it opened on, and
// (the real damage) wrote all fifteen of those stale values back into the blob on the next
// keystroke in any one of them. A Kurzbericht typed on the iPad was gone the moment somebody
// touched the Bemerkung on the laptop. «Der Einsatzrapport synchronisiert nicht.»
//
// `useSyncedField` is the three-way merge that replaces the seeding. Two rules, and they are
// the same rule seen from both ends:
//   • what this operator did NOT touch follows the blob (adoption), and
//   • what this operator DID touch is all this device is allowed to write back (`dirty`,
//     reportForm · dirtyFormMeta).
// Used by ReportPreflight; every synced field's wrapper carries a `data-sync` marker.

import { useEffect, useState } from 'react'
import { dtLocalToIso } from '../lib/format'
import type { PartnerContact } from '../lib/workspace'
import { numOrU, partnerFilled } from './reportForm'

/** Which synced field the caret is in, by the `data-sync` marker on its wrapper — `null` when
 *  the focus is anywhere else on the sheet. One attribute per field beats an onFocus/onBlur pair
 *  on every input, half of which are custom components that forward neither. */
const focusedSyncField = (): string | null => {
  const el = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
  return el?.closest?.('[data-sync]')?.getAttribute('data-sync') ?? null
}

/** Canonical forms. A round trip through the LOCAL shape must not read as a change — a
 *  Kurzbericht is trimmed on the way to the blob, `dtLocalValue` drops the seconds off an ISO
 *  stamp, a Stepper writes «3» where the blob holds 3 — and a field that looks edited because
 *  of one of those would clobber the blob exactly as before. */
export const normText = (v: string) => v.trim()
export const normDtLocal = (v: string) => dtLocalToIso(v) ?? ''
export const normCount = (v: string) => String(numOrU(v) ?? '')
export const normList = (v: unknown[]) => JSON.stringify(v)
/** blank partner rows live on screen and never reach the blob, so they are not a change either */
export const normPartners = (v: PartnerContact[]) => JSON.stringify(v.filter(partnerFilled))

/**
 * Every focus move inside the sheet, counted. An adoption held back because the caret was in
 * the field (see useSyncedField) has to be retried when the operator leaves it, and «the field
 * was left» is not a prop change — nothing else would re-run the effect. Both halves of the
 * move are counted because `focusout` fires BEFORE the next element has the focus, so the
 * reading taken on the way out can still name the field being left.
 */
export function useBlurTick(): number {
  const [blurTick, setBlurTick] = useState(0)
  useEffect(() => {
    const moved = (e: FocusEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-sync]')) setBlurTick((t) => t + 1)
    }
    document.addEventListener('focusin', moved)
    document.addEventListener('focusout', moved)
    return () => {
      document.removeEventListener('focusin', moved)
      document.removeEventListener('focusout', moved)
    }
  }, [])
  return blurTick
}

/**
 * One Rapportangabe, merged with whatever the other devices have made of it.
 *
 * @param name    the field's `data-sync` marker — how «is the caret in here right now» is asked
 * @param remote  what the blob says, already in this field's LOCAL shape (dtLocal string, list,
 *                «» for absent), so the two sides are comparable at all
 * @param norm    the field's canonical form (see above)
 * @param tick    bumped on every focus move inside the sheet (useBlurTick), so an adoption that
 *                was held back for the caret is retried the moment the field is left
 *
 * ⚠️ Nothing is ever yanked out from under a typing operator: while the field has the caret the
 * remote value waits, and the field stays CLEAN while it waits — so what this device saves is
 * the blob's value, not the stale text still on screen. `dirty` is exactly what the save may
 * carry (reportForm · dirtyFormMeta), and it clears itself the moment the write lands back in
 * `reportMeta`.
 */
export function useSyncedField<T>(
  name: string, remote: T, norm: (v: T) => string, tick: number,
): readonly [T, (next: T) => void, boolean] {
  const [value, setValue] = useState(remote)
  const [dirty, setDirty] = useState(false)
  const rn = norm(remote)
  const ln = norm(value)
  useEffect(() => {
    // In sync — which is also how a local edit stops being dirty: every field here persists on
    // change and the workspace echoes the write straight back, so one render later the blob
    // says what the operator typed and this device has nothing left of its own to defend.
    if (rn === ln) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the write landed; nothing to defend
      if (dirty) setDirty(false)
      return
    }
    if (dirty) return                        // this operator's edit is the newer one — it stands
    if (focusedSyncField() === name) return  // …or is being typed right now: adopt on blur (tick)
    setValue(remote)                         // adoption: the blob moved, an untouched field follows
    // `remote` itself is deliberately not a dep — it is compared through `norm`, so a new array
    // identity that says the same thing must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rn, ln, dirty, tick, name])
  const set = (next: T) => { setDirty(true); setValue(next) }
  return [value, set, dirty] as const
}
