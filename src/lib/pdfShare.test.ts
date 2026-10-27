import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./pdfBytes', () => ({ loadPdfBytes: vi.fn(async () => new Uint8Array([37, 80, 68, 70])) }))
vi.mock('./download', () => ({ downloadBlob: vi.fn() }))
import { downloadBlob } from './download'
import { pdfFileName, sharePdf } from './pdfShare'

const nav = (over: Partial<Navigator>) => over as Navigator

afterEach(() => vi.clearAllMocks())

describe('sharePdf · «Öffnen in …»', () => {
  it('hands the file to the share sheet where the device can share files', async () => {
    const share = vi.fn(async () => {})
    expect(await sharePdf('/api/reference/p?v=2', 'Evakuationsplan', nav({ share, canShare: () => true }))).toBe('shared')
    const file = (share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0]
    expect(file.name).toBe('Evakuationsplan.pdf')
    expect(file.type).toBe('application/pdf')
    expect(downloadBlob).not.toHaveBeenCalled()
  })

  it('downloads where files cannot be shared', async () => {
    expect(await sharePdf('/x.pdf', 'Plan', nav({ share: vi.fn(), canShare: () => false }))).toBe('downloaded')
    expect(await sharePdf('/x.pdf', 'Plan', nav({}))).toBe('downloaded')
    expect(downloadBlob).toHaveBeenCalledTimes(2)
  })

  it('a cancelled sheet ends it; any other refusal still downloads', async () => {
    const abort = Object.assign(new Error('x'), { name: 'AbortError' })
    expect(await sharePdf('/x.pdf', 'P', nav({ share: vi.fn(async () => { throw abort }), canShare: () => true }))).toBe('cancelled')
    expect(downloadBlob).not.toHaveBeenCalled()
    const denied = Object.assign(new Error('x'), { name: 'NotAllowedError' })
    expect(await sharePdf('/x.pdf', 'P', nav({ share: vi.fn(async () => { throw denied }), canShare: () => true }))).toBe('downloaded')
  })

  it('names the file safely', () => {
    expect(pdfFileName('Schloss / Musterdorf: EG.pdf')).toBe('Schloss Musterdorf EG.pdf')
    expect(pdfFileName(undefined)).toBe('Plan.pdf')
    expect(pdfFileName('  ')).toBe('Plan.pdf')
  })
})
