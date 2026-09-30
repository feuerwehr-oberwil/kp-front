// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { LageGrundgeruestCard } from './LageGrundgeruestCard'

// 30.09.2026 (owner: «drop the grundgerüst change in type»): the head NAMES the Einsatzart whose
// list it shows and offers no way to change it — the chip that opened the Einsatzdaten is gone.

afterEach(() => cleanup())

const props = {
  rows: [],
  progress: { done: 0, total: 0, complete: false },
  category: 'brandbekaempfung',
  armedSlotId: null,
  onArm: vi.fn(), onPlace: vi.fn(), onToKarte: vi.fn(),
}

describe('LageGrundgeruestCard head', () => {
  it('says the Einsatzart as a plain word on the tablet card — no button in the head', () => {
    const { container } = render(<LageGrundgeruestCard {...props} phone={false} />)
    const head = container.querySelector('.lgg-head')!
    expect(head.querySelector('.lgg-art')?.textContent).toBe('Brand')
    expect(head.querySelectorAll('button')).toHaveLength(0)
  })

  it('keeps the phone strip to its one toggle', () => {
    const { container } = render(<LageGrundgeruestCard {...props} phone />)
    const head = container.querySelector('.lgg-head')!
    expect(head.querySelector('.lgg-art')?.textContent).toBe('Brand')
    expect([...head.querySelectorAll('button')].map((b) => b.getAttribute('aria-expanded'))).toEqual(['false'])
    expect(screen.queryByRole('button', { name: /Einsatzart/ })).toBeNull()
  })
})
