// The workspace's speculative warm-ups (split out of IncidentWorkspace, perf sweep 26.11.2026):
// work no surface on screen needs yet, done ahead so the first switch to it is instant.

import { useEffect } from 'react'
import { whenIdle } from '../lib/idle'
import { prewarmPlans } from '../lib/pdfRaster'
import { loadReportPreflight, loadWhiteboard } from './lazySurfaces'

/**
 * Called once by IncidentWorkspace. Warms, on idle:
 * - the CODE of the two lazy surfaces (Plan, Rapport — lazySurfaces), so a mode switch finds its
 *   chunk already parsed;
 * - the plan bitmaps, so the first open of the Plan tab appears instantly — the exact-fit bake
 *   reuses these unless the stage is larger. ⚠️ Only the active plan and its two rail neighbours
 *   are baked at window size; the rest get a small preview (~5 MB instead of up to ~83 MB each on
 *   an iPad — every plan at full size was enough to have the tab reclaimed before the Plan tab
 *   was ever opened). Re-runs on a plan switch, so the new neighbours are warmed as the operator
 *   moves along the rail (PdfViewport · prewarmPlans).
 *
 * ⚠️ Only once the opening cover is off (`coverOff`, lib/bootCover): WebKit has no idle callback,
 * so «idle» there is a fixed 600 ms — under the cover, competing with the Karte's first frame. A
 * surface the Einsatz OPENS on loads its own chunk (lazy) and is not waited for here. Neither for
 * an Atemschutz-Link phone (`asLink`): it is shown the Tafel and nothing else.
 */
export function useWarmUps({ coverOff, asLink, resolvedPlanDocs, activePlanId }: {
  coverOff: boolean
  asLink: boolean
  resolvedPlanDocs: readonly { id: string; imageUrl: string }[]
  activePlanId: string
}): void {
  const warm = coverOff && !asLink
  useEffect(() => {
    if (!warm) return
    return whenIdle(() => { void loadWhiteboard(); void loadReportPreflight() })
  }, [warm])

  useEffect(() => {
    if (!warm) return
    const docs = resolvedPlanDocs.filter((p) => p.imageUrl)
    const urls = docs.map((p) => (p.imageUrl.startsWith('/') || /^https?:/.test(p.imageUrl) ? p.imageUrl : `${import.meta.env.BASE_URL}${p.imageUrl}`))
    const active = Math.max(0, docs.findIndex((p) => p.id === activePlanId))
    return whenIdle(() => prewarmPlans(urls, window.innerWidth, window.innerHeight, urls.slice(Math.max(0, active - 1), active + 2)))
  }, [resolvedPlanDocs, activePlanId, warm])
}
