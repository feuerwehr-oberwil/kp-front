// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ChecklistRunner } from './ChecklistRunner'
import type { ChecklistTemplate } from '../lib/checklists'

afterEach(cleanup)

// 30.09.2026 (owner): the list's progress is the bar and «n/m erledigt» — no «%» beside them,
// «0/8 erledigt» already says it. The phases keep their own n/m.
const template = {
  id: 'fu-aktion', kind: 'action', title: 'Aufgaben FU', subtitle: 'Aktions-Checkliste Führungsunterstützung',
  phases: [
    { id: 'a', title: 'Auf Anfahrt', items: [{ id: 'a1', text: 'Objektplan bereitlegen' }, { id: 'a2', text: 'Journal vorbereiten' }] },
    { id: 'b', title: 'Vor Ort', items: [{ id: 'b1', text: 'Absprache mit Einsatzleitung' }, { id: 'b2', text: 'Standort bestimmen' }] },
  ],
} as unknown as ChecklistTemplate

describe('ChecklistRunner head', () => {
  it('says the progress as «n/m erledigt» and a bar, without a percentage', () => {
    const { container } = render(
      <ChecklistRunner template={template} state={{ ticks: { a1: { t: '2026-09-30T21:14:00.000Z' } } }} canTick
        onToggle={() => {}} onBranch={() => {}} onAction={() => {}} />,
    )
    const head = container.querySelector('header')!
    expect(head.textContent).toContain('1/4 erledigt')
    expect(head.textContent).not.toMatch(/\d\s*%/)
    expect(head.querySelector('[class*="cl-bar"]')).toBeTruthy()
    // the subtitle is whole — the ladder folds it away as a unit, never cuts it
    expect(head.querySelector('p')?.textContent).toBe('Aktions-Checkliste Führungsunterstützung')
  })
})
