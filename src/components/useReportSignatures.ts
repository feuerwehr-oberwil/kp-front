// Which of the Rapport's signatures still hold (15.10.2026; open or closed since 14.11.2026,
// docs/rapport.md · Unterschriften). Used by ReportPreflight and drawn by <ReportSignatures>.

import { useMemo, useState } from 'react'
import { formatDateTime } from '../lib/report'
import type { PrintedSignature } from '../lib/reportPdfDirect'
import {
  activeSignatures, shortChecksum, signatureState, SIGNATURE_ROLES, type ReportSignature, type SignatureRole,
} from '../lib/reportSignature'

export type LiveSignatures = Partial<Record<SignatureRole, ReportSignature>>

/** The valid signatures as the paper prints them – open or closed alike; a signature that no
 *  longer holds is left off, and its line prints empty (decision 15.10.2026). */
export function printedSignatures(live: LiveSignatures, isValid: (r: SignatureRole) => boolean): PrintedSignature[] {
  return SIGNATURE_ROLES.flatMap((r) => {
    const g = live[r]
    if (!g || !isValid(r)) return []
    const date = formatDateTime(g.at)
    return [{
      role: r, name: g.name,
      placeDate: [g.place, date.split(' ')[0]].filter(Boolean).join(', '),
      at: date,
      checksum: shortChecksum(g.scope),
      strokes: g.strokes,
    }]
  })
}

/**
 * The signatures' state, at the TOP of the Rapport: the lock has to be known before anything
 * uses `canEdit`. The signed part's hash as it stands now (`scopeHash`) is computed further down,
 * once the form exists, and handed back through `setScopeHash`; until it is known every live
 * signature counts as valid (lib/reportSignature · signatureState), so nothing flashes «ungültig».
 * Closing or reopening the Einsatz does not touch a signature (owner, 14.11.2026): only the hash
 * decides.
 */
export function useSignatureLock(reportSignatures: readonly ReportSignature[], closed: boolean) {
  const [scopeHash, setScopeHash] = useState<string | undefined>()
  const liveSigs: LiveSignatures = useMemo(() => activeSignatures(reportSignatures), [reportSignatures])
  const sigValid = (r: SignatureRole) => !!liveSigs[r] && signatureState(liveSigs[r], scopeHash) === 'valid'
  /** a signature still holds – the open form stays editable (an edit makes it «ungültig») */
  const anyValid = SIGNATURE_ROLES.some(sigValid)
  /** …on a closed Einsatz the Rapport is read-only anyway; a valid signature also stops what the
   *  signing and printing would still record (the Einsatzleiter written back, the stamps) */
  const signedLock = closed && anyValid
  return { liveSigs, sigValid, anyValid, signedLock, setScopeHash }
}
