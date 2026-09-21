import { useEffect, useState } from 'react'
import { loadTileManifest, ptToMm, sourcePages, tileSource } from '../lib/planTiles'

/**
 * How wide the sheet behind `url` is ON PAPER, in mm — known only for a sheet that has a tile
 * pyramid (the manifest states the page sizes), and null otherwise. Deliberately so: the paper
 * width exists to raise the zoom ceiling (lib/planTiles · paperMaxScale), and only tiles can
 * deliver anything at that depth; a pdf.js sheet zoomed there would just be a bigger blur.
 */
export function usePlanPaperMm(url: string | null): number | null {
  const [answer, setAnswer] = useState<{ url: string; mm: number } | null>(null)
  useEffect(() => {
    const source = url ? tileSource(url) : null
    if (!url || !source) return
    let cancelled = false
    loadTileManifest(source).then((m) => {
      if (cancelled || !m) return
      const pages = sourcePages(m, source)
      if (pages.length) setAnswer({ url, mm: ptToMm(Math.max(...pages.map((p) => p.widthPt))) })
    }, () => {})
    return () => { cancelled = true }
  }, [url])
  return answer && answer.url === url ? answer.mm : null
}
