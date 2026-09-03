// Statistik-Export: manage the read-only stats token (GET /api/stats/incidents). External
// analytics (e.g. a yearly-statistics dashboard) authenticate with this token; rotation
// cuts off every consumer at once. Fail-closed: no token → the export answers 403.
//
// The card itself is the shared secret-token card (admin/ui · useSecret + SecretCard) — the
// same object the Einsatz-Link key and the Erfassungs-Poster secret are. What is particular
// to this one is the example: the curl line an integrator actually has to run.

import { appConfig } from '../config/appConfig'
import { SecretCard, useSecret } from './ui'

export function StatsAdminView() {
  const C = appConfig.copy.admin.statistik
  // Doc addresses live in the copy layer (admin.docs) — one line for a fork to retarget.
  const D = appConfig.copy.admin.docs
  const secret = useSecret('/api/stats/secret', { rotated: C.rotated, disabled: C.disabled, failed: C.failed })
  return (
    <SecretCard
      secret={secret}
      copy={C}
      docsUrl={`${D.repo}${D.statsExport}`}
      example={(token) =>
        `curl -H "X-Stats-Token: ${token}" ${window.location.origin}/api/stats/incidents?year=${new Date().getFullYear()}`}
    />
  )
}
