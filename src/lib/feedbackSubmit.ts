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
//
// This is also the only exit that can carry a PHOTO, and that is a property of the transport
// rather than a policy: a mailto: URL and the clipboard both hold text. The rule the sheet
// keeps is unchanged — the picture is one the operator picked by hand and looked at, next to
// the technical block, before pressing this button. See backend/app/telemetry/photos.py for
// what happens to it on the other side, and why it is capped as hard as it is.

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
  /** Photos the operator attached, already downscaled by lib/imagePrep · prepareFeedbackPhoto.
   *  Anything past PHOTO_LIMIT is dropped here rather than refused by the server. */
  photos?: Blob[]
}

/** How many photos one Rückmeldung may carry. Mirrors backend/app/telemetry/photos.py ·
 *  MAX_PHOTOS: one picture of the screen and one of the thing next to it is the realistic case,
 *  and a third is someone using the wrong tool. */
export const PHOTO_LIMIT = 2

/** Blob → base64, in chunks so a several-hundred-kB photo doesn't blow the argument limit of
 *  String.fromCharCode on the way. No `data:` prefix: the server sniffs the type from the bytes
 *  rather than believing a label the client wrote. */
async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** POST the report. Resolves to an outcome; never rejects — the caller is a UI button. */
export async function submitReport(input: SubmitInput): Promise<SubmitOutcome> {
  try {
    // The key is omitted entirely when nothing is attached, so the ordinary Rückmeldung — which
    // is nearly all of them — puts exactly the same body on the wire as it did before photos
    // existed. A feature nobody used should not show up in everybody's payload.
    const attached = input.photos?.slice(0, PHOTO_LIMIT) ?? []
    const photos = attached.length ? await Promise.all(attached.map(toBase64)) : undefined
    const sent = await apiPost<{ queued: boolean; sent: unknown }>('/api/diag/report', {
      message: input.message,
      build: `v${APP_VERSION}+${GIT_SHA}`,
      locale: input.locale,
      viewport: input.viewport,
      online: input.online,
      troubleKind: input.trouble?.kind,
      troubleAt: input.trouble ? new Date(input.trouble.at).toISOString() : undefined,
      ...(photos ? { photos } : {}),
    })
    return { ok: true, sent: sent.sent }
  } catch (e) {
    // 503 is the deployer having switched outbound off — a configuration, not a fault, and
    // the sheet says something different for it.
    if (e instanceof ApiError && e.status === 503) return { ok: false, reason: 'disabled' }
    return { ok: false, reason: 'failed' }
  }
}
