// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { LeitungField } from './TruppSheets'
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
    expect(within(row).queryByRole('button', { name: new RegExp(`^${fillTemplate(az.lineChip, { n: 7 })}`) })).toBeNull()
    expect(within(row).queryByRole('button', { name: az.lineTyped })).toBeNull()
  })

  it('a drawn chip closes the stepper again', () => {
    render(<Field initial={7} />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${fillTemplate(az.lineChip, { n: 2 })}`) }))
    expect(screen.queryByRole('group', { name: az.lineTyped })).toBeNull()
    expect(screen.getByRole('button', { name: az.lineTyped })).toBeTruthy()
  })
})
