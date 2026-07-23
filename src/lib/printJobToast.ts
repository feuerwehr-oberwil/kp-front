// Live «An Stationsdrucker» toast lifecycle, shared by the editor (ReportPreflight) and the
// capture poster (CaptureApp): a sticky toast that follows the queued job through the relay —
// «gesendet» → «wird gedruckt …» → «gedruckt» (or a failure) — so a sleep-deprived operator
// watches it actually happen instead of getting one optimistic toast and then silence.

import { appConfig } from '../config/appConfig'
import { toast, updateToast, dismissToast } from './ui'
import { cancelPrint, pollJobUntilDone, type PrintTransport } from './printRelay'

const TERMINAL = ['done', 'failed', 'cancelled']

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
  const id = toast(R.queued, { sticky: true, icon: 'check', action: undo })
  void pollJobUntilDone(t, jobId, (s) => {
    if (s.status === 'printing') updateToast(id, R.printing, { icon: 'print', action: undo })
    else if (s.status === 'done') updateToast(id, R.printed, { icon: 'check', duration: 4000 })
    else if (s.status === 'failed') updateToast(id, R.printFailed, { icon: 'warn', tone: 'warn', duration: 6000 })
    else if (s.status === 'cancelled') dismissToast(id)
  }).then((final) => {
    // Never reached a terminal state within the window (agent offline, printer very slow):
    // stop being sticky and let the last known state fade rather than hang forever.
    if (!final || !TERMINAL.includes(final.status)) {
      updateToast(id, final?.status === 'printing' ? R.printing : R.queued, { icon: 'check', duration: 6000 })
    }
  })
}
