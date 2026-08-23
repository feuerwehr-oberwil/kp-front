// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { ReminderBanner } from './ReminderBanner'
import { Meldeleiste } from './Meldeleiste'
import type { OpenReminder } from '../lib/reminders'

// A due Wiedervorlage used to collapse into one row titled «2 Erinnerungen fällig», whose two
// buttons acted on the soonest-due item — so the second one could not be reached at all, and the
// buttons acted on something the row did not name.

const due = (id: string, text: string, dueAt: string): OpenReminder =>
  ({ id, text, dueAt } as OpenReminder)

afterEach(cleanup)

describe('ReminderBanner', () => {
  it('gives every due Wiedervorlage its own row and its own buttons', () => {
    const done: string[] = []
    render(
      <>
        <ReminderBanner
          due={[due('r1', 'Rückmeldung an die ELZ', '2026-08-23T10:30:00Z'),
                due('r2', 'Lüfter zurückbauen', '2026-08-23T10:45:00Z')]}
          onDone={(r) => done.push(r.id)}
          onSnooze={() => {}}
        />
        <Meldeleiste />
      </>,
    )
    const rows = Array.from(document.querySelectorAll('.ml .ml-row'))
    expect(rows).toHaveLength(2)
    expect(screen.getByText('Rückmeldung an die ELZ')).toBeTruthy()
    expect(screen.getByText('Lüfter zurückbauen')).toBeTruthy()

    // …and the SECOND row's Erledigt closes the second item, not the soonest-due one
    fireEvent.click(rows[1].querySelectorAll('.ml-act button')[0])
    expect(done).toEqual(['r2'])
  })

  // «In Verlauf öffnen» was a third labelled button for an hour on 23.08. Three buttons made
  // «öffnen» read as a peer of «Erledigt»; as the title it is a link inside the sentence, and the
  // two buttons that HANDLE the Wiedervorlage are the only buttons left.
  it('opens the Verlauf from the title, on the row that raised the item — not from a third button', () => {
    const opened: string[] = []
    render(
      <>
        <ReminderBanner
          due={[due('r1', 'Rückmeldung an die ELZ', '2026-08-23T10:30:00Z'),
                due('r2', 'Lüfter zurückbauen', '2026-08-23T10:45:00Z')]}
          onDone={() => {}}
          onSnooze={() => {}}
          onOpen={(r) => opened.push(r.id)}
        />
        <Meldeleiste />
      </>,
    )
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.ml .ml-row'))
    // Erledigt und +10 min — und sonst nichts
    expect(rows[1].querySelectorAll('.ml-act button')).toHaveLength(2)

    fireEvent.click(rows[1].querySelector('button.ml-open')!)
    expect(opened).toEqual(['r2'])
  })

  it('leaves the title inert where the Verlauf cannot be reached', () => {
    render(
      <>
        <ReminderBanner due={[due('r1', 'Rückmeldung an die ELZ', '2026-08-23T10:30:00Z')]}
          onDone={() => {}} onSnooze={() => {}} />
        <Meldeleiste />
      </>,
    )
    expect(document.querySelector('.ml .ml-open')).toBeNull()
  })

  it('says nothing when nothing is due', () => {
    render(<><ReminderBanner due={[]} onDone={() => {}} onSnooze={() => {}} /><Meldeleiste /></>)
    expect(document.querySelector('.ml')).toBeNull()
  })
})
