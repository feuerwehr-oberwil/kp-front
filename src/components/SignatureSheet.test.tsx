// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SignatureSheet } from './SignatureSheet'
import { appConfig } from '../config/appConfig'

afterEach(cleanup)

const mount = (onSetEndNow?: () => void) => render(
  <SignatureSheet open onClose={() => {}} initialRole="el" signedRoles={{}}
    elName={{ name: 'Meier Anna' }} kdtName={{ name: '' }}
    summary={{ einsatz: 'Wasser · 12.11.2026', personen: 3, positionen: 1 }} placeDate="Oberwil, 14.11.2026"
    onSign={async () => true} personnel={[]} presentIds={new Set()} onSetEndNow={onSetEndNow} />,
)

describe('SignatureSheet · Einsatzende fehlt', () => {
  const S = appConfig.copy.signature

  it('offers «Jetzt eintragen» while the open Rapport has no Einsatzende', () => {
    const setNow = vi.fn()
    mount(setNow)
    expect(screen.getByText(S.endMissing)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: S.endNow }))
    expect(setNow).toHaveBeenCalledOnce()
  })

  it('says nothing once there is one (or the Rapport is closed)', () => {
    mount()
    expect(screen.queryByText(S.endMissing)).toBeNull()
  })
})
