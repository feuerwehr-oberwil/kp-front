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

  // S2 (20.10.2026): the task is the row's sub-line, and a one-line ellipsis cut what to do
  it('lets the task text run to two lines — the row is marked for the sub-line clamp', () => {
    render(
      <>
        <ReminderBanner due={[due('r1', 'Rückmeldung Strom an EBL: Hauptschalter Liegenschaft Nr. 14 ausgeschaltet bestätigen', '2026-08-23T10:30:00Z')]}
          onDone={() => {}} onSnooze={() => {}} />
        <Meldeleiste />
      </>,
    )
    expect(document.querySelector('.ml .ml-row')?.classList.contains('sub2')).toBe(true)
  })

  it('says nothing when nothing is due', () => {
    render(<><ReminderBanner due={[]} onDone={() => {}} onSnooze={() => {}} /><Meldeleiste /></>)
    expect(document.querySelector('.ml')).toBeNull()
  })
})

// RBAC audit V3 (22.10.2026): «Erledigt» / «+10 min» write Verlauf rows, so a session that writes
// none (a viewer, a view or alarm link) gets the row without them – the title still opens the Verlauf
describe('ReminderBanner for a session that cannot write', () => {
  it('shows the due Wiedervorlage with no Erledigt / +10 min', () => {
    render(
      <>
        <ReminderBanner due={[due('r1', 'Rückmeldung an die ELZ', '2026-08-23T10:30:00Z')]} onOpen={() => {}} />
        <Meldeleiste />
      </>,
    )
    const rows = Array.from(document.querySelectorAll('.ml .ml-row'))
    expect(rows).toHaveLength(1)
    expect(screen.getByText('Rückmeldung an die ELZ')).toBeTruthy()
    expect(rows[0].querySelectorAll('.ml-act button')).toHaveLength(0)
  })
})
