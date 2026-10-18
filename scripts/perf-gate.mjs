// The performance gate's judgement of ONE number against its baseline — the pure part of
// scripts/perf-report.mjs, kept apart so scripts/perf-gate.test.mjs can feed it the numbers of a
// real CI run. docs/testing/perf-journeys.md has the whole picture.

/**
 * How much worse than the baseline a number may get before it fails, per unit: max(abs, rel × base).
 * A count or a size barely moves between runs; a time on a shared runner moves a lot. `warn` is the
 * share of the tolerance from which a number is flagged but passes. The baseline may override any
 * of these per metric (`tolerance: { "idle.saves": { "abs": 0 } }`).
 */
export const TOLERANCE = {
  count: { abs: 2, rel: 0.15 },
  kb: { abs: 5, rel: 0.05 },
  mb: { abs: 1.5, rel: 0.25 },
  ms: { abs: 60, rel: 0.5 },
}
/**
 * Wider bands for the numbers that are noisy BY NATURE, matched on the metric's name. Measured on
 * two runs of the same build (05.10.2026): a save count follows the debounce's timing (10 vs 12
 * saves for the same twenty edits), the workspace bytes a follower polls follow the saves, and a
 * maximum, a long-task count or the time blocked past 50 ms jumps on one task more or less
 * (long tasks 17 vs 10, Verlauf blocking 58 vs 145 ms). Each still catches the regression it
 * exists for — a loop that saves on every frame, a surface that blocks for a second.
 */
export const NOISY = [
  [/blocking_ms$/, { abs: 150, rel: 1 }],
  [/long_tasks$/, { abs: 10, rel: 0.5 }],
  [/interaction_max_ms$/, { abs: 100, rel: 0.75 }],
  [/\.saves$/, { abs: 3, rel: 0.25 }],
  [/api_kb$/, { abs: 20, rel: 0.25 }],
]
export const WARN_SHARE = 0.4

/**
 * How much slower than the baseline's machine today's runner is: today's calibration over the
 * baseline's, clamped to ×1–1.5. Every `ms` budget is multiplied by it.
 *
 * ⚠️ Never below ×1 (18.10.2026). GitHub hands out three kinds of runner, calibrating at ~29, ~38
 * and ~46 ms (the baseline's was 38.4). Up the scale holds: the slow kind calibrates ×1.21 of the
 * middle one and the app's times there are ×1.19 (median over the ms metrics, 74 walks since
 * 13.10.). Down it does not: the fast kind calibrates ×0.76, but the app's times there are ×0.90
 * of the middle kind's, and `edit.karte_script_ms` ×0.96 (1,352 vs 1,416 ms). The old floor of
 * ×0.67 shrank that budget to 1,268–1,291 ms on ×0.74–0.75 runners, and builds that had not
 * touched the Karte failed it three times (#379, #384: best of two 1,275–1,423 ms). A fast runner
 * is judged by the baseline as it was recorded.
 */
export function speedFactor(calibration, baselineCalibration) {
  if (!calibration || !baselineCalibration) return 1
  return Math.min(1.5, Math.max(1, calibration / baselineCalibration))
}

/** the tolerance for one metric: its unit's, widened if it is noisy by name, the baseline's override last */
export function toleranceFor(key, unit, overrides = {}) {
  return { ...TOLERANCE[unit], ...(NOISY.find(([re]) => re.test(key))?.[1] ?? {}), ...(overrides[key] ?? {}) }
}

/**
 * One number against its baseline: the expected value (a time scaled by `speed`), the limit above
 * which it fails, and the status — `regressed`, `warn` (past WARN_SHARE of the tolerance),
 * `improved` (better by more than the tolerance) or `ok`.
 */
export function judge({ key, unit, base, now, speed = 1, overrides = {} }) {
  const tol = toleranceFor(key, unit, overrides)
  const expected = unit === 'ms' ? base * speed : base
  const slack = Math.max(tol.abs, tol.rel * expected)
  const limit = expected + slack
  let status = 'ok'
  if (now > limit) status = 'regressed'
  else if (now > expected + slack * WARN_SHARE) status = 'warn'
  else if (now < expected - slack) status = 'improved'
  return { expected, limit, status }
}
