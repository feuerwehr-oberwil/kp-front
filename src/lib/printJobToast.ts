// Live «An Stationsdrucker» toast lifecycle, shared by the editor (ReportPreflight) and the
// capture poster (CaptureApp): a sticky toast that follows the queued job through the relay —
// «gesendet» → «wird gedruckt …» → «gedruckt» (or a failure) — so a sleep-deprived operator
// watches it actually happen instead of getting one optimistic toast and then silence.

import { appConfig } from '../config/appConfig'
import { toast, updateToast, dismissToast, type ToastStep } from './ui'
import { cancelPrint, pollJobUntilDone, type PrintTransport } from './printRelay'

const TERMINAL = ['done', 'failed', 'cancelled']

/** The three stages as a chain, so «wird gedruckt» shows WHERE the job is instead of only that
 * something is happening: reached stages keep their tick, the running one gets the printer with
 * the sheet feeding out, the unreached ones stay as pips. */
function steps(stage: 'queued' | 'printing' | 'done'): ToastStep[] {
  const R = appConfig.copy.printRelay
  const sent: ToastStep = { label: R.stepSent, state: stage === 'queued' ? 'now' : 'done', icon: 'check' }
  const printing: ToastStep =
    stage === 'printing' ? { label: R.stepPrinting, state: 'now', icon: 'printer' }
    : stage === 'done' ? { label: R.stepPrinting, state: 'done', icon: 'check' }
    : { label: R.stepPrinting, state: 'future' }
  const printed: ToastStep = stage === 'done'
    ? { label: R.stepPrinted, state: 'now', icon: 'check' }
    : { label: R.stepPrinted, state: 'future' }
  return [sent, printing, printed]
}

export function trackPrintJob(t: PrintTransport, jobId: string): void {
  const R = appConfig.copy.printRelay
  // Undo cancels iff still queued; once printing the backend says «zu spät». Kept on the
  // toast through queued AND printing so the button is always honest about the outcome.
  const undo = {
    label: R.undo,
    onClick: () => {
      void cancelPrint(t, jobId).then((ok) =>
        toast(ok ? R.cancelled : R.undoTooLate, ok ? {} : { icon: 'warn', tone: 'warn' }))
    },
  }
  const id = toast(R.queued, { sticky: true, steps: steps('queued'), action: undo })
  void pollJobUntilDone(t, jobId, (s) => {
    if (s.status === 'printing') updateToast(id, R.printing, { steps: steps('printing'), action: undo })
    else if (s.status === 'done') updateToast(id, R.printed, { steps: steps('done'), duration: 4000 })
    // a failure drops the chain and keeps the sentence: «wo es hängt» is obvious, «Drucker
    // prüfen» is the part the Erfasser has to read, and it does not fit next to three stages
    else if (s.status === 'failed') updateToast(id, R.printFailed, { icon: 'warn', tone: 'warn', duration: 6000 })
    else if (s.status === 'cancelled') dismissToast(id)
  }).then((final) => {
    // Never reached a terminal state within the window (agent offline, printer very slow):
    // stop being sticky and let the last known state fade rather than hang forever.
    if (!final || !TERMINAL.includes(final.status)) {
      const stage = final?.status === 'printing' ? 'printing' : 'queued'
      updateToast(id, stage === 'printing' ? R.printing : R.queued, { steps: steps(stage), duration: 6000 })
    }
  })
}
