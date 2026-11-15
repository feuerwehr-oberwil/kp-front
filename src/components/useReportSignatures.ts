// Which of the Rapport's signatures still hold (15.10.2026; open or closed since 14.11.2026,
// docs/rapport.md · Unterschriften). Used by ReportPreflight and drawn by <ReportSignatures>.

import { useEffect, useState } from 'react'
import { formatDateTime } from '../lib/report'
import type { PrintedSignature } from '../lib/reportPdfDirect'
import {
  sha256Hex, shortChecksum, signatureState, SIGNATURE_ROLES, type ReportSignature, type SignatureRole, type SignatureState,
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
 * The signatures' state against the signed part as it stands in THIS render (`signedPart`,
 * reportPdfDirect · signedPartOf – '' while there is no signature to check). The part is hashed
 * whenever it changes; a hash of an earlier content never answers for the current one, so between
 * an edit and its hash a signature is `pending` – shown as neither valid nor «ungültig», and
 * locking nothing. Closing or reopening the Einsatz does not touch a signature (owner,
 * 14.11.2026): only the hash decides.
 */
export function useSignatureLock(liveSigs: LiveSignatures, signedPart: string, closed: boolean) {
  const [hashed, setHashed] = useState<{ part: string; hash: string }>()
  useEffect(() => {
    if (!signedPart) return
    let alive = true
    void sha256Hex(signedPart).then((hash) => { if (alive) setHashed({ part: signedPart, hash }) }, () => {})
    return () => { alive = false }
  }, [signedPart])
  const scopeHash = hashed?.part === signedPart ? hashed.hash : undefined
  const sigState = (r: SignatureRole): SignatureState | undefined => {
    const g = liveSigs[r]
    return g && signatureState(g, scopeHash)
  }
  const sigValid = (r: SignatureRole) => sigState(r) === 'valid'
  /** a signature still holds – the open form stays editable (an edit makes it «ungültig») */
  const anyValid = SIGNATURE_ROLES.some(sigValid)
  /** …on a closed Einsatz the Rapport is read-only anyway; a valid signature also stops what the
   *  signing and printing would still record (the Einsatzleiter written back, the stamps) */
  const signedLock = closed && anyValid
  return { sigState, anyValid, signedLock }
}

/** The signatures to print on a Rapport whose signed part is `signedPart` – hashed afresh at the
 *  moment of printing, so the paper never carries a signature the content no longer matches. */
export async function signaturesToPrint(liveSigs: LiveSignatures, signedPart: string): Promise<PrintedSignature[]> {
  if (!SIGNATURE_ROLES.some((r) => liveSigs[r])) return []
  const hash = await sha256Hex(signedPart)
  return printedSignatures(liveSigs, (r) => liveSigs[r]?.scope === hash)
}
