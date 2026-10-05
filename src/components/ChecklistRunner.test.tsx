// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ChecklistRunner } from './ChecklistRunner'
import type { ChecklistTemplate } from '../lib/checklists'

afterEach(cleanup)

// 30.09.2026 (owner): «n/m erledigt», no «%» beside it. 05.10.2026 (owner): no progress bar
// either, «occupies too much space» — not in the head, not under a phase. The phases keep n/m.
const template = {
  id: 'fu-aktion', kind: 'action', title: 'Aufgaben FU', subtitle: 'Aktions-Checkliste Führungsunterstützung',
  phases: [
    { id: 'a', title: 'Auf Anfahrt', items: [{ id: 'a1', text: 'Objektplan bereitlegen' }, { id: 'a2', text: 'Journal vorbereiten' }] },
    { id: 'b', title: 'Vor Ort', items: [{ id: 'b1', text: 'Absprache mit Einsatzleitung' }, { id: 'b2', text: 'Standort bestimmen' }] },
  ],
} as unknown as ChecklistTemplate

describe('ChecklistRunner head', () => {
  it('says the progress as «n/m erledigt», without a bar or a percentage', () => {
    const { container } = render(
      <ChecklistRunner template={template} state={{ ticks: { a1: { t: '2026-09-30T21:14:00.000Z' } } }} canTick
        onToggle={() => {}} onBranch={() => {}} onAction={() => {}} />,
    )
    const head = container.querySelector('header')!
    expect(head.textContent).toContain('1/4 erledigt')
    expect(head.textContent).not.toMatch(/\d\s*%/)
    expect(container.querySelector('[class*="cl-bar"]')).toBeNull()
    expect(container.textContent).toContain('1/2')
    // the subtitle is whole — the ladder folds it away as a unit, never cuts it
    expect(head.querySelector('p')?.textContent).toBe('Aktions-Checkliste Führungsunterstützung')
  })
})
