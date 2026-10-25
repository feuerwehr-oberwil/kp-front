// Which of the Rapport's signatures still hold, and whether they lock the form (15.10.2026,
// docs/rapport.md · Unterschriften). Used by ReportPreflight and drawn by <ReportSignatures>.

import { useMemo, useState } from 'react'
import { formatDateTime } from '../lib/report'
import type { PrintedSignature } from '../lib/reportPdfDirect'
import {
  activeSignatures, shortChecksum, signatureState, SIGNATURE_ROLES, type ReportSignature, type SignatureRole,
} from '../lib/reportSignature'

export type LiveSignatures = Partial<Record<SignatureRole, ReportSignature>>

/** The live signature per role — minus any made before the latest close, which signed a Rapport
 *  that has since been reopened (a reopen ends every signature). */
export function liveSignatures(all: readonly ReportSignature[], closedAt: string | null | undefined): LiveSignatures {
  const a = activeSignatures(all)
  for (const r of SIGNATURE_ROLES) if (a[r] && closedAt && a[r].at < closedAt) delete a[r]
  return a
}

/** The valid signatures as the paper prints them; a signature that no longer holds is left off,
 *  and its line prints empty (decision 15.10.2026). Nothing on a running Einsatz. */
export function printedSignatures(live: LiveSignatures, isValid: (r: SignatureRole) => boolean, closed: boolean): PrintedSignature[] {
  return SIGNATURE_ROLES.flatMap((r) => {
    const g = live[r]
    if (!closed || !g || !isValid(r)) return []
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
 */
export function useSignatureLock(reportSignatures: readonly ReportSignature[], closedAt: string | null | undefined, closed: boolean) {
  const [scopeHash, setScopeHash] = useState<string | undefined>()
  const liveSigs = useMemo(() => liveSignatures(reportSignatures, closedAt), [reportSignatures, closedAt])
  const sigValid = (r: SignatureRole) => !!liveSigs[r] && signatureState(liveSigs[r], scopeHash) === 'valid'
  /** signed and still valid: the form is read-only until somebody chooses «Ändern» */
  const signedLock = closed && SIGNATURE_ROLES.some(sigValid)
  return { liveSigs, sigValid, signedLock, setScopeHash }
}
