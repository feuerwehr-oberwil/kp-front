import { apiGet } from './api'
import { readThrough } from './idb'
import { isBoardTemplate, type BoardTemplate } from './boardTemplate'
import fksErsteFuehrung from '../data/boardTemplates/fks-erste-fuehrung.json'

/**
 * The station's board templates — distributed exactly like the checklists (docs/board-templates.md):
 * `admin_board_templates push` uploads each file as the reference dataset `tafel:<id>` and prunes
 * the ones that left the manifest; this reads them through IndexedDB so a Tafel opened offline
 * still offers its pages.
 *
 * ⚠️ A station set REPLACES the bundled one, never joins it (owner, 10.10.2026): a station that
 * loaded its own copy of the FKS file must not see «Erste Führung» twice, and one that dropped a
 * page must not get it back from the bundle. The bundled FKS file is only the answer while the
 * station has published nothing — and the starting point a station copies.
 */

export const TAFEL_PREFIX = 'tafel:'
const CACHE_KEY = 'kp-front-board-templates'

/** The bundled FKS set (validated against the backend model by a pytest, too). */
export const BUNDLED_TEMPLATES: BoardTemplate[] = [fksErsteFuehrung as BoardTemplate]

/** `tafel:<id>` — a board template dataset (no further colon segments: there are no assets). */
export const isTafelTemplateId = (id: string): boolean =>
  id.startsWith(TAFEL_PREFIX) && /^[a-z0-9][a-z0-9-]*$/.test(id.slice(TAFEL_PREFIX.length))

const hasTemplates = (v: unknown): v is BoardTemplate[] => Array.isArray(v) && v.length > 0 && v.every(isBoardTemplate)

/** The template set for this deployment. NEVER throws: offline or on a fresh station the Tafel
 *  still offers the last set it saw, else the bundled FKS one. */
export async function loadBoardTemplates(): Promise<BoardTemplate[]> {
  const { value } = await readThrough<BoardTemplate[]>(
    CACHE_KEY,
    async () => {
      const list = await apiGet<{ id: string }[]>('/api/reference')
      const ids = (list ?? []).map((d) => d.id).filter(isTafelTemplateId).sort()
      const fetched = await Promise.all(ids.map((id) =>
        apiGet<unknown>(`/api/reference/${id}`).then((j) => (isBoardTemplate(j) ? j : null)).catch(() => null)))
      return fetched.filter((t): t is BoardTemplate => t !== null)
    },
    { validate: hasTemplates, fallback: () => BUNDLED_TEMPLATES, shouldFallback: () => true },
  )
  return value
}

let warm: Promise<BoardTemplate[]> | null = null
/** Loaded once per session the first time a Tafel asks; the bundle answers until it lands. */
export function warmBoardTemplates(): Promise<BoardTemplate[]> {
  warm ??= loadBoardTemplates()
  return warm
}
/** test seam */
export const resetWarmBoardTemplates = () => { warm = null }
