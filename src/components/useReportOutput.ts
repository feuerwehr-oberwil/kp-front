// The Rapport's output: the PDF download and the station printer, with the print job that has not
// come out yet (docs/rapport.md › «the close in the head»). Used by ReportPreflight, which builds
// the paper and renders the head tiles and the open-job band from what this returns.
//
// ⚠️ EINGEREIHT IST NICHT GEDRUCKT: a PDF in hand stamps `reportMadeAt` at once, a queued job
// only holds `printJob` – the stamp waits for the relay to say `done` (settlePrintJob).

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { confirmDialog, toast, type ToastAction } from '../lib/ui'
import { downloadDirectReportPdf, readyDirectReportPayload, type DirectReportArgs } from '../lib/reportPdfDirect'
import { cancelPrint, editorPrintTransport, enqueuePrint, fetchJobStatus, fetchPrintStatus, type PrintJobStatus, type PrintRelayStatus } from '../lib/printRelay'
import { trackPrintJob } from '../lib/printJobToast'
import type { ReportMeta } from '../lib/workspace'

/** The `kind` (lib/ui · toast) of every answer to the print job's «Prüfen»: a second press replaces the first. */
const PRINT_CHECK = 'print-check'

/**
 * `meta` is the Rapport blob of this render, `metaRef` the freshest one the form has seen
 * (ReportPreflight · metaRef) – every write goes onto that one. `paper(also)` is the paper of one
 * press – the draft with `also` merged in, signatures included – the SAME arguments for the PDF
 * and the printer. `completeOffer` is read when a job is queued: the «Einsatz abschliessen» at the
 * end of the job's toast, or nothing.
 */
