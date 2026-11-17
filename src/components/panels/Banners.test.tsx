// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
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
        alarms={[alarm]} dismissed={new Set()} onDismiss={() => {}} taking={null} attachFirst={attachFirst}
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

// What ✕ put away has no strip in the Meldeleiste (17.11.2026): the alarm stays listed in the
// «Einsätze» lists, a hidden update has its row in the Einsatz menu (AppMenuRows)
describe('✕-ed alarms and updates', () => {
  it('an alarm whose row was ✕-ed leaves no row in the Meldeleiste', () => {
    render(
      <>
        <IncomingAlarmBanner alarms={[alarm]} dismissed={new Set([alarm.divera_id])} onDismiss={() => {}}
          taking={null} attachFirst={false} onTake={() => {}} />
        <Meldeleiste />
      </>,
    )
    expect(document.querySelectorAll('.ml-row')).toHaveLength(0)
  })

  it('a hidden «Alarm aktualisiert» leaves no row either; a pending one has its row', async () => {
    const { AlarmUpdateBanner } = await import('./Banners')
    const meta = (state: 'hidden' | 'pending') => ({
      id: 'inc-1', title: 'Brand',
      alarm_update: { state, at: new Date().toISOString(), title: 'Brand, Musterweg 21', lat: null, lng: null,
        fields: [{ field: 'text', current: 'Rauch', alarm: 'Rauch, Person vermisst', edited: false }] },
    }) as unknown as IncidentMeta
    const { unmount } = render(<><AlarmUpdateBanner meta={meta('hidden')} onChanged={() => {}} onEdit={() => {}} /><Meldeleiste /></>)
    expect(document.querySelectorAll('.ml-row')).toHaveLength(0)
    unmount()
    render(<><AlarmUpdateBanner meta={meta('pending')} onChanged={() => {}} onEdit={() => {}} /><Meldeleiste /></>)
    expect(document.querySelector('.ml-row')?.textContent).toContain(ix.alarmUpdate.title)
  })
})
