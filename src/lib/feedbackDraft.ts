// The half-written Rückmeldung, kept across an accidental dismiss.
//
// Two behaviours that are right on their own and awful together: the sheet closes on Esc and
// on a backdrop tap (Base UI's Dialog gives us both, see lib/overlays/Sheet), and closing
// deliberately starts the 14-day cooldown, because being asked twice about the same crash is
// the nag lib/trouble exists to prevent. Combined, one stray tap on a tablet loses two typed
// sentences AND guarantees we never ask again.
//
// So the text outlives the sheet. It is cleared only once it has actually gone somewhere —
// sent, mailed, or copied — never when the sheet merely closes. The cooldown keeps its own
// rule: closing still counts as asked, it just no longer costs the operator their words.
//
// localStorage rather than IndexedDB, the same "tiny flags" carve-out lib/trouble takes: a few
// hundred bytes of throwaway text written on every keystroke, with no reason to outlive a
// cleared browser profile.

const KEY = 'kp-front-feedback-draft'

/** The server's cap on `message` (backend/app/api/diag.py · ProblemReport).
 *
 *  Mirrored here so the textarea can stop at it: past the cap the POST 422s, and a 422 comes
 *  back through submitReport as the generic failure, which the sheet renders as «vermutlich
 *  offline» — a wrong diagnosis handed to the single most engaged reporter we will ever get,
 *  the one who wrote four thousand characters. */
export const MAX_MESSAGE = 4000

export function readDraft(): string {
  try {
    return localStorage.getItem(KEY)?.slice(0, MAX_MESSAGE) ?? ''
  } catch {
    return '' // unreadable storage (private mode) → start empty, never throw
  }
}

/** Persist what has been typed so far. Empty text removes the row rather than storing "". */
export function writeDraft(text: string): void {
  try {
    if (text) localStorage.setItem(KEY, text.slice(0, MAX_MESSAGE))
    else localStorage.removeItem(KEY)
  } catch { /* quota or private mode — a lost draft must never break the sheet */ }
}

/** The text has left the device (sent / mailed / copied). Only then does it stop being a draft. */
export function clearDraft(): void {
  try { localStorage.removeItem(KEY) } catch { /* best-effort */ }
}
