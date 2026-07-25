// Direct submission of a Rückmeldung — the second way out of the sheet, next to Kopieren
// and E-Mail.
//
// Why this exists at all, given lib/feedbackReport's rule that nothing is sent
// automatically: it still isn't. The operator reads the report and presses a button, and
// that press IS the consent — the same consent an `mailto:` gives, minus the mail client
// that half the tablets in a Magazin don't have configured. The rule the app keeps is
// "nothing leaves without a human deciding", not "nothing ever leaves".
//
// Two things make that defensible rather than a loophole:
//   1. It goes to the station's OWN backend first (/api/diag/report). What that server does
//      with it is the deployer's call, configured by the deployer — see backend/app/telemetry.
//   2. The server answers with the payload it actually queued, and the sheet shows it. A
//      preview the sender writes is marketing; a preview the receiver echoes back is a check.
//
// Failure is never fatal here: any error falls the sheet back to Kopieren/E-Mail, which need
// no server at all.

import { apiPost, ApiError } from './api'
import { APP_VERSION, GIT_SHA } from './buildInfo'
import type { TroubleEvent } from './trouble'

export type SubmitOutcome =
  | { ok: true; sent: unknown }
  /** the deployer disabled outbound telemetry — offer mailto:, don't call it an error */
  | { ok: false; reason: 'disabled' }
  /** offline, server down, not logged in, anything else — same fallback, different wording */
  | { ok: false; reason: 'failed' }

export interface SubmitInput {
  message: string
  locale: string
  viewport: string
  online: boolean
  trouble?: TroubleEvent
}

/** POST the report. Resolves to an outcome; never rejects — the caller is a UI button. */
export async function submitReport(input: SubmitInput): Promise<SubmitOutcome> {
  try {
    const sent = await apiPost<{ queued: boolean; sent: unknown }>('/api/diag/report', {
      message: input.message,
      build: `v${APP_VERSION}+${GIT_SHA}`,
      locale: input.locale,
      viewport: input.viewport,
      online: input.online,
      troubleKind: input.trouble?.kind,
      troubleAt: input.trouble ? new Date(input.trouble.at).toISOString() : undefined,
    })
    return { ok: true, sent: sent.sent }
  } catch (e) {
    // 503 is the deployer having switched outbound off — a configuration, not a fault, and
    // the sheet says something different for it.
    if (e instanceof ApiError && e.status === 503) return { ok: false, reason: 'disabled' }
    return { ok: false, reason: 'failed' }
  }
}
