// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The record table (ui.tsx · RecordTable / RecordRows) — a list editor's records as rows of one
// grid: Ebene | Bezeichnung | Wert | ⓘ, the record's name written ONCE in a cell that spans its
// own rows.
//
// Three things decide whether it holds, and none of them is how it looks:
//
//   · the head spans exactly its record's rows. CSS cannot count them, so React writes the span —
//     which means a miscount is not a wobble but every record below shifted by one row. The
//     count has to follow a record that grows a validation line, and one that loses it again.
//   · every attribute row still binds its label to its control. `SettingRow` finds the Wert
//     cell's first focusable element and points the label at it; the record column must not have
//     become that element, and a record head is not a label.
//   · a record's bin deletes ITS record. The name and the delete sit in the same spanning cell
//     now, three rows away from the row the eye is on when it decides to click.
//
// What is NOT here: column widths and the spanning geometry, which jsdom has no layout engine
// for. They are measured in a real browser — tmp/gridcheck.cjs, `.adm-records` scenario.

import { ConfirmButton, RecordRows, RecordTable, SettingRow, SettingsNote } from './ui'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.common

afterEach(cleanup)

/** The head cell of the record called `name`. */
const head = (name: string) => {
  const el = screen.getByText(name).closest('.adm-rec-head')
  if (!el) throw new Error(`no record head for «${name}»`)
  return el as HTMLElement
}

/** A layer record: two fields, and a warning line only while `warn` is set. */
function Layer({ name, warn, onRemove }: { name: string; warn?: string; onRemove?: () => void }) {
  return (
    <RecordRows
      name={name}
      swatch="#0f52b5"
      meta="Version 2 · 1264 Features"
      action={onRemove && (
        <ConfirmButton className="adm-formlink-x" ariaLabel={`${name} löschen`} label="🗑"
          question="Ebene löschen?" danger onConfirm={onRemove} />
      )}
    >
      <SettingRow label={`${name} · Bezeichnung`}>
        <input className="adm-input" readOnly value={name} />
      </SettingRow>
      <SettingRow label={`${name} · Kennung`} tip="Technischer Name der Ebene.">
        <input className="adm-input" readOnly value={name.toLowerCase()} />
      </SettingRow>
      {warn && <SettingsNote tone="warn">{warn}</SettingsNote>}
    </RecordRows>
  )
}

const sheet = (children: React.ReactNode) => (
  <RecordTable title="Kartenebenen" recordLabel="Ebene" fieldLabel="Bezeichnung">{children}</RecordTable>
)

describe('the record head is written once, and spans exactly its own rows', () => {
  it('gives each record one head, and the columns their names', () => {
    render(sheet(<><Layer name="Hydranten" /><Layer name="Reserven" /></>))
    expect(document.querySelectorAll('.adm-rec-head')).toHaveLength(2)
    // …and the name is not repeated as a row label of its own
    expect(screen.getAllByText('Hydranten')).toHaveLength(1)
    const headers = [...document.querySelectorAll('.adm-set-h')].map((h) => h.textContent)
    expect(headers).toEqual(['Ebene', 'Bezeichnung', C.colValue, 'ⓘ'])
  })

  it('spans the rows the record actually has — a validation line included', () => {
    const { rerender } = render(sheet(<Layer name="Hydranten" />))
    expect(head('Hydranten').style.gridRow).toBe('span 2')
    // the file was refused: the record grows a line, and the head has to grow with it
    rerender(sheet(<Layer name="Hydranten" warn="LV95 statt WGS84." />))
    expect(head('Hydranten').style.gridRow).toBe('span 3')
    // …and shrinks back when the next attempt succeeds
    rerender(sheet(<Layer name="Hydranten" />))
    expect(head('Hydranten').style.gridRow).toBe('span 2')
  })

  it('carries the record\'s swatch and meta line, not the rows', () => {
    render(sheet(<Layer name="Hydranten" />))
    const h = head('Hydranten')
    expect(within(h).getByText(/1264 Features/)).toBeTruthy()
    expect(h.querySelector('.adm-rec-swatch')).toBeTruthy()
  })
})

describe('an attribute row is still a row of the settings table', () => {
  it('binds every label to its own control', () => {
    render(sheet(<><Layer name="Hydranten" /><Layer name="Reserven" /></>))
    // getByLabelText only finds these if SettingRow's `for` still points at the Wert cell's
    // first focusable element — the record column must not have become that element
    expect((screen.getByLabelText('Hydranten · Bezeichnung') as HTMLInputElement).value).toBe('Hydranten')
    expect((screen.getByLabelText('Reserven · Kennung') as HTMLInputElement).value).toBe('reserven')
  })

  it('keeps the ⓘ column: the row with a tip has a trigger, the one without has none', () => {
    render(sheet(<Layer name="Hydranten" />))
    const rows = [...document.querySelectorAll('.adm-set-row')]
    const tips = rows.map((r) => r.querySelectorAll('.adm-set-info button').length)
    expect(tips).toEqual([0, 1])
  })
})

describe('a record\'s bin deletes that record', () => {
  it('confirms and calls only the handler of the record it sits in', async () => {
    const first = vi.fn()
    const second = vi.fn()
    render(sheet(
      <>
        <Layer name="Hydranten" onRemove={first} />
        <Layer name="Reserven" onRemove={second} />
      </>,
    ))
    const bin = within(head('Reserven')).getByLabelText('Reserven löschen')
    await act(async () => { fireEvent.click(bin) })
    await act(async () => { fireEvent.click(screen.getByText(C.confirmYes)) })
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })
})
