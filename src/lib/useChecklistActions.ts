import type { Dispatch, SetStateAction } from 'react'
import type { ChecklistState, ChecklistTemplate, Item } from './checklists'
import type { TimelineEvent } from '../types'

interface ChecklistActionsDeps {
  /** editor + not replay/EL-view — viewers can't tick. */
  canTick: boolean
  checklists: ChecklistState
  setChecklists: Dispatch<SetStateAction<ChecklistState>>
  /** who ticked (user?.display_name), stamped on the Tick. */
  authorName: string | undefined
  log: (icon: string, text: string, kind?: TimelineEvent['kind']) => void
  emit: (op_type: string, payload?: Record<string, unknown>) => void
}

/**
 * Checklist tick + branch mutations, lifted out of the IncidentWorkspace god-component. Ticks
 * are per-incident synced state; milestone ticks also surface in the Verlauf and every tick emits
 * an audit event for the time-travel replay. (The item `action` deep-link — journal/plan/draw
 * navigation — stays inline in App next to the nav setters it drives.)
 */
export function useChecklistActions({ canTick, checklists, setChecklists, authorName, log, emit }: ChecklistActionsDeps) {
  const toggleTick = (template: ChecklistTemplate, item: Item) => {
    if (!canTick) return
    setChecklists((cl) => {
      const prev = cl[template.id] ?? { ticks: {}, activeBranch: {} }
      const ticks = { ...prev.ticks }
      const wasChecked = !!ticks[item.id]
      if (wasChecked) delete ticks[item.id]
      else ticks[item.id] = { t: new Date().toISOString(), by: authorName }
      return { ...cl, [template.id]: { ...prev, ticks } }
    })
    const checking = !checklists[template.id]?.ticks[item.id]
    // Milestone ticks surface in the Verlauf (kept clean — non-milestones stay silent);
    // every tick still emits an audit event for the time-travel replay.
    if (item.milestone && checking) log('check', `☑ ${item.text}`, 'journal')
    emit('checklist.tick', { template: template.id, item: item.id, checked: checking, milestone: !!item.milestone })
  }
  const setBranch = (templateId: string, phaseId: string, branchId: string) => {
    if (!canTick) return
    setChecklists((cl) => {
      const prev = cl[templateId] ?? { ticks: {}, activeBranch: {} }
      return { ...cl, [templateId]: { ...prev, activeBranch: { ...prev.activeBranch, [phaseId]: branchId } } }
    })
    emit('checklist.branch', { template: templateId, phase: phaseId, branch: branchId })
  }
  return { toggleTick, setBranch }
}
