/**
 * «Öffnen in …» – hand a plan PDF to the device (components/PdfScroller, 27.10.2026, sweep #15):
 * on an iPad or iPhone the system share sheet with the file, whose rows open it in another app
 * (Files, a PDF reader, Mail, AirDrop) – and where there is no share sheet for files (a desktop
 * browser) a plain download.
 * The plan always opens IN the app first; this is the way out of it, never the way in.
 *
 * The bytes are the ones the reader already holds (lib/pdfBytes keeps them for the session), so
 * the share sheet opens without a second download, and ⚠️ quickly: iOS only lets `share()` run
 * inside the tap's transient activation, which an uncached network fetch could outlast.
 */
import { loadPdfBytes } from './pdfBytes'
import { downloadBlob } from './download'

/** A file name a share sheet or a Downloads folder accepts: no path or reserved characters,
 *  one `.pdf` at the end, «Plan.pdf» when nothing usable is left. */
export function pdfFileName(name: string | undefined): string {
  const base = (name ?? '').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  return `${base || 'Plan'}.pdf`
}

/** What happened, for the caller's (and the test's) sake: shared, cancelled in the sheet, or
 *  saved as a download. */
export type PdfShareResult = 'shared' | 'cancelled' | 'downloaded'

/**
 * Share the PDF at `url` as a file, else download it. A cancelled share sheet is the person's
 * answer and ends it; any other refusal (no permission, the activation ran out) still gets the
 * file to them as a download.
 */
export async function sharePdf(url: string, name: string | undefined, nav: Navigator = navigator): Promise<PdfShareResult> {
  const fileName = pdfFileName(name)
  const bytes = await loadPdfBytes(url)
  const file = new File([bytes], fileName, { type: 'application/pdf' })
  if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: fileName.replace(/\.pdf$/, '') })
      return 'shared'
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return 'cancelled'
    }
  }
  downloadBlob(file, fileName)
  return 'downloaded'
}
