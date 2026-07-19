// Pure decision rules for the service-worker update flow — kept free of the
// virtual:pwa-register import so they stay unit-testable (swUpdate.ts wires them up).

/** How long after page load a discovered update may still be applied silently. */
export const BOOT_APPLY_WINDOW_MS = 15_000
/** Forced reload if the SW 'controlling' event never delivers one after skipWaiting. */
export const RELOAD_WATCHDOG_MS = 4_000
/** Minimum gap between visibility-resume update checks (always-on tablets). */
export const RESUME_CHECK_MIN_GAP_MS = 5 * 60 * 1000

/** A freshly discovered update may be applied WITHOUT asking only at boot: shortly after
 *  load, before the operator has touched anything (nothing is in progress, so the reload is
 *  invisible), and at most once per tab session — a broken build must never reload-loop.
 *  Everything else goes through the banner (prompt semantics, the 3am rule). */
export function shouldAutoApply(opts: {
  msSinceLoad: number
  interacted: boolean
  alreadyAutoApplied: boolean
}): boolean {
  return opts.msSinceLoad < BOOT_APPLY_WINDOW_MS && !opts.interacted && !opts.alreadyAutoApplied
}

// ── automatic-apply budget ──────────────────────────────────────────────────────────────
// All AUTOMATIC applies (boot silent apply + stalled-update recovery) share one persistent
// budget. It must live in localStorage, NOT sessionStorage: on iOS standalone the watchdog's
// forced reload can land in a fresh session, so a session-scoped counter reset every cycle —
// a wedged waiting worker then reload-looped forever behind the «Neue Version wird geladen»
// cover (field report 2026-07-08). The window lets a later deploy earn a fresh budget.

export const MAX_AUTO_APPLY_ATTEMPTS = 3
export const AUTO_APPLY_WINDOW_MS = 6 * 60 * 60 * 1000

export interface AutoApplyRecord { n: number; at: number }

/** May another automatic apply be attempted? `rec` is the persisted counter (null = none). */
export function autoApplyBudgetLeft(rec: AutoApplyRecord | null, now: number): boolean {
  if (!rec || now - rec.at > AUTO_APPLY_WINDOW_MS) return true
  return rec.n < MAX_AUTO_APPLY_ATTEMPTS
}

/** The counter after spending one attempt now (windows restart once the old one expires). */
export function recordAutoApply(rec: AutoApplyRecord | null, now: number): AutoApplyRecord {
  if (!rec || now - rec.at > AUTO_APPLY_WINDOW_MS) return { n: 1, at: now }
  return { n: rec.n + 1, at: rec.at }
}
