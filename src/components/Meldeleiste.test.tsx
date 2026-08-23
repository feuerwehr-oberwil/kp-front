// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { Meldeleiste } from './Meldeleiste'
import { useMeldung } from '../lib/useMeldung'
import type { Meldung } from '../lib/meldungen'
import { appConfig } from '../config/appConfig'

// A queued message used to be a headline: tapping it PROMOTED it onto the strip and nothing else
// happened, so «Erledigt» on a due Wiedervorlage cost a tap to reach and hid the list on the way.
// These pin the fix — a queued row is the same row, with the same buttons and a tap that acts.
// The ranking itself is covered in lib/meldungen.test.ts; this is only about the second row down.

const C = appConfig.copy.meldeleiste

/** publishes up to two messages and renders the strip that ranks them */
function Host({ items }: { items: (Meldung | null)[] }) {
  useMeldung(items[0] ?? null)
  useMeldung(items[1] ?? null)
  return <Meldeleiste />
}

const alarm: Meldung = {
  id: 'alarm:1', kind: 'alarm', tone: 'alarm', icon: 'bell', title: 'Neuer Alarm — Brand',
  actions: [{ label: 'Übernehmen', primary: true, onClick: () => {} }],
}

afterEach(cleanup)

const openQueue = () => fireEvent.click(screen.getByRole('button', { expanded: false }))

describe('Meldeleiste queue', () => {
  it('carries the queued message\'s own actions, so it is erledigt where it waits', () => {
    const done = vi.fn()
    const snooze = vi.fn()
    render(<Host items={[alarm, {
      id: 'reminder', kind: 'reminder', tone: 'warn', icon: 'bell', title: '1 Erinnerung fällig',
      actions: [
        { label: 'Erledigt', primary: true, onClick: done },
        { label: '+10 min', onClick: snooze },
      ],
      onOpen: () => {},
    }]} />)
    openQueue()

    const row = screen.getByText('1 Erinnerung fällig').closest('.ml-li')!
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Erledigt' }))
    expect(done).toHaveBeenCalledOnce()
    expect(snooze).not.toHaveBeenCalled()
    // …and the strip still leads with the alarm: acting on a queued row never promoted it
    expect(document.querySelector('.ml-row .ml-title')?.textContent).toBe('Neuer Alarm — Brand')
  })

  it('acts on a tap instead of promoting — the Wiedervorlage opens the Verlauf and the list gets out of the way', () => {
    const open = vi.fn()
    render(<Host items={[alarm, {
      id: 'reminder', kind: 'reminder', tone: 'warn', icon: 'bell', title: '1 Erinnerung fällig',
      actions: [{ label: 'Erledigt', primary: true, onClick: () => {} }],
      onOpen: open,
    }]} />)
    openQueue()

    fireEvent.click(screen.getByText('1 Erinnerung fällig'))
    expect(open).toHaveBeenCalledOnce()
    expect(document.querySelector('.ml-list')).toBeNull()
  })

  it('opens downward and says how many wait — the disclosure is the only place the number is written', () => {
    render(<Host items={[alarm, {
      id: 'update', kind: 'update', tone: 'calm', icon: 'info', title: 'Update bereit',
      actions: [{ label: 'Später', onClick: () => {} }],
    }]} />)

    const more = screen.getByRole('button', { expanded: false })
    expect(more.textContent).toContain('1')
    expect(more.getAttribute('aria-label')).toBe(C.more.replace('{n}', '1'))
    fireEvent.click(more)
    expect(screen.getByRole('button', { expanded: true }).getAttribute('aria-label')).toBe(C.less)
  })

  it('leaves an announce-only row as text — «Update bereit» must not vanish when it is touched to be read', () => {
    render(<Host items={[alarm, {
      id: 'update', kind: 'update', tone: 'calm', icon: 'info', title: 'Update bereit',
      actions: [{ label: 'Später', onClick: () => {} }],
    }]} />)
    openQueue()

    expect(screen.getByText('Update bereit').closest('button')).toBeNull()
  })
})
