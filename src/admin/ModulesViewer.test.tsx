// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { ModulesViewer } from './ModulesViewer'
import type { DeploymentModule } from '../lib/deploymentConfig'
import type { ObjectWithPlans } from '../lib/incidents'

const modules: DeploymentModule[] = [
  { id: 'modul1', code: 'M1', title: 'Übersicht', order: 1, match: 'modul\\s*1' },
  { id: 'modul2-3', title: 'Etagen', order: 2, combinedWith: ['modul2', 'modul3'] },
  { id: 'modul5', title: 'Wasser', order: 5, family: true },
]

function plan(module: string): ObjectWithPlans['plans'][number] {
  return {
    id: `pl-${module}`,
    object_id: 'o1',
    module,
    kind: 'pdf',
    title: null,
    source_type: 'import',
    source_note: null,
    content_type: 'application/pdf',
    size_bytes: 1,
    feature_count: null,
    current_version: 1,
    updated_at: '2026-06-28T00:00:00Z',
  }
}

function obj(id: string, module: string): ObjectWithPlans {
  return {
    id,
    name: id,
    address: null,
    lat: null,
    lng: null,
    source_note: null,
    updated_at: '2026-06-28T00:00:00Z',
    plans: [plan(module)],
    distance_m: null,
  }
}

const objects: ObjectWithPlans[] = [obj('o1', 'modul1'), obj('o2', 'modul5-wasser')]

describe('ModulesViewer', () => {
  afterEach(cleanup)

  it('renders module titles', () => {
    render(<ModulesViewer modules={modules} objects={objects} />)
    expect(screen.getByText('Übersicht')).toBeTruthy()
    expect(screen.getByText('Wasser')).toBeTruthy()
    expect(screen.getByText('Etagen')).toBeTruthy()
  })

  it('counts a family-module slot plan toward coverage', () => {
    render(<ModulesViewer modules={modules} objects={objects} />)
    // modul5 (family) matches the 'modul5-wasser' plan of one of the two objects.
    const row = screen.getByText('Wasser').closest('tr') as HTMLElement
    expect(within(row).getByText('1/2 Objekte')).toBeTruthy()
  })

  it('shows the family badge', () => {
    render(<ModulesViewer modules={modules} objects={objects} />)
    expect(screen.getByText('Familie')).toBeTruthy()
  })

  it('renders the detection regex', () => {
    render(<ModulesViewer modules={modules} objects={objects} />)
    expect(screen.getByText('modul\\s*1')).toBeTruthy()
  })

  it('shows an empty state with no modules', () => {
    render(<ModulesViewer modules={[]} objects={objects} />)
    expect(screen.getByText(/Keine Module konfiguriert/)).toBeTruthy()
  })

  it('has no action buttons (read-only)', () => {
    const { container } = render(<ModulesViewer modules={modules} objects={objects} />)
    expect(container.querySelectorAll('button').length).toBe(0)
  })
})