export function useReportOutput({ incidentId, meta, metaRef, canRecord, onSaveMeta, paper, completeOffer }: {
  incidentId: string
  meta: ReportMeta
  metaRef: { readonly current: ReportMeta }
  /** this session may write the record (ReportPreflight · canRecord) */
  canRecord: boolean
  onSaveMeta: (next: ReportMeta) => void
  paper: (also: Partial<ReportMeta>) => Promise<DirectReportArgs>
  completeOffer: () => ToastAction | undefined
}) {
  const R = appConfig.copy.printRelay
  const [pdfBusy, setPdfBusy] = useState(false)
  /** A rapport has just been produced (PDF in hand, or a print job on its way to the station
   *  printer). The blob remembers WHEN, so the Rapport can tell whoever opens it next that the
   *  paper already exists — on this device or on any other.
   *  ⚠️ NOT through `persist`: this write lands SECONDS after the press that started it (a
   *  server-rendered PDF takes a moment), and `persist` merges the form state of the render it
   *  was created in — a Kurzbericht typed while the PDF was rendering would be overwritten with
   *  the text it had when the button was hit. `metaRef` is the freshest blob instead, and every
   *  field on this surface already persists itself on change, so there is nothing else to carry
   *  — except `also`, the framing written by the same click (ReportPreflight · startOutput). */
  const stampReportMade = (also: Partial<ReportMeta>) =>
    canRecord && onSaveMeta({ ...metaRef.current, ...also, reportMadeAt: new Date().toISOString() })
  /** A job has been handed to the station relay and is not printed yet. Recorded on the blob,
   *  not just in the toast: «in der Warteschlange» is a STATE and a toast is an event, and the
   *  poll behind the toast gives up after 90 s. Whoever opens the Rapport next — after a reload,
   *  on another device — has to see that a print is still outstanding. */
  const holdPrintJob = (id: string, also: Partial<ReportMeta>) =>
    canRecord && onSaveMeta({ ...metaRef.current, ...also, printJob: { id, at: new Date().toISOString() } })
  /** Jobs already settled on THIS surface — the double-settle guard. The toast's `onSettled`
   *  and this surface's own 15 s poll can both answer for the same job within one render, and
   *  `metaRef` only catches up on the NEXT render — so without this, the second settler saw the
   *  job still on the blob and wrote again, re-stamping `reportMadeAt` seconds later. A plain
   *  synchronous Set: the first settle claims the id before any side effect, the second no-ops. */
  const settledJobsRef = useRef(new Set<string>())
  /** The job left the queue. `done` is the ONLY status that earns the «Rapport erstellt» stamp —
   *  a failed or a cancelled job simply stops being outstanding, and `gone` (the relay no longer
   *  knows the job — swept after 7 days) clears WITHOUT stamping: the outcome is unknown, and a
   *  stamp would claim paper that may never have existed.
   *  ⚠️ ONE write for both halves: `metaRef` only catches up on the next render, so stamping and
   *  then clearing would merge the clear onto the blob as it was BEFORE the stamp.
   *  ⚠️ Settles the NAMED job only: a settle that arrives late (the toast poll of a previous
   *  job) must not clear a newer job that has since been queued. */
  const settlePrintJob = (jobId: string, status: PrintJobStatus | 'gone') => {
    if (!canRecord || metaRef.current.printJob?.id !== jobId || settledJobsRef.current.has(jobId)) return
    settledJobsRef.current.add(jobId)
    onSaveMeta({
      ...metaRef.current,
      ...(status === 'done' ? { reportMadeAt: new Date().toISOString() } : {}),
      printJob: undefined,
    })
  }
  // ONE button (decided 2026-07-18): the server composes the complete rapport — map
  // render included (app/kroki.py) — from pure data. No Druckansicht detour anymore.
  // `also`: the Kroki framing and the sheet's answers of the same click (startOutput) – on the
  // paper, and on the stamp that follows it
  const downloadPdf = async (also: Partial<ReportMeta> = {}) => {
    const args = paper(also)
    setPdfBusy(true)
    try {
      await downloadDirectReportPdf(await args)
      // The PDF is the proof; the next step («Einsatz abschliessen») is the green head tile, which
      // `reportMadeAt` turns on once nothing is open. No toast beside it (owner #31, 30.10.2026).
      stampReportMade(also)
    } catch {
      toast(appConfig.copy.report.pdfFailed, { icon: 'warn', tone: 'warn' })
    } finally {
      setPdfBusy(false)
    }
  }
  // Station print relay: hidden unless the deployment runs one (fail-closed backend);
  // the dot mirrors the agent heartbeat, undo cancels while the job is still queued.
  const [printStatus, setPrintStatus] = useState<PrintRelayStatus | null>(null)
  const [printBusy, setPrintBusy] = useState(false)
  useEffect(() => {
    let alive = true
    void fetchPrintStatus(editorPrintTransport()).then((s) => { if (alive) setPrintStatus(s) })
    return () => { alive = false }
  }, [])
  const sendToPrinter = async (also: Partial<ReportMeta> = {}) => {
    // ALWAYS confirm — «Ausdrucken» must never produce accidental paper; when the relay is
    // offline the modal doubles as the store-and-forward warning. That one is now the TITLE and
    // nothing else: «Stationsdrucker offline» is the whole statement, and the paragraph under it
    // explaining that the job would be printed later was the sentence that made queuing sound
    // like printing.
    const ok = printStatus?.online
      ? await confirmDialog({ title: R.confirmTitle, message: R.confirmMsg, confirmLabel: R.confirmBtn })
      : await confirmDialog({ title: R.offlineConfirmTitle, message: '', confirmLabel: R.offlineConfirmBtn })
    if (!ok) return
    setPrintBusy(true)
    try {
      const t = editorPrintTransport()
      // the SAME arguments the PDF download sends, signatures included — paper and PDF are one document
      const payload = await readyDirectReportPayload(await paper(also))
      const jobId = await enqueuePrint(t, incidentId, payload)
      // ⚠️ NOT `stampReportMade`. EINGEREIHT IST NICHT GEDRUCKT: the stamp is the sole condition
      // for the head's green «Einsatz abschliessen» (`closeReady`), and until
      // 22.08. it was set the instant the job left this device — including straight after the
      // dialog that had just said the printer was offline. So the app offered to close an Einsatz
      // whose rapport existed on no sheet of paper anywhere. What is recorded here is the OPEN
      // JOB; the stamp waits for the relay to say `done` (settlePrintJob).
      holdPrintJob(jobId, also)
      // …and the Abschluss offer rides the END of the job's own status chain, not a second toast
      // beside it: the Einsatz is worth closing once the paper is out of the printer.
      trackPrintJob(t, jobId, completeOffer(), {
        relayOffline: !printStatus?.online,
        onSettled: (status) => settlePrintJob(jobId, status),
      })
    } catch {
      toast(R.failed, { icon: 'warn', tone: 'warn' })
    } finally {
      setPrintBusy(false)
    }
  }

  // --- The print job that has NOT come out yet ------------------------------------------------
  //
  // `pollJobUntilDone` gives up after 90 s and its toast is gone from the screen long before
  // that, and nothing ever read the job again — so a Rapport could sit for an hour claiming to
  // have been printed while the relay had never come back. An unresolved job is a STATE: it
  // lives on the blob, it shows under the head, and it is re-read for as long as this surface is
  // open, across a reload and a change of device.
  const pendingJob = meta.printJob
  const [jobBusy, setJobBusy] = useState(false)
  // «Seit X min» must move. Computed from a bare Date.now() at render it froze at whatever
  // minute the band appeared in (and read the clock during render, which the purity lint
  // rightly flags) — a minute tick while a job is outstanding keeps the line honest. The
  // interval only exists while the band does; an Einsatz without an open job pays nothing.
  // No synchronous re-read when a job appears (the lint objects to setState in an effect
  // body, and it is not needed): a just-queued job's negative span is clamped to «Seit 0 min»
  // where the band renders it, which is the right sentence until the first tick.
  const [jobNowMs, setJobNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!pendingJob) return
    const iv = setInterval(() => setJobNowMs(Date.now()), 60_000)
    return () => clearInterval(iv)
  }, [pendingJob])
  // keyed on the JOB, not on the writer: `settlePrintJob` is re-created every render, so the
  // answer is handled in an effect event that always sees the current one
  const onJobRead = useEffectEvent((jobId: string, s: Awaited<ReturnType<typeof fetchJobStatus>>) => {
    // 'gone' = the relay no longer knows the job (swept after 7 days — the relay-was-down-a-
    // week case). Waiting longer can never resolve it, so stop showing it as open and say so
    // honestly: the outcome is unknown, no «Rapport erstellt» stamp.
    if (s === 'gone') { settlePrintJob(jobId, 'gone'); toast(R.jobGone, { icon: 'warn', tone: 'warn' }); return }
    // null = the relay is unreachable right now, which says nothing about the job — keep it.
    if (!s || s.status === 'queued' || s.status === 'printing') return
    settlePrintJob(jobId, s.status)
  })
  const pendingJobId = pendingJob?.id
  useEffect(() => {
    if (!pendingJobId || !canRecord) return
    let alive = true
    const t = editorPrintTransport()
    const read = async () => {
      const s = await fetchJobStatus(t, pendingJobId)
      if (alive) onJobRead(pendingJobId, s)
    }
    void read()
    const iv = setInterval(() => void read(), 15_000)
    return () => { alive = false; clearInterval(iv) }
  }, [pendingJobId, canRecord])
  /** «Prüfen»: ask the relay once, now, and say what came back — including «nothing», which is
   *  its own answer and used to be indistinguishable from «still queued». */
  const checkPrintJob = async () => {
    const job = metaRef.current.printJob
    if (!job) return
    setJobBusy(true)
    const s = await fetchJobStatus(editorPrintTransport(), job.id)
    setJobBusy(false)
    // «nicht mehr auffindbar» and «nicht erreichbar» are different answers: the first is about
    // the JOB (it stopped existing — clear it, outcome unknown), the second about the network.
    // every answer to «Prüfen» is ONE pill: pressing it again replaces the last answer
    if (s === 'gone') { settlePrintJob(job.id, 'gone'); toast(R.jobGone, { icon: 'warn', tone: 'warn', kind: PRINT_CHECK }); return }
    if (!s) { toast(R.jobUnreachable, { icon: 'warn', tone: 'warn', kind: PRINT_CHECK }); return }
    if (s.status === 'done') { settlePrintJob(job.id, 'done'); toast(R.printed, { icon: 'check', tone: 'success', kind: PRINT_CHECK }); return }
    if (s.status === 'failed') { settlePrintJob(job.id, 'failed'); toast(R.printFailed, { icon: 'warn', tone: 'warn', kind: PRINT_CHECK }); return }
    if (s.status === 'cancelled') { settlePrintJob(job.id, 'cancelled'); toast(R.cancelled, { kind: PRINT_CHECK }); return }
    // still under way: the neutral printer glyph, red is a failure's (FEEDBACK.11)
    toast(s.status === 'printing' ? R.printing : R.queued, { icon: 'printer', kind: PRINT_CHECK })
  }
  /** Give up on a job that is still in the queue. Refused once the agent has claimed it — the
   *  paper may already be moving, and the button says so rather than pretending. */
  const dropPrintJob = async () => {
    const job = metaRef.current.printJob
    if (!job) return
    setJobBusy(true)
    const res = await cancelPrint(editorPrintTransport(), job.id)
    setJobBusy(false)
    // cancelled: the job row leaves – only a refusal is said
    if (res === 'cancelled') { settlePrintJob(job.id, 'cancelled'); return }
    // The three refusals mean three different things (see printRelay · CancelOutcome):
    // «zu spät» only when the relay actually SAID the job is past cancelling — a network
    // failure used to wear the same words, claiming knowledge nobody had.
    if (res === 'gone') { settlePrintJob(job.id, 'gone'); toast(R.jobGone, { icon: 'warn', tone: 'warn' }); return }
    if (res === 'unreachable') { toast(R.jobUnreachable, { icon: 'warn', tone: 'warn' }); return }
    toast(R.undoTooLate, { icon: 'warn', tone: 'warn' })
  }

  return { printStatus, pdfBusy, printBusy, pendingJob, jobNowMs, jobBusy, downloadPdf, sendToPrinter, checkPrintJob, dropPrintJob }
}
