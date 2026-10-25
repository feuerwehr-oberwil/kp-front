// The Prüfnachweis of one Einsatz: is the audit log's hash chain intact, as the server checks it.
// Read by the Rapport (ReportPreflight) for its Kontrolle chip and printed with the PDF.

import { useEffect, useState } from 'react'
import { verifyChain } from '../lib/incidents'
import type { AuditProof } from '../lib/report'

type ChainCheck = Awaited<ReturnType<typeof verifyChain>>

/** What the server said, in the shape the Rapport prints. */
export const proofFromChain = (r: ChainCheck, checkedAt: string): AuditProof =>
  ({ intact: r.intact, brokenAtSeq: r.broken_at_seq, count: r.count, head: r.head, checkedAt })

/** No answer (offline, or the check failed): the proof says it could not be checked — never
 *  «intact» on the strength of nothing. */
export const offlineProof = (checkedAt: string): AuditProof => ({ intact: null, checkedAt, offline: true })

/**
 * Checks the chain once per Einsatz. `checking` is true until the first answer (or failure) lands;
 * until then `proof` is the offline one, so nothing reads as intact before the server said so.
 */
export function useAuditProof(incidentId: string): { proof: AuditProof; checking: boolean } {
  const [proof, setProof] = useState<AuditProof>(() => offlineProof(new Date().toISOString()))
  const [checking, setChecking] = useState(true)
  useEffect(() => {
    let alive = true
    verifyChain(incidentId)
      .then((r) => {
        if (!alive) return
        setProof(proofFromChain(r, new Date().toISOString()))
      })
      .catch(() => {
        if (!alive) return
        setProof(offlineProof(new Date().toISOString()))
      })
      .finally(() => { if (alive) setChecking(false) })
    return () => { alive = false }
  }, [incidentId])
  return { proof, checking }
}
