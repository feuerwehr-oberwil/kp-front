// Live «An Stationsdrucker» toast lifecycle, shared by the editor (ReportPreflight) and the
// capture poster (CaptureApp): a sticky toast that follows the queued job through the relay —
// «in der Warteschlange» → «wird gedruckt …» → «gedruckt» (or a failure) — so a sleep-deprived
// operator watches it actually happen instead of getting one optimistic toast and then silence.
//
// ⚠️ THE TOAST IS NOT THE RECORD. It gives up when the poll does (90 s) and it is gone from the
// screen long before that. Whoever queued the job owns the outstanding state and gets told about
// it through `onSettled` — the editor keeps it on the Rapport head until the relay answers.

import { appConfig } from '../config/appConfig'
import { toast, updateToast, dismissToast, type ToastAction, type ToastStep } from './ui'
import { cancelPrint, pollJobUntilDone, type PrintJobStatus, type PrintTransport } from './printRelay'

const TERMINAL = ['done', 'failed', 'cancelled']

/** The three stages as a chain, so «wird gedruckt» shows WHERE the job is instead of only that
 * something is happening: reached stages keep their tick, the running one gets the printer with
 * the sheet feeding out, the unreached ones stay as pips. */
function steps(stage: 'queued' | 'printing' | 'done'): ToastStep[] {
  const R = appConfig.copy.printRelay
  // ⚠️ The first stage is «In der Warteschlange», not «Gesendet». What the app knows is that the
  // job is in a queue; «gesendet» reads as an accomplishment and was the first half of the story
  // that ended in an offer to close an Einsatz whose rapport had never been printed.
  const sent: ToastStep = { label: R.stepQueued, state: stage === 'queued' ? 'now' : 'done', icon: 'check' }
  const printing: ToastStep =
    stage === 'printing' ? { label: R.stepPrinting, state: 'now', icon: 'printer' }
    : stage === 'done' ? { label: R.stepPrinting, state: 'done', icon: 'check' }
    : { label: R.stepPrinting, state: 'future' }
  const printed: ToastStep = stage === 'done'
    ? { label: R.stepPrinted, state: 'now', icon: 'check' }
    : { label: R.stepPrinted, state: 'future' }
  return [sent, printing, printed]
}

/**
 * Follow a queued print job to its end on one sticky toast.
 *
 * `done` is what to offer once the paper is actually out — the editor passes «Einsatz
 * abschliessen» there (the Rapport is printed, only the bookkeeping is left). Omitted by the
 * capture poster, which prints the same sheet but has no business closing an Einsatz.
 *
 * `opts.onSettled` fires once, with the status that ended the job, for the caller that recorded
 * it as outstanding. It does NOT fire when the poll times out: an unresolved job is still
 * outstanding, and pretending otherwise is exactly the lie this whole path exists to stop.
 */
export function trackPrintJob(t: PrintTransport, jobId: string, done?: ToastAction, opts?: {
  /** the relay was already reporting itself offline when the job went in — say so on the toast,
   *  because «in der Warteschlange» with no reason reads as a slow printer, not a dead one */
  relayOffline?: boolean
  onSettled?: (status: PrintJobStatus) => void
}): void {
  const R = appConfig.copy.printRelay
  let settled = false
  const settle = (status: PrintJobStatus) => {
    if (settled) return
    settled = true
    opts?.onSettled?.(status)
  }
  // Undo cancels iff still queued; once printing the backend says «zu spät». Kept on the
  // toast through queued AND printing so the button is always honest about the outcome.
  const undo = {
    label: R.undo,
    onClick: () => {
      void cancelPrint(t, jobId).then((res) => {
        if (res === 'cancelled') { settle('cancelled'); toast(R.cancelled); return }
        // «zu spät» is a statement about the JOB, so it is only made when the relay answered.
        // A network failure says nothing about the job — say that instead.
        if (res === 'unreachable') { toast(R.jobUnreachable, { icon: 'warn', tone: 'warn' }); return }
        toast(res === 'gone' ? R.jobGone : R.undoTooLate, { icon: 'warn', tone: 'warn' })
      })
    },
  }
  // The tone rides the EDGE, not the fill (`toneStyle: 'edge'`, see 08-toasts.css): a job sitting
  // in a queue is not a finished print — but it is not an alarm either, and this pill stays up for
  // as long as the print takes. A full red pill for a minute and a half said «etwas ist kaputt»
  // about a printer that was merely busy, and the green that followed said it just as loudly.
  // The colour is still the first thing read; it is now the only thing that changes.
  const queuedText = opts?.relayOffline ? `${R.queued} – ${R.offline}` : R.queued
  const id = toast(queuedText, { sticky: true, tone: 'warn', toneStyle: 'edge', steps: steps('queued'), action: undo })
  void pollJobUntilDone(t, jobId, (s) => {
    if (s.status === 'printing') updateToast(id, R.printing, { tone: 'warn', toneStyle: 'edge', steps: steps('printing'), action: undo })
    // …and the offer rides the last step, so «gedruckt» stands a little longer than it used to:
    // 4 s is enough to read a word, not to notice a button and decide to press it.
    else if (s.status === 'done') { settle('done'); updateToast(id, R.printed, { tone: 'success', toneStyle: 'edge', steps: steps('done'), duration: done ? 8000 : 4000, action: done ?? null }) }
    // a failure drops the chain and keeps the sentence: «wo es hängt» is obvious, «Drucker
    // prüfen» is the part the Erfasser has to read, and it does not fit next to three stages
    else if (s.status === 'failed') { settle('failed'); updateToast(id, R.printFailed, { icon: 'warn', tone: 'warn', toneStyle: 'edge', duration: 6000 }) }
    else if (s.status === 'cancelled') { settle('cancelled'); dismissToast(id) }
  }).then((final) => {
    // Never reached a terminal state within the window (agent offline, printer very slow):
    // stop being sticky and let the last known state fade rather than hang forever. The job
    // stays OUTSTANDING — no `settle` here — so whoever recorded it keeps showing it.
    if (!final || !TERMINAL.includes(final.status)) {
      const stage = final?.status === 'printing' ? 'printing' : 'queued'
      updateToast(id, stage === 'printing' ? R.printing : queuedText, { tone: 'warn', toneStyle: 'edge', steps: steps(stage), duration: 6000 })
    }
  })
}
