// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { DeploymentReferenceLayer } from '../lib/deploymentConfig'
import type { ReferenceDataset } from '../lib/incidents'

// Stub the symbol library so the glyph lookup is deterministic.
vi.mock('../lib/useSymbols', () => ({
  useSymbols: () => ({
    ready: true,
    order: [],
    symbols: [],
    byName: { 'VKF Hydrant': '<svg></svg>' },
  }),
}))

import { ReferenceLayersViewer } from './ReferenceLayersViewer'

afterEach(cleanup)

// A minimal dataset row — only the fields the viewer reads.
function ds(over: Partial<ReferenceDataset>): ReferenceDataset {
  return {
    id: 'geo:hydrant',
    object_id: null,
    module: null,
    kind: 'geojson',
    title: null,
    source_type: 'upload',
    source_note: null,
    content_type: null,
    size_bytes: 12345,
    feature_count: 412,
    current_version: 1,
    updated_at: '2026-06-01T10:00:00Z',
    ...over,
  }
}

const layers: DeploymentReferenceLayer[] = [
  { id: 'hydrant', label: 'Hydranten', group: 'Wasser', kind: 'geojson', geojson: '/api/reference/geo:hydrant', symbol: 'VKF Hydrant', vectorKind: 'point' },
  { id: 'missing', label: 'Leitungskataster', group: 'Wasser', kind: 'geojson', geojson: '/api/reference/geo:missing', vectorKind: 'line' },
  { id: 'wms-kanton', label: 'Kanton WMS', group: 'Karten', kind: 'wms', tiles: ['https://wms.example.ch/{z}/{x}/{y}'] },
]

describe('ReferenceLayersViewer — read-only status viewer', () => {
  it('renders no editing controls (only the search filter, no buttons)', () => {
    render(<ReferenceLayersViewer layers={layers} datasets={[ds({})]} />)
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('marks a geojson layer with a matching dataset as «Geladen» with its feature count', () => {
    render(<ReferenceLayersViewer layers={layers} datasets={[ds({})]} />)
    expect(screen.getByText('Geladen')).toBeTruthy()
    // facts are now a single compact "412 Features · 12 KB · …" line — match the substring.
    expect(screen.getByText(/412 Features/)).toBeTruthy()
  })

  it('marks a geojson layer without a matching dataset as «Nicht geladen»', () => {
    render(<ReferenceLayersViewer layers={layers} datasets={[ds({})]} />)
    expect(screen.getByText('Nicht geladen')).toBeTruthy()
  })

  it('marks a WMS/tile layer as «Externe Quelle»', () => {
    render(<ReferenceLayersViewer layers={layers} datasets={[ds({})]} />)
    expect(screen.getByText('Externe Quelle')).toBeTruthy()
  })

  it('filters the layer list by the search box', () => {
    render(<ReferenceLayersViewer layers={layers} datasets={[ds({})]} />)
    expect(screen.getByText('Kanton WMS')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hydrant' } })
    expect(screen.getByText('Hydranten')).toBeTruthy()
    expect(screen.queryByText('Kanton WMS')).toBeNull()
  })

  it('shows the empty state when no layers are configured', () => {
    render(<ReferenceLayersViewer layers={[]} datasets={[]} />)
    expect(screen.getByText('Keine Referenzebenen konfiguriert.')).toBeTruthy()
  })
})
