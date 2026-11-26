import { useEffect, useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { Button } from './Button'
import { ShellLoader } from './ShellLoader'
import type { ReactivateResult } from '../types'

/** The page of a closed Einsatz (owner, 12.11.2026): read-only until «Wieder öffnen», and it
 *  says so where the hand looks for the fields – with the reopen right beside it for a session
 *  that may. The reopen runs while the strip stays up (the confirm is upstream, as on the Einsatz
 *  card's closed fold); a success flips the workspace live and the strip goes with `closed`.
 *  The Rapport (ReportPreflight) and the Anwesenheit (owner pick UX journeys B3·24, 25.11.2026)
 *  show the same strip – one state, one sentence, one way out. Styles: 13-incident · `.rp-band`. */
export function ClosedStrip({ onReopen }: { onReopen?: () => Promise<ReactivateResult> }) {
  const C = appConfig.copy.archived
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const reopen = () => {
    if (!onReopen || busy) return
    setBusy(true)
    // a failure is said by the caller's own toast; a cancelled confirm leaves the strip as it was
    void onReopen().catch(() => {}).finally(() => { if (alive.current) setBusy(false) })
  }
  return (
    <div className="rp-band rp-band-open rp-band-closed" role="note">
      <Icon id="lock" className="rp-band-wait" />
      <span className="rp-band-txt">{onReopen ? C.rapportClosedHint : C.rapportClosedViewOnly}</span>
      {onReopen && (
        <Button disabled={busy} aria-busy={busy || undefined} icon={busy ? <ShellLoader /> : undefined} onClick={reopen}>{busy ? C.reopening : C.reactivate}</Button>
      )}
    </div>
  )
}
