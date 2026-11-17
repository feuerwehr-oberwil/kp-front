// @vitest-environment jsdom
// The keys of a text field (lib/fieldKeys): Return in a one-liner commits and leaves, Esc keeps the
// text and leaves, a textarea's Return stays a new line.

import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { leaveOnEscape, ONE_LINE } from './fieldKeys'

afterEach(cleanup)

function Field({ multi = false }: { multi?: boolean }) {
  const [saved, setSaved] = useState('alt')
  const commit = (v: string) => setSaved(v)
  return <>
    {multi
      ? <textarea aria-label="f" defaultValue={saved} onKeyDown={leaveOnEscape} onBlur={(e) => commit(e.currentTarget.value)} />
      : <input aria-label="f" defaultValue={saved} {...ONE_LINE} onBlur={(e) => commit(e.currentTarget.value)} />}
    <output>{saved}</output>
  </>
}

describe('fieldKeys', () => {
  it.each(['Enter', 'Escape'])('%s in a one-liner keeps what was typed and leaves the field', (key) => {
    render(<Field />)
    const f = screen.getByLabelText('f')
    f.focus()
    fireEvent.change(f, { target: { value: 'neu' } })
    fireEvent.keyDown(f, { key })
    expect(document.activeElement).not.toBe(f)
    expect(screen.getByRole('status').textContent).toBe('neu')
  })

  it('labels the return key «done» – and it acts', () => {
    render(<Field />)
    expect(screen.getByLabelText('f').getAttribute('enterkeyhint')).toBe('done')
  })

  it('Esc in a textarea keeps the text and leaves; Return stays a new line', () => {
    render(<Field multi />)
    const f = screen.getByLabelText('f')
    f.focus()
    fireEvent.keyDown(f, { key: 'Enter' })
    expect(document.activeElement).toBe(f)
    fireEvent.change(f, { target: { value: 'zwei\nZeilen' } })
    fireEvent.keyDown(f, { key: 'Escape' })
    expect(document.activeElement).not.toBe(f)
    expect(screen.getByRole('status').textContent).toBe('zwei\nZeilen')
  })
})
