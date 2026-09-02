// Einsatz-Link: manage the minting key (GET/POST/DELETE /api/incident-link/secret). The
// alerting system holds this key and signs the link tokens it puts into the alert itself —
// KP Front generates the key, hands it out once, and is never called to mint a link.
// Rotation invalidates every link already sent out at once. Fail-closed: no key → the whole
// link surface is off, so deleting the key IS the off switch.
//
// The card itself is the shared secret-token card (admin/ui · useSecret + SecretCard) — the
// same object the Statistik token and the Erfassungs-Poster secret are.

import { appConfig } from '../config/appConfig'
import { SecretCard, useSecret } from './ui'

export function IncidentLinkAdminView() {
  const C = appConfig.copy.admin.einsatzlink
  // Doc addresses live in the copy layer (admin.docs) — one line for a fork to retarget.
  const D = appConfig.copy.admin.docs
  const secret = useSecret('/api/incident-link/secret', { rotated: C.rotated, disabled: C.disabled, failed: C.failed })
  return (
    <SecretCard
      secret={secret}
      // this surface calls the value a Schlüssel, not a Token — it signs, it does not authenticate
      copy={{ ...C, tokenLabel: C.keyLabel }}
      docsUrl={`${D.repo}${D.incidentLink}`}
      // The URL shape the alerting system composes around its own signed token — the one thing
      // besides the key an operator has to type into the other system.
      example={() => `${window.location.origin}/l/<token>`}
    />
  )
}
