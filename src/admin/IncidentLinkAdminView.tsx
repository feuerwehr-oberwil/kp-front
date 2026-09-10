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
// The page is ONE settings sheet (admin/ui · «the settings table»): three group dividers, one
// per surface, each carrying its own prose in the divider's ⓘ, and rows for the key's state,
// the freshly minted value and the link shape the other system needs. Only the action row is a
// full-width note, because a row of buttons is not a setting. The rows themselves are the shared
// `SecretRows` (admin/ui) — the same component the Statistik-Export's `SecretCard` wraps in a
// sheet of its own, so all four secret surfaces read alike.

import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { SecretRows, SettingsSheet, useSecret } from './ui'

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

  const docsUrl = `${D.repo}${D.incidentLink}`

  return (
    <SettingsSheet>
      <SecretRows
        secret={secret}
        // this surface calls the value a Schlüssel, not a Token — it signs, it does not authenticate
        copy={C}
        docsUrl={docsUrl}
        showKey
        // The URL shape the alerting system composes around its own signed token — the one thing
        // besides the key an operator has to type into the other system.
        // ⚠️ `<token>` STAYS a placeholder here, and this is the one surface where it must. The
        // two standing links below hand out a real address because their key IS the token in it
        // (terminalEnrollUrl / standingAsUrl); this key only SIGNS the tokens the alerting system
        // mints per Einsatz, so there is no link for KP Front to show — and pasting the key into
        // the URL would publish the signing secret in a link that opens nothing.
        example={() => `${window.location.origin}/l/<token>`}
      />
      <SecretRows secret={terminal} copy={T} docsUrl={docsUrl} showKey example={terminalEnrollUrl} />
      <SecretRows
        secret={standing}
        copy={A}
        docsUrl={docsUrl}
        example={standingAsUrl}
        print={{ label: A.printBtn, run: () => void printCard() }}
      />
    </SettingsSheet>
  )
}
