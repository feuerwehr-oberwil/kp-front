// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ChecklistEntryReader } from './ChecklistReference'
import type { RefEntry } from '../lib/checklists'
import { openPhoto } from '../lib/ui'

// The diagram opener shipped broken TWICE before this test existed: once handing pinch to the
// browser (a no-op inside a modal dialog), once as a hand-rolled viewer on a class that set no
// `position`, so it sat at the top of <body> — in the DOM, invisible on screen. Both were
// re-implementations of lib/ui · PhotoZoom. What is pinned here is therefore not the zoom maths
// (that belongs to PhotoZoom) but the wiring: the figure is a real button, and pressing it hands
// the asset to the ONE viewer the rest of the app already uses.

vi.mock('../lib/ui', () => ({ openPhoto: vi.fn() }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

const entry = (content: RefEntry['content']): RefEntry => ({
  id: 'tiefgaragenbrand', title: 'Tiefgaragenbrand', keywords: [], content,
})

const IMAGE = entry([{ type: 'image', page: 14, caption: 'Variante 2' }])

describe('reference diagrams', () => {
  it('resolves the asset URL through the owning template', () => {
    render(<ChecklistEntryReader entry={IMAGE} templateId="el-taktik" />)
    expect(screen.getByAltText('Variante 2').getAttribute('src')).toBe(
      '/api/reference/checklists:el-taktik:p14',
    )
  })

  it('opens the shared picture viewer when pressed', () => {
    render(<ChecklistEntryReader entry={IMAGE} templateId="el-taktik" />)
    fireEvent.click(screen.getByRole('button', { name: /Diagramm vergrössern: Variante 2/i }))
    expect(openPhoto).toHaveBeenCalledWith(
      '/api/reference/checklists:el-taktik:p14',
      // download: false — a Kommandoakten diagram is reference, not incident media
      expect.objectContaining({ caption: 'Variante 2', download: false }),
    )
  })

  it('names the button for itself rather than borrowing the image alt', () => {
    // without an explicit label the accessible name is computed from the inner <img>, so the
    // caption was announced twice and nothing said the diagram could be opened at all
    render(<ChecklistEntryReader entry={IMAGE} templateId="el-taktik" />)
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(/vergrössern/i)
  })

  it('renders nothing for an image whose template is unknown', () => {
    // the asset URL cannot be built without the owning template id
    render(<ChecklistEntryReader entry={IMAGE} templateId={null} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('bullet depth', () => {
  it('marks each level so a step and its detail do not read alike', () => {
    render(
      <ChecklistEntryReader
        entry={entry([
          { type: 'bullet', text: 'Taktik festlegen' },
          { type: 'bullet', text: 'Innenangriff?', level: 1 },
        ])}
        templateId="el-taktik"
      />,
    )
    expect(screen.getByText('Taktik festlegen').closest('[data-level]')?.getAttribute('data-level')).toBe('0')
    expect(screen.getByText('Innenangriff?').closest('[data-level]')?.getAttribute('data-level')).toBe('1')
  })

  it('clamps runaway nesting to the deepest level the stylesheet defines', () => {
    render(<ChecklistEntryReader entry={entry([{ type: 'bullet', text: 'tief', level: 7 }])} templateId="t" />)
    expect(screen.getByText('tief').closest('[data-level]')?.getAttribute('data-level')).toBe('2')
  })
})
