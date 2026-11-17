// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { IncomingAlarmBanner } from './Banners'
import { Meldeleiste } from '../Meldeleiste'
import { appConfig } from '../../config/appConfig'
import type { DiveraAlarm, IncidentMeta } from '../../lib/incidents'

// A dispatch that arrives while a hand-made Einsatz is open is the one case where taking it is
// the wrong tap: the Übung has no alarm behind it, so nothing routes times into its Zeiten
// until this alarm is attached — and a take would open a second Einsatz beside the one the
// crew is standing in. The row says so by which button is filled, and by reading order.

const alarm: DiveraAlarm = {
  divera_id: 36591264,
  title: 'Brandmeldeanlage',
  address: 'Bachweg 1, Musterdorf',
  received_at: new Date().toISOString(),
} as DiveraAlarm

const ix = appConfig.copy.intake

const labels = (attachFirst: boolean, canAttach = true) => {
  render(
    <>
      <IncomingAlarmBanner
        alarms={[alarm]} dismissed={new Set()} onDismiss={() => {}} onShow={() => {}} taking={null} attachFirst={attachFirst}
        onTake={() => {}} onAttach={canAttach ? () => {} : undefined}
      />
      <Meldeleiste />
    </>,
  )
  const buttons = Array.from(document.querySelectorAll<HTMLElement>('.ml-act button'))
  return {
    order: buttons.map((b) => b.textContent?.trim()),
    primary: buttons.find((b) => b.classList.contains('primary') || b.classList.contains('go'))?.textContent?.trim(),
  }
}

afterEach(cleanup)

describe('IncomingAlarmBanner', () => {
  it('leads with Öffnen while the open Einsatz came from an alarm', () => {
    const { order, primary } = labels(false)
    expect(order).toEqual([ix.alarmOpen, ix.attachShort])
    expect(primary).toBe(ix.alarmOpen)
  })

  it('leads with «Zu Einsatz» while the open Einsatz was made by hand', () => {
    const { order, primary } = labels(true)
    // both actions stay reachable — only the emphasis moves
    expect(order).toEqual([ix.attachShort, ix.alarmOpen])
    expect(primary).toBe(ix.attachShort)
  })

  it('offers no «Zu Einsatz» at all while the open Einsatz is closed — and Öffnen is the one filled', () => {
    // review of #235: attached to a closed Einsatz, the dispatch's Zeiten and Meldung would land
    // in a closed record; App passes no onAttach then (isIncidentRunning)
    const { order, primary } = labels(true, false)
    expect(order).toEqual([ix.alarmOpen])
    expect(primary).toBe(ix.alarmOpen)
  })
})

describe('IncomingAlarmBanner · time', () => {
  it('reads today’s alarm as the clock alone, like every row (LISTS.10)', () => {
    labels(false)
    const sub = document.querySelector('.ml')?.textContent ?? ''
    expect(sub).toContain('Bachweg 1')
    expect(sub).not.toMatch(/\d\d\.\d\d\.,? \d\d:\d\d/)
    expect(sub).toMatch(/\d\d:\d\d/)
  })
})

// Rare-user round M3 = C (17.11.2026): ✕ folds the row to a grey strip in its own place, and
// «Zeigen» on it is the way back – no toast, nothing gone for good.
describe('IncomingAlarmBanner · hidden', () => {
  it('a hidden alarm is one strip «Ausgeblendet · <Stichwort>» whose «Zeigen» brings the row back', () => {
    const shown: DiveraAlarm[] = []
    render(
      <>
        <IncomingAlarmBanner alarms={[alarm]} dismissed={new Set([alarm.divera_id])} onDismiss={() => {}}
          onShow={(a) => shown.push(a)} taking={null} attachFirst={false} onTake={() => {}} />
        <Meldeleiste />
      </>,
    )
    const rows = document.querySelectorAll('.ml-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].classList.contains('fold')).toBe(true)
    expect(rows[0].textContent).toContain(`${ix.hiddenAlarm} · Brandmeldeanlage`)
    expect(rows[0].querySelector('.ml-x')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: ix.showAlarm }))
    expect(shown).toEqual([alarm])
  })

  it('leaves no strip once the alarm is older than 3 h', () => {
    const old = { ...alarm, received_at: new Date(Date.now() - 4 * 3600_000).toISOString() }
    render(
      <>
        <IncomingAlarmBanner alarms={[old]} dismissed={new Set([alarm.divera_id])} onDismiss={() => {}}
          onShow={() => {}} taking={null} attachFirst={false} onTake={() => {}} />
        <Meldeleiste />
      </>,
    )
    expect(document.querySelectorAll('.ml-row')).toHaveLength(0)
  })
})

// Rare-user round F7 (17.11.2026): a hidden «Alarm aktualisiert» is served to every device and
// folds to the same strip; «Zeigen» asks the server to make it pending again.
describe('AlarmUpdateBanner · hidden', () => {
  it('folds to «Ausgeblendet · Alarm aktualisiert – …» with «Zeigen», and none past 3 h', async () => {
    const { AlarmUpdateBanner } = await import('./Banners')
    const meta = (at: string) => ({
      id: 'inc-1', title: 'Brand',
      alarm_update: { state: 'hidden', at, title: 'Brand, Musterweg 21', lat: null, lng: null,
        fields: [{ field: 'text', current: 'Rauch', alarm: 'Rauch, Person vermisst', edited: false }] },
    }) as unknown as IncidentMeta
    const { unmount } = render(<><AlarmUpdateBanner meta={meta(new Date().toISOString())} onChanged={() => {}} onEdit={() => {}} /><Meldeleiste /></>)
    const row = document.querySelector('.ml-row.fold')
    expect(row?.textContent).toContain(`${ix.hiddenAlarm} · ${ix.alarmUpdate.title} – Brand`)
    expect(screen.getByRole('button', { name: ix.showAlarm })).toBeTruthy()
    unmount()
    render(<><AlarmUpdateBanner meta={meta(new Date(Date.now() - 4 * 3600_000).toISOString())} onChanged={() => {}} onEdit={() => {}} /><Meldeleiste /></>)
    expect(document.querySelectorAll('.ml-row')).toHaveLength(0)
  })
})
