// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { Meldeleiste } from './Meldeleiste'
import { useMeldung } from '../lib/useMeldung'
import type { Meldung } from '../lib/meldungen'

// What variant B promises, and nothing else: every pending message is a row of the same kind, in
// rank order, each carrying its own buttons — and the row BODY is inert, which is the complaint
// that started the rework (a tap meant to read a message took an alarm).
//
// Since 23.08. that rule is one notch narrower: the TITLE of a message that has somewhere to go
// is a control (Meldung · onOpen). Everything else in the body — the sub-line, the glyph, the
// space beside them — still does nothing, and these tests pin both halves of that.

/** publishes up to three messages and renders the strip that orders them */
function Host({ items }: { items: (Meldung | null)[] }) {
  useMeldung(items[0] ?? null)
  useMeldung(items[1] ?? null)
  useMeldung(items[2] ?? null)
  return <Meldeleiste />
}

const alarm: Meldung = {
  id: 'alarm:1', kind: 'alarm', tone: 'alarm', icon: 'bell', title: 'Neuer Alarm — Brand',
  actions: [{ label: 'Übernehmen', primary: true, onClick: () => {} }],
  dismiss: { label: 'Ausblenden', onClick: () => {} },
}
const reminder = (actions: Meldung['actions']): Meldung => ({
  id: 'reminder', kind: 'reminder', tone: 'warn', icon: 'bell', title: '1 Erinnerung fällig', actions,
})
const update: Meldung = {
  id: 'update', kind: 'update', tone: 'calm', icon: 'info', title: 'Update bereit',
  actions: [{ label: 'Später', onClick: () => {} }],
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.ml .ml-row'))

afterEach(cleanup)

describe('Meldeleiste', () => {
  // The ✕ column is alignment, not decoration: it exists to make every row's buttons end on one
  // line. With nothing dismissible in the strip there is no line to align to, and holding it open
  // only pads the right edge with 44px of nothing — which is what Bastian saw and asked about.
  it('holds the ✕ column open only when some row has a ✕', () => {
    render(<Host items={[reminder([{ label: 'Erledigt', primary: true, onClick: () => {} }])]} />)
    expect(document.querySelector('.ml .ml-x')).toBeNull()
    cleanup()
    render(<Host items={[alarm, reminder([{ label: 'Erledigt', primary: true, onClick: () => {} }])]} />)
    // the alarm's real ✕, and a held-open column on the row that has none
    expect(document.querySelectorAll('.ml .ml-x')).toHaveLength(2)
    expect(document.querySelectorAll('.ml .ml-x.ghost')).toHaveLength(1)
  })

  it('does not exist while nothing is pending', () => {
    render(<Host items={[]} />)
    expect(document.querySelector('.ml')).toBeNull()
  })

  it('shows every pending message as a row, ranked — nothing is folded away', () => {
    render(<Host items={[update, alarm, reminder([{ label: 'Erledigt', primary: true, onClick: () => {} }])]} />)
    expect(rows().map((r) => r.querySelector('.ml-title')?.textContent))
      .toEqual(['Neuer Alarm — Brand', '1 Erinnerung fällig', 'Update bereit'])
    // one live region for the layer, not one per message
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1)
  })

  it('carries every row\'s own actions, so the second message is erledigt where it stands', () => {
    const done = vi.fn()
    const snooze = vi.fn()
    render(<Host items={[alarm, reminder([
      { label: 'Erledigt', primary: true, onClick: done },
      { label: '+10 min', onClick: snooze },
    ])]} />)

    const row = screen.getByText('1 Erinnerung fällig').closest('.ml-row')!
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Erledigt' }))
    expect(done).toHaveBeenCalledOnce()
    expect(snooze).not.toHaveBeenCalled()
  })

  it('leaves the row body inert — reading a message can never run it', () => {
    const take = vi.fn()
    render(<Host items={[{
      ...alarm, sub: 'Hauptstrasse 12, Oberwil',
      actions: [{ label: 'Übernehmen', primary: true, onClick: take }],
    }]} />)

    const title = screen.getByText('Neuer Alarm — Brand')
    // a message with nowhere to go has no control in its body at all
    expect(title.closest('button')).toBeNull()
    fireEvent.click(title)
    fireEvent.click(screen.getByText('Hauptstrasse 12, Oberwil'))
    fireEvent.click(rows()[0])
    expect(take).not.toHaveBeenCalled()
  })

  // The narrow version of the same rule, and the reason it is narrow: the words the operator is
  // reading are what they can follow, everything else around them stays dead.
  it('makes the TITLE the way in where the message has one — and only the title', () => {
    const open = vi.fn()
    const take = vi.fn()
    render(<Host items={[{
      ...alarm, sub: 'Hauptstrasse 12, Oberwil',
      actions: [{ label: 'Übernehmen', primary: true, onClick: take }],
      onOpen: { label: 'In Verlauf öffnen', onClick: open },
    }]} />)

    const title = screen.getByText('Neuer Alarm — Brand').closest('button')!
    expect(title).not.toBeNull()
    fireEvent.click(title)
    expect(open).toHaveBeenCalledOnce()

    // the sub-line and the rest of the row are still dead, and no third button appeared
    fireEvent.click(screen.getByText('Hauptstrasse 12, Oberwil'))
    fireEvent.click(rows()[0])
    expect(open).toHaveBeenCalledOnce()
    expect(take).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'In Verlauf öffnen' })).toBeNull()
  })

  // Voice control is spoken against what is on screen, so the accessible name has to contain the
  // visible words (WCAG 2.5.3) — and the visible words alone never say what following them does.
  it('names the title control with both halves: what the message is, and where it leads', () => {
    render(<Host items={[{ ...alarm, onOpen: { label: 'In Verlauf öffnen', onClick: () => {} } }]} />)
    const title = screen.getByRole('button', { name: 'Neuer Alarm — Brand · In Verlauf öffnen' })
    expect(title.title).toBe('In Verlauf öffnen')
  })

  it('holds the ✕ column open on a row that may not be dismissed, so the buttons line up', () => {
    // a due Wiedervorlage is erledigt or verschoben, never waved away — but its row still ends
    // on the same vertical line as the alarm's
    render(<Host items={[alarm, reminder([{ label: 'Erledigt', primary: true, onClick: () => {} }])]} />)
    const [alarmRow, reminderRow] = rows()
    expect(alarmRow.querySelector('button.ml-x')).not.toBeNull()
    expect(reminderRow.querySelector('button.ml-x')).toBeNull()
    expect(reminderRow.querySelector('.ml-x.ghost')).not.toBeNull()
  })
})
