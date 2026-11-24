// @vitest-environment jsdom
import { createElement } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { createIncident } from '../../lib/incidents'
import { appConfig } from '../../config/appConfig'
import { defuseAutofill } from '../../lib/typingField'
import { EinsatzWizard } from './EinsatzWizard'

vi.mock('../../lib/incidents', () => ({
  createIncident: vi.fn(() => new Promise(() => {})),
  listObjects: vi.fn(async () => [{ id: 's', name: 'School', address: 'School Road 1', lng: 7.55, lat: 47.45, plans: [] }]),
  geocodeSearch: vi.fn(async () => []), geocodeReverse: vi.fn(async () => null),
}))
vi.mock('../MapPicker', () => ({ MapPicker: () => null }))

it('the incident keeps the explicitly selected object when an older GPS request finishes', async () => {
  let locate!: PositionCallback
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition: (success: PositionCallback) => { locate = success },
  } })
  const ix = appConfig.copy.intake
  render(createElement(EinsatzWizard, { onClose: vi.fn(), onCreated: vi.fn() }))
  fireEvent.click(screen.getByRole('button', { name: ix.hereButton }))
  fireEvent.change(screen.getByPlaceholderText(defuseAutofill(ix.addressPlaceholder)), { target: { value: 'School' } })
  fireEvent.click(await screen.findByRole('button', { name: /School Road 1/ }))
  await act(async () => locate({ coords: { longitude: 7.6, latitude: 47.5 } } as GeolocationPosition))
  fireEvent.click(document.querySelector<HTMLButtonElement>('.ip-btn.primary')!)
  expect(vi.mocked(createIncident).mock.calls[0]?.[0]).toMatchObject({ address: 'School Road 1', lng: 7.55, lat: 47.45 })
})
