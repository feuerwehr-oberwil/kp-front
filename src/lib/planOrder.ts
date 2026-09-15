import { DEFAULT_MODULES, getDeploymentConfig, type DeploymentModule } from './deploymentConfig'

/**
 * ONE order for Objektplan-Module, read by every surface that lists them: the Verwaltung's
 * Modulpläne table, an object's «Pläne» chips, the Modul-Katalog and the incident's plan rail.
 *
 * ⚠️ The **number on the paper plan leads** — «M4» comes before «M5», «M5 ZUS» and «M6», because
 * that is the order a Kommandant knows the modules in and the order every printed Einsatzplan is
 * bound in. The catalogue's `order` field only breaks ties, and deliberately so: it has drifted
 * in every real catalogue (the shipped defaults put Modul 4 at 7, the Oberwil station document
 * puts the Modul-5 family at 8 and Photovoltaik at 5), so ordering by it put M4 behind ZUS and
 * M6. Correcting those numbers would mean editing station data on a running deployment and would
 * still leave every other station's document wrong; deriving the order from the id cannot.
 *
 * The rest of the key, in order: a family's sub-slots (`modul5-pv`, `modul5-zusatz`) sit directly
 * AFTER their family and never between two other modules; a combined sheet (`modul2-3`) sorts on
 * the LAST module it covers, so it closes the run it replaces; and a module the catalogue does
 * not list at all goes last, because it is a leftover rather than part of the stock.
 */
interface Rank {
  /** 1 = no catalogue entry resolves this id — a leftover plan, shown last */
  off: number
  /** the module number the id carries; a combined `modulA-B` ranks on B */
  num: number
  /** 1 = a family sub-slot, which follows its family */
  sub: number
  order: number
  /** position in the catalogue, so equal `order` values keep the document's own sequence */
  idx: number
  id: string
}

/** `modul5-wasser2` → number 5, suffix «wasser2»; `modul2-3` → number 2, suffix «3». */
function parseModuleId(id: string): { num: number | null; suffix: string | null } {
  const m = /^modul(\d+)(?:[-_/](.+))?$/.exec(id.toLowerCase())
  return m ? { num: Number(m[1]), suffix: m[2] ?? null } : { num: null, suffix: null }
}

/** A numbered sub-slot sibling → the slot it is a copy of: `modul5-wasser2` → `modul5-wasser`. */
const SUB_SLOT_SIBLING = /^(modul\d+-\D+)\d+$/

/** The catalogue entry a plan's module id belongs to: itself, the slot a numbered sibling is a
 *  copy of, or the family whose prefix it carries. Undefined = off-catalogue. */
function entryFor(catalogue: readonly DeploymentModule[], id: string): DeploymentModule | undefined {
  const exact = catalogue.find((m) => m.id === id)
  if (exact) return exact
  const base = SUB_SLOT_SIBLING.exec(id)?.[1]
  const sibling = base ? catalogue.find((m) => m.id === base) : undefined
  if (sibling) return sibling
  return catalogue.find((m) => m.family && id.startsWith(`${m.id}-`))
}

function rankOf(catalogue: readonly DeploymentModule[], id: string): Rank {
  const { num, suffix } = parseModuleId(id)
  const combined = suffix != null && /^\d+$/.test(suffix)
  const entry = entryFor(catalogue, id)
  const idx = entry ? catalogue.indexOf(entry) : Number.POSITIVE_INFINITY
  return {
    off: entry ? 0 : 1,
    num: combined ? Number(suffix) : num ?? Number.POSITIVE_INFINITY,
    sub: suffix != null && !combined ? 1 : 0,
    order: entry?.order ?? 999,
    idx,
    id,
  }
}

/** The comparator every list uses. Memoised per call, so sorting a long list ranks each id once. */
export function comparePlanModules(catalogue: readonly DeploymentModule[]): (a: string, b: string) => number {
  const ranks = new Map<string, Rank>()
  const of = (id: string) => {
    const known = ranks.get(id)
    if (known) return known
    const next = rankOf(catalogue, id)
    ranks.set(id, next)
    return next
  }
  return (a, b) => {
    const x = of(a)
    const y = of(b)
    return x.off - y.off || x.num - y.num || x.sub - y.sub || x.order - y.order || x.idx - y.idx
      || x.id.localeCompare(y.id)
  }
}

/** The catalogue itself, in the order every surface lists modules in. Never mutates the input. */
export function sortPlanModules<T extends DeploymentModule>(catalogue: readonly T[]): T[] {
  const cmp = comparePlanModules(catalogue)
  return catalogue.slice().sort((a, b) => cmp(a.id, b.id))
}

/** Bare module ids (the incident rail's tiles, an object's stored plan keys) in the same order. */
export function sortPlanModuleIds(catalogue: readonly DeploymentModule[], ids: readonly string[]): string[] {
  const cmp = comparePlanModules(catalogue)
  return ids.slice().sort(cmp)
}

/** Stored plans in the same order — an object's «Pläne» chips and its Modulpläne rows. */
export function sortPlansByModule<T extends { module?: string | null }>(
  catalogue: readonly DeploymentModule[],
  plans: readonly T[],
): T[] {
  const cmp = comparePlanModules(catalogue)
  return plans.slice().sort((a, b) => cmp(a.module ?? '', b.module ?? ''))
}

/** The in-force catalogue: the station's own, or the shipped national defaults when it has none.
 *  Only for callers with no catalogue of their own — a page that already holds one passes it. */
export function moduleCatalogue(): DeploymentModule[] {
  const configured = getDeploymentConfig().modules ?? []
  return configured.length ? configured : DEFAULT_MODULES
}
