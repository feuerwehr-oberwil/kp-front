// @vitest-environment jsdom
// The station's map links (GeoLinks, M10): optional – a station with none draws nothing, not even
// a heading; configured, each opens its template for the place in a new tab; offline they stay,
// disabled, with «Nur mit Netz».

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'

const state = vi.hoisted(() => ({ online: true }))
vi.mock('../lib/useOnline', () => ({ useOnline: () => state.online }))

const { GeoLinks } = await import('./BuildingFacts')
const { loadDeploymentConfig } = await import('../lib/deploymentConfig')
const C = appConfig.copy.building
const AT = [7.5547, 47.5072] as const

afterEach(() => { cleanup(); state.online = true; vi.unstubAllGlobals() })

/** the station's config as /api/config answers it (the real resolver fills the templates) */
const configure = async (externalLinks: { label: string; urlTemplate: string }[]) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ map: { externalLinks } }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  await loadDeploymentConfig()
}

describe('GeoLinks', () => {
  it('draws nothing at all when the station configured none, or the place has no coordinate', async () => {
    await configure([])
    const { container } = render(<GeoLinks at={AT} />)
    expect(container.innerHTML).toBe('')
    await configure([{ label: 'GeoView BL', urlTemplate: 'https://geoview.bl.ch/?E={E}&N={N}' }])
    const { container: noAt } = render(<GeoLinks at={null} />)
    expect(noAt.innerHTML).toBe('')
  })

  it('opens each template for the place in a new tab', async () => {
    await configure([
      { label: 'Geoportal Oberwil', urlTemplate: 'https://geo.example/?x={E}&y={N}' },
      { label: 'GeoView BL', urlTemplate: 'https://geoview.bl.ch/?E={E}&N={N}' },
    ])
    render(<GeoLinks at={AT} />)
    const link = screen.getByRole('link', { name: /GeoView BL/ })
    expect(link.getAttribute('href')).toMatch(/^https:\/\/geoview\.bl\.ch\/\?E=26\d{5}\.\d{2}&N=12\d{5}\.\d{2}$/)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.getByRole('link', { name: /Geoportal Oberwil/ })).toBeTruthy()
    expect(screen.queryByText(C.geoLinksOffline)).toBeNull()
  })

  it('offline: the same buttons, disabled, with «Nur mit Netz»', async () => {
    await configure([{ label: 'GeoView BL', urlTemplate: 'https://geoview.bl.ch/?E={E}&N={N}' }])
    state.online = false
    render(<GeoLinks at={AT} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect((screen.getByRole('button', { name: /GeoView BL/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(C.geoLinksOffline)).toBeTruthy()
  })
})
