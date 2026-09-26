/**
 * ONE gesture on a plan is ONE undo step, whichever stack ends up owning it (AGENTS · «Ownership
 * decides the undo stack»; review of PR #226, 25.09.2026).
 *
 * A plan step lays its own checkpoint the moment it begins (useBoardDoc · pushPast →
 * IncidentWorkspace · rememberPlanStep): a snapshot of the sheet on its per-plan history and an
 * entry on the global timeline. Only the fold that follows can tell whom the edit touched — and
 * when it reaches an object the sheet does not OWN (a Karte symbol projected onto it), the store
 * takes the step on its own stack (useObjectStore · onForeignStep). Both stayed, so a plan-panel
 * edit of a Karte-owned symbol cost two ↶ presses and the second reported «a step was lost».
 *
 * This link remembers the plan step that is open and withdraws BOTH of its halves when the store
 * takes the step: the timeline entry (its dropper) and the per-plan snapshot (`popPlanPast`). The
 * step closes with the gesture (`closed`), so a later store step — a Trupp sweep, a Karte write —
 * can never withdraw a plan entry it has nothing to do with.
 */
export interface PlanStepLink {
  /** a plan step began: `drop` takes its timeline entry back off again */
  opened: (planId: string, drop: () => void) => void
  /** the store took this step on its own stack (useObjectStore · onForeignStep) */
  foreignTaken: () => void
  /** the gesture is over (useBoardDoc · onStepEnd) */
  closed: () => void
}

export function createPlanStepLink(popPlanPast: (planId: string) => void): PlanStepLink {
  let open: { planId: string; drop: () => void } | null = null
  return {
    opened: (planId, drop) => { open = { planId, drop } },
    foreignTaken: () => {
      if (!open) return
      const { planId, drop } = open
      open = null
      drop()
      popPlanPast(planId)
    },
    closed: () => { open = null },
  }
}
