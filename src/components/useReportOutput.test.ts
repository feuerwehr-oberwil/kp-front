// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { appConfig } from '../config/appConfig'
import { confirmDialog, toast } from '../lib/ui'
import { enqueuePrint, fetchJobStatus } from '../lib/printRelay'
import { trackPrintJob } from '../lib/printJobToast'
import { downloadDirectReportPdf, type DirectReportArgs } from '../lib/reportPdfDirect'
import type { ReportMeta } from '../lib/workspace'
import { useReportOutput } from './useReportOutput'

vi.mock('../lib/ui', async (orig) => ({
  ...(await orig<typeof import('../lib/ui')>()),
  confirmDialog: vi.fn(async () => true),
  toast: vi.fn(),
}))
vi.mock('../lib/printRelay', async (orig) => ({
  ...(await orig<typeof import('../lib/printRelay')>()),
  fetchPrintStatus: vi.fn(async () => ({ available: true, online: true })),
  fetchJobStatus: vi.fn(async () => ({ status: 'queued' })),
  enqueuePrint: vi.fn(async () => 'j1'),
}))
vi.mock('../lib/printJobToast', () => ({ trackPrintJob: vi.fn() }))
vi.mock('../lib/reportPdfDirect', async (orig) => ({
  ...(await orig<typeof import('../lib/reportPdfDirect')>()),
  readyDirectReportPayload: vi.fn(async () => ({})),
  downloadDirectReportPdf: vi.fn(async () => {}),
}))

const R = appConfig.copy.printRelay
// what the paper carries is the form's business: the output only hands it on
const PAPER = {} as DirectReportArgs

/** The hook as ReportPreflight drives it: `rerender({ meta })` is the form's next render, with
 *  its `metaRef` caught up – a write lands on the blob only then, as in the app. */
function setup(meta: ReportMeta = {}, paper: () => Promise<DirectReportArgs> = async () => PAPER) {
  const metaRef = { current: meta }
  const onSaveMeta = vi.fn<(next: ReportMeta) => void>()
  const view = renderHook(({ meta }: { meta: ReportMeta }) => useReportOutput({
    incidentId: 'inc', meta, metaRef, canRecord: true, onSaveMeta,
    paper, completeOffer: () => undefined,
  }), { initialProps: { meta } })
  const next = (m: ReportMeta) => { metaRef.current = m; view.rerender({ meta: m }) }
  return { ...view, onSaveMeta, next }
}
// let the mocked relay answer (its promises resolve on microtasks)
const flush = () => act(async () => {})

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.useRealTimers())

describe('useReportOutput · the PDF', () => {
  it('says a draft that cannot be built and frees «PDF» for the next press', async () => {
    // ReportPreflight · paperOf builds the draft at the press, so its throw is synchronous
    const paper = vi.fn<() => Promise<DirectReportArgs>>()
      .mockImplementationOnce(() => { throw new Error('buildDraft') })
      .mockResolvedValue(PAPER)
    const { result, onSaveMeta } = setup({}, paper)
    await flush()
    await act(() => result.current.downloadPdf())
    expect(toast).toHaveBeenCalledWith(appConfig.copy.report.pdfFailed, expect.objectContaining({ tone: 'warn' }))
    expect(result.current.pdfBusy).toBe(false)
    expect(onSaveMeta).not.toHaveBeenCalled()
    // the second press makes the PDF and stamps it
    await act(() => result.current.downloadPdf())
    expect(downloadDirectReportPdf).toHaveBeenCalledWith(PAPER)
    expect(onSaveMeta.mock.calls[0][0].reportMadeAt).toBeDefined()
  })
})

describe('useReportOutput · the station printer', () => {
  it('records a queued job as outstanding – never as a rapport made', async () => {
    const { result, onSaveMeta, next } = setup()
    await flush()
    await act(() => result.current.sendToPrinter())
    expect(enqueuePrint).toHaveBeenCalledWith(expect.anything(), 'inc', {})
    const held = onSaveMeta.mock.calls[0][0]
    expect(held.printJob?.id).toBe('j1')
    expect(held.reportMadeAt).toBeUndefined()
    // the relay still says «queued» on the surface's own read: nothing is stamped
    next(held)
    await flush()
    expect(fetchJobStatus).toHaveBeenCalledWith(expect.anything(), 'j1')
    expect(onSaveMeta).toHaveBeenCalledTimes(1)
    expect(result.current.pendingJob?.id).toBe('j1')
  })

  it('settles a job once when the toast and the surface poll both answer «done»', async () => {
    const { result, onSaveMeta, next } = setup()
    await flush()
    await act(() => result.current.sendToPrinter())
    vi.mocked(fetchJobStatus).mockResolvedValueOnce({ status: 'done' })
    next(onSaveMeta.mock.calls[0][0])
    await flush()
    // the surface's own read settled it: the job leaves, the rapport is stamped
    expect(onSaveMeta).toHaveBeenCalledTimes(2)
    const settled = onSaveMeta.mock.calls[1][0]
    expect(settled.printJob).toBeUndefined()
    expect(settled.reportMadeAt).toBeDefined()
    // …and the toast's poll reports the same job before the form has rendered the settle
    const onSettled = vi.mocked(trackPrintJob).mock.calls[0][3]?.onSettled
    expect(onSettled).toBeTypeOf('function')
    act(() => onSettled?.('done'))
    expect(onSaveMeta).toHaveBeenCalledTimes(2)
  })

  it('says a failed job, clears it without a stamp and frees «Prüfen»', async () => {
    const { result, onSaveMeta } = setup({ printJob: { id: 'j1', at: '2026-11-26T08:00:00.000Z' } })
    await flush()
    onSaveMeta.mockClear()
    vi.mocked(fetchJobStatus).mockResolvedValueOnce({ status: 'failed', error: 'paper jam' })
    await act(() => result.current.checkPrintJob())
    expect(toast).toHaveBeenCalledWith(R.printFailed, expect.objectContaining({ tone: 'warn' }))
    expect(onSaveMeta).toHaveBeenCalledTimes(1)
    expect(onSaveMeta.mock.calls[0][0]).toEqual({ printJob: undefined })
    expect(result.current.jobBusy).toBe(false)
  })

  it('frees «Ausdrucken» and says so when the job cannot be queued', async () => {
    vi.mocked(enqueuePrint).mockRejectedValueOnce(new Error('503'))
    const { result, onSaveMeta } = setup()
    await flush()
    await act(() => result.current.sendToPrinter())
    expect(confirmDialog).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith(R.failed, expect.objectContaining({ tone: 'warn' }))
    expect(onSaveMeta).not.toHaveBeenCalled()
    expect(result.current.printBusy).toBe(false)
  })

  it('stops reading the open job once the surface is gone', async () => {
    vi.useFakeTimers()
    const { unmount } = setup({ printJob: { id: 'j1', at: '2026-11-26T08:00:00.000Z' } })
    await flush()
    await act(() => vi.advanceTimersByTimeAsync(15_000))
    expect(fetchJobStatus).toHaveBeenCalledTimes(2)
    unmount()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchJobStatus).toHaveBeenCalledTimes(2)
  })
})
