// Einsatz-Link: manage the minting key (GET/POST/DELETE /api/incident-link/secret). The
// alerting system holds this key and signs the link tokens it puts into the alert itself —
// KP Front generates the key, hands it out once, and is never called to mint a link.
// Rotation invalidates every link already sent out at once. Fail-closed: no key → the whole
// link surface is off, so deleting the key IS the off switch.
//
// Since 2026-09-09 this surface also carries the two STANDING links (backend/app/api/
// incident_link · «THE STANDING LINKS»): the Stations-Terminal (enroll a depot PC once, it
// shows whichever Einsatz is open) and the fixe Atemschutz-URL (a laminated QR that opens the
// Überwachungstafel of the running Einsatz). Same trio each, on their own keys — rotating one
// never touches the others.
//
// The first two cards are the shared secret-token card (admin/ui · useSecret + SecretCard);
// the Atemschutz card is its own markup because it hangs a printable QR card (A5 PDF, lazy
// jsPDF chunk — see standingAsPdf) between the rows, like the Erfassungs-Poster does.

import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { Card, ConfirmButton, CopyChip, ResultChip, SecretCard, StatusBadge, useSecret } from './ui'

const standingAsUrl = (token: string) => `${window.location.origin}/l/s${token}`
const terminalEnrollUrl = (token: string) => `${window.location.origin}/l/t${token}`

export function IncidentLinkAdminView() {
  const C = appConfig.copy.admin.einsatzlink
  const T = appConfig.copy.admin.terminal
  const A = appConfig.copy.admin.atemschutzUrl
  // Doc addresses live in the copy layer (admin.docs) — one line for a fork to retarget.
  const D = appConfig.copy.admin.docs
  const secret = useSecret('/api/incident-link/secret', { rotated: C.rotated, disabled: C.disabled, failed: C.failed })
  const terminal = useSecret('/api/incident-link/terminal/secret', { rotated: T.rotated, disabled: T.disabled, failed: T.failed })
  const standing = useSecret('/api/incident-link/atemschutz/secret', { rotated: A.rotated, disabled: A.disabled, failed: A.failed })

  const printCard = async () => {
    if (!standing.state?.token) return
    try {
      const { downloadStandingAsCard } = await import('./standingAsPdf')
      await downloadStandingAsCard(standingAsUrl(standing.state.token), getDeploymentConfig().identity?.appName ?? 'KP Front')
    } catch { standing.report('err', A.printFailed) }
  }

  return (
    <>
      <SecretCard
        secret={secret}
        // this surface calls the value a Schlüssel, not a Token — it signs, it does not authenticate
        copy={{ ...C, tokenLabel: C.keyLabel }}
        docsUrl={`${D.repo}${D.incidentLink}`}
        // The URL shape the alerting system composes around its own signed token — the one thing
        // besides the key an operator has to type into the other system.
        example={() => `${window.location.origin}/l/<token>`}
      />

      <SecretCard
        secret={terminal}
        copy={{ ...T, tokenLabel: T.keyLabel }}
        docsUrl={`${D.repo}${D.incidentLink}`}
        example={terminalEnrollUrl}
      />

      {standing.state !== null && (
        <Card>
          <p className="adm-card-cap">{A.body}</p>
          <div className="adm-cap-rows">
            <div className="adm-cap-status">
              <StatusBadge tone={standing.state.configured ? 'on' : 'off'} label={A.stateLabel} state={standing.state.configured ? A.stateOn : A.stateOff} />
            </div>
            {standing.state.token && (
              <div className="adm-cap-example">
                <p className="adm-card-cap">{A.exampleLabel} — <a href={`${D.repo}${D.incidentLink}`} target="_blank" rel="noreferrer">{A.docsLink}</a></p>
                <CopyChip value={standingAsUrl(standing.state.token)} />
              </div>
            )}
          </div>
          <div className="adm-actions">
            {standing.state.configured ? (
              <>
                <button type="button" className="btn adm-save-btn" disabled={standing.busy} onClick={() => void printCard()}>{A.printBtn}</button>
                <ConfirmButton label={A.rotateBtn} question={A.rotateMsg} disabled={standing.busy} onConfirm={() => void standing.rotate()} />
                <ConfirmButton label={A.disableBtn} question={A.disableMsg} danger disabled={standing.busy} onConfirm={() => void standing.disable()} />
              </>
            ) : (
              <button type="button" className="btn adm-save-btn" disabled={standing.busy} onClick={() => void standing.rotate()}>{A.enableBtn}</button>
            )}
            {standing.result && <ResultChip tone={standing.result.tone} onExpire={standing.clearResult}>{standing.result.text}</ResultChip>}
          </div>
          <p className="adm-card-cap">{A.hint}</p>
        </Card>
      )}
    </>
  )
}
