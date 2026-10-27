/**
 * The plain PDF reader's way to jump (components/PdfScroller, 27.10.2026, sweep #15): an
 * Evakuationsplan is five storeys in one PDF, and at 3am «scroll until 2. OG comes by» is not a
 * way to find one. The strip over the pages lists the document's own bookmarks when it has them
 * (pdf.js `getOutline`, top level only – the storey list, not every room under it), otherwise
 * its page numbers. Pure apart from the pdf.js calls it is handed, so it tests without pdf.js.
 */

/** One stop on the strip: a 0-based page index and, from the outline, its title. */
export type PdfJump = { page: number; title?: string }

/** The slice of pdf.js' document proxy this needs – structural, so a test hands a stub. */
export interface OutlineSource {
  numPages: number
  getOutline(): Promise<readonly { title: string; dest: string | readonly unknown[] | null }[] | null>
  getDestination(id: string): Promise<readonly unknown[] | null>
  getPageIndex(ref: never): Promise<number>
}

/** Where an outline item points, as a 0-based page index, or null when it points nowhere this
 *  reader can go (an external link, a broken or unknown destination). A destination's first
 *  element is the page – a `{num, gen}` reference, or a bare index in some writers' output. */
async function pageOf(pdf: OutlineSource, dest: string | readonly unknown[] | null): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
    const target = explicit?.[0]
    if (target == null) return null
    const index = typeof target === 'number' ? target : await pdf.getPageIndex(target as never)
    return Number.isInteger(index) && index >= 0 && index < pdf.numPages ? index : null
  } catch {
    return null
  }
}

/**
 * The strip's stops: the outline's top-level entries that resolve to a page (in the document's
 * order), else one stop per page. Empty for a one-page document without bookmarks – there is
 * nowhere to jump. A broken outline never costs the reader its strip: it falls back to pages.
 */
export async function pdfJumps(pdf: OutlineSource): Promise<PdfJump[]> {
  const outline = await pdf.getOutline().catch(() => null)
  if (outline?.length) {
    const resolved = await Promise.all(outline.map(async (o) => ({ title: o.title.trim(), page: await pageOf(pdf, o.dest) })))
    const jumps = resolved.filter((j): j is PdfJump & { title: string; page: number } => j.page != null && j.title !== '')
    if (jumps.length) return jumps
  }
  return pdf.numPages > 1 ? Array.from({ length: pdf.numPages }, (_, page) => ({ page })) : []
}

/** Which stop the reader is at: the last one whose page starts at or before `page`; -1 while
 *  the reader is still above the first bookmark (a cover page the outline skips). */
export function activeJump(jumps: readonly PdfJump[], page: number): number {
  let at = -1
  jumps.forEach((j, i) => { if (j.page <= page) at = i })
  return at
}
