// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { appConfig } from '../config/appConfig'

// the bake is the renderer's one load: the first one fails, «Erneut laden» runs the second
const raster = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../lib/pdfRaster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/pdfRaster')>()),
  cachedBake: () => undefined,
  evictPlan: () => {},
  bake: () => ++raster.calls === 1
    ? Promise.reject(new Error('offline'))
    : Promise.resolve({ bitmap: { width: 10, height: 20 }, aspect: 2, side: 10, pages: [{ page: 0, widthPt: 595, heightPt: 842 }, { page: 1, widthPt: 595, heightPt: 842 }] }),
}))
vi.mock('../lib/pdfDiagnosis', () => ({ diagnosePdfFailure: () => new Promise(() => {}) }))

import { PdfViewport } from './PdfViewport'

describe('PdfViewport · onPages', () => {
  // Sol review round 2, S3: the page geometry used to be asked for once per URL, so a sheet whose
  // first load failed got its drawing back with «Erneut laden», but not its storey drawings
  it('tells the pages of the load that SUCCEEDED – a retry after a failure too', async () => {
    const onPages = vi.fn()
    render(<PdfViewport url="/plans/modul6.pdf" fitW={100} fitH={200} scale={1} pos={{ x: 0, y: 0 }} vw={100} vh={200} onAspect={() => {}} onPages={onPages} />)
    const retry = await screen.findByRole('button', { name: appConfig.copy.pdf.retry })
    expect(onPages).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(retry) })
    expect(onPages).toHaveBeenCalledWith([{ page: 0, widthPt: 595, heightPt: 842 }, { page: 1, widthPt: 595, heightPt: 842 }])
  })
})
