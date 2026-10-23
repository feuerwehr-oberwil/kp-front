// @vitest-environment jsdom
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { StringList } from './StringList'

const C = appConfig.copy.admin.stringList
afterEach(cleanup)

describe('StringList — a chip is deleted by the bin and a confirm, never by one tap', () => {
  it('the bin only arms; «Ja» removes the chip', () => {
    const onChange = vi.fn()
    render(<StringList value={['Polizei', 'Sanität']} onChange={onChange} ariaLabel="Partner" />)
    fireEvent.click(screen.getByLabelText(fillTemplate(C.removeItem, { item: 'Polizei' })))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(fillTemplate(C.removeItemConfirm, { item: 'Polizei' }))).toBeTruthy()
    fireEvent.click(screen.getByText(appConfig.copy.admin.common.confirmYes))
    expect(onChange).toHaveBeenCalledWith(['Sanität'])
  })
})
