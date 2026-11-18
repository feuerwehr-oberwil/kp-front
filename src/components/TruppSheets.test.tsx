// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AuftragSheet, LeitungField } from './TruppSheets'
import type { Trupp } from '../types'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

afterEach(cleanup)
const az = appConfig.copy.atemschutz

function Field({ initial = null }: { initial?: number | null }) {
  const [v, setV] = useState<number | null>(initial)
  return <LeitungField label="Leitung" value={v} options={[{ no: 2, onPlan: true }]} onChange={setV} />
}

// owner, 28.10.2026: the typed Leitung stood as a chip on the line above the stepper that set it
describe('LeitungField · «Nr. …»', () => {
  it('opens the stepper in the chip row and shows the typed number there only', () => {
    render(<Field initial={7} />)
    const row = screen.getByRole('group', { name: 'Leitung' })
    expect(within(row).getByRole('group', { name: az.lineTyped })).toBeTruthy()
    // a choice chip carries aria-pressed; the stepper's own value button («Ltg 7») does not
    const chips7 = within(row).queryAllByRole('button', { name: new RegExp(`^${fillTemplate(az.lineChip, { n: 7 })}`) })
    expect(chips7.filter((b) => b.hasAttribute('aria-pressed'))).toHaveLength(0)
    expect(within(row).queryByRole('button', { name: az.lineTyped })).toBeNull()
  })

  // owner pick M5b 1, 18.11.2026: «keine» stayed lit beside the opened stepper
  it('a tap opens it on the lowest undrawn number, and «keine» goes dark', () => {
    render(<Field />)
    const keine = screen.getByRole('button', { name: az.lineNone })
    expect(keine.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: az.lineTyped }))
    expect(keine.getAttribute('aria-pressed')).toBe('false')
    // Ltg 2 is drawn, so «Nr. …» opens on 1
    const stepper = screen.getByRole('group', { name: az.lineTyped })
    expect(within(stepper).getByRole('button', { name: fillTemplate(az.lineChip, { n: 1 }) })).toBeTruthy()
  })

  it('a drawn chip closes the stepper again', () => {
    render(<Field initial={7} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${fillTemplate(az.lineChip, { n: 2 })}`) }))
    expect(screen.queryByRole('group', { name: az.lineTyped })).toBeNull()
    expect(screen.getByRole('button', { name: az.lineTyped })).toBeTruthy()
  })
})

// rare-user F13 (17.11.2026): a Leitung on a Plan says the word, not a bare « · P»
describe('LeitungField · a Leitung on a Plan', () => {
  it('reads «Ltg 2 · Plan»', () => {
    render(<Field />)
    expect(screen.getByRole('button', { name: `${fillTemplate(az.lineChip, { n: 2 })} · ${az.lineOnPlan}` })).toBeTruthy()
  })
})

// owner, 17.11.2026 (duck sweep CONT.3): a close with typed changes SAVES them; only «Abbrechen» drops
describe('AuftragSheet · closing keeps what was typed', () => {
  const t: Trupp = {
    id: 't1', no: 2, name: 'Hirter Stephan', members: [], auftrag: 'loeschen', ziel: 'Keller',
    entryPressureBar: 280, entryTime: '2026-09-26T20:00:00Z', lastContactTime: '2026-09-26T20:05:00Z', status: 'aktiv',
  }
  const open = () => {
    const onSave = vi.fn(async () => true)
    const onClose = vi.fn()
    render(<AuftragSheet t={t} leitungOptions={[]} onSave={onSave} onClose={onClose} />)
    return { onSave, onClose }
  }
  const type = (v: string) => fireEvent.change(screen.getByPlaceholderText(az.zielPlaceholder), { target: { value: v } })

  it('✕ with a typed Ziel saves it, then closes', async () => {
    const { onSave, onClose } = open()
    type('Dachstock')
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.closeDialog }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ ziel: 'Dachstock' }))
  })

  it('✕ with nothing changed only closes', () => {
    const { onSave, onClose } = open()
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.closeDialog }))
    expect(onClose).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('«Abbrechen» throws the change away', () => {
    const { onSave, onClose } = open()
    type('Dachstock')
    fireEvent.click(screen.getByRole('button', { name: az.cancel }))
    expect(onClose).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })
})
