// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import type { DeploymentModule } from '../lib/deploymentConfig'
import type { ObjectWithPlans } from '../lib/incidents'

// Only `GET /api/objects/plan-sources` is mocked — everything else in lib/api stays real, so a
// second, unexpected call would still go through the real request path and fail loudly.
const apiGet = vi.fn()
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, apiGet: (path: string) => apiGet(path) }
})

import { ModulesViewer } from './ModulesViewer'

const modules: DeploymentModule[] = [
  { id: 'modul1', code: 'M1', title: 'Übersicht', order: 1, match: 'modul\\s*1' },
  { id: 'modul2-3', title: 'Etagen', order: 2, combinedWith: ['modul2', 'modul3'] },
  { id: 'modul5', title: 'Wasser', order: 5, family: true },
]

function plan(module: string, sourceType = 'import'): ObjectWithPlans['plans'][number] {
  return {
    id: `pl-${module}`,
    object_id: 'o1',
    module,
    kind: 'pdf',
    title: null,
    source_type: sourceType,
    source_note: null,
    content_type: 'application/pdf',
    size_bytes: 1,
    feature_count: null,
    current_version: 1,
    updated_at: '2026-06-28T00:00:00Z',
  }
}

function obj(id: string, module: string, over: Partial<ObjectWithPlans> = {}): ObjectWithPlans {
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
    ...over,
  }
}

const objects: ObjectWithPlans[] = [obj('o1', 'modul1'), obj('o2', 'modul5-wasser')]

beforeEach(() => {
  apiGet.mockReset()
  // Default: the connector state never arrives, which is what an unstubbed test gets — and the
  // line under test then renders nothing at all.
  apiGet.mockRejectedValue(new Error('not stubbed'))
})

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

  // ⚠️ The claim is «this surface mutates nothing», not «it has no <button> element»: since the
  // house-style pass the badges explain themselves through `InfoTip`, whose trigger is a real
  // button on purpose (keyboard-focusable, and tappable on the iPad a native `title=` is
  // invisible on). So the count that must stay at zero is buttons that are NOT a hint trigger.
  it('has no action buttons (read-only)', () => {
    const { container } = render(<ModulesViewer modules={modules} objects={objects} />)
    const actions = [...container.querySelectorAll('button')].filter((b) => !b.classList.contains('adm-tip-trigger'))
    expect(actions.length).toBe(0)
  })
})

// The page's first line: through which door plans arrive, and whether an automatic one is open.
describe('ModulesViewer — where the plans come from', () => {
  afterEach(cleanup)

  const mixed: ObjectWithPlans[] = [
    obj('o1', 'modul1', { plans: [plan('modul1', 'uploaded'), plan('modul2', 'sharepoint')] }),
    obj('o2', 'modul5-wasser', { source_key: 'werkhof', plans: [plan('modul5-wasser', 'snapshot')] }),
  ]

  it('counts the plans per door, naming the raw source_type it has no word for', async () => {
    render(<ModulesViewer modules={modules} objects={mixed} />)
    expect(await screen.findByText('1 × Hand-Upload')).toBeTruthy()
    expect(screen.getByText('1 × SharePoint')).toBeTruthy()
    expect(screen.getByText('1 × Planspeicher')).toBeTruthy()
    // the shared fixture's 'import' is a door nobody named — shown verbatim rather than guessed at
    cleanup()
    render(<ModulesViewer modules={modules} objects={objects} />)
    expect(screen.getByText('2 × import')).toBeTruthy()
  })

  it('says that nothing is scheduled — as the normal case, not a fault', async () => {
    apiGet.mockResolvedValue({ bucket: false, sharepoint: false })
    render(<ModulesViewer modules={modules} objects={mixed} />)
    expect(await screen.findByText(/Kein zeitgesteuerter Abgleich/)).toBeTruthy()
    expect(screen.queryByText(/Ordner-Schlüssel/)).toBeNull()
  })

  it('names both running pulls and points at the pages that own them', async () => {
    apiGet.mockResolvedValue({ bucket: true, sharepoint: true })
    render(<ModulesViewer modules={modules} objects={mixed} />)
    expect(await screen.findByText('Planspeicher und SharePoint')).toBeTruthy()
    expect(screen.getByText(/Zugangsdaten › SharePoint/)).toBeTruthy()
  })

  it('counts the objects the Planspeicher-Abgleich will never touch', async () => {
    apiGet.mockResolvedValue({ bucket: true, sharepoint: false })
    render(<ModulesViewer modules={modules} objects={mixed} />)
    // one of the two has a source_key; the other was typed into the Objekt-Maske
    expect(await screen.findByText(/1 von 2 Objekten haben keinen Ordner-Schlüssel/)).toBeTruthy()
  })

  it('stays silent while the connector state is unknown, rather than claiming there is none', async () => {
    render(<ModulesViewer modules={modules} objects={mixed} />)
    // the tally is local data and shows at once; the configuration claim never appears
    await screen.findByText('1 × Hand-Upload')
    expect(screen.queryByText(/zeitgesteuerter Abgleich/i)).toBeNull()
  })
})
