// @vitest-environment jsdom
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The two pieces of behaviour the strict settings table added, and neither is layout:
//
//   · the Standard column speaks ONLY for a deviation. A column that printed «Standard 100» on
//     every row would be the wall of prose it replaced, one column to the right — so «empty»
//     is the answer for a value that is still the shipped one, and for a value the document
//     does not store at all (which IS the shipped one, by definition).
//   · the ⓘ opens on a TAP. It used to be one `open` boolean driven by hover and click alike,
//     which on an iPad meant the synthetic mouseenter opened it and the click that followed
//     closed it again — the explanation was unreachable on the device the app is used on.

const { apiGet, apiPut, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number
    detail: string
    constructor(status: number, detail: string) { super(detail); this.status = status; this.detail = detail }
  }
  return { apiGet: vi.fn(), apiPut: vi.fn(), ApiError }
})
vi.mock('../lib/api', () => ({ apiGet, apiPut, ApiError }))

import { ConfigGate, ConfigProvider } from './ConfigContext'
import {
  AlarmsSection, DoctrineSection, FleetSection, IdentitySection, MapSection, ReportSection,
} from './ConfigSections'
import { InfoTip } from './InfoTip'
import { standardNote } from './ui'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

const C = appConfig.copy.admin.common
const D = appConfig.copy.admin.doctrine
const R = appConfig.copy.admin.report
const SHIPPED_ALARM_BAR = appConfig.atemschutz.alarmBar

/** The note as the column prints it for a given shipped default. */
const note = (value: string | number) => fillTemplate(C.standardChanged, { value: String(value) })

describe('standardNote — the Standard column only speaks for a deviation', () => {
  it('says nothing while the document stores nothing (the setting IS the default)', () => {
    expect(standardNote(null, 100)).toBeNull()
    expect(standardNote(undefined, 100)).toBeNull()
    expect(standardNote('', '#e8392b')).toBeNull()
  })

  it('says nothing when the stored value is the default', () => {
    expect(standardNote(100, 100)).toBeNull()
    expect(standardNote('#e8392b', '#e8392b')).toBeNull()
    expect(standardNote(true, true)).toBeNull()
  })

  it('says nothing for a setting with no default anybody could act on', () => {
    // a station's own map centre, its Kommandant, its Heimatort
    expect(standardNote(2611500, null)).toBeNull()
    expect(standardNote('Hauptmann Paul', undefined)).toBeNull()
  })

  it('names the default when the value deviates', () => {
    expect(standardNote(60, 100)).toBe(note(100))
    expect(standardNote('#0044cc', '#e8392b')).toBe(note('#e8392b'))
  })

  it('reads a boolean as Ja/Nein — «Standard true» is not a word anybody set', () => {
    expect(standardNote(false, true)).toBe(note(C.standardOn))
    expect(standardNote(true, false)).toBe(note(C.standardOff))
  })

  it('does not call a number and its own text two different values', () => {
    // the document holds numbers, a form holds text; 30 and «30» are one value
    expect(standardNote(30, '30')).toBeNull()
  })
})

describe('InfoTip — reachable with a mouse AND with a finger', () => {
  afterEach(cleanup)

  const trigger = () => screen.getByRole('button', { name: fillTemplate(appConfig.copy.admin.infoTip.prefix, { label: 'Alarmdruck' }) })
  const pop = () => document.querySelector('.adm-tip-pop')!
  const isOpen = () => pop().hasAttribute('data-open')

  const mount = () => render(<InfoTip label="Alarmdruck" text="Druck, ab dem der Trupp zurückgeht." />)

  it('opens on hover and closes when the pointer leaves', () => {
    mount()
    expect(isOpen()).toBe(false)
    fireEvent.mouseEnter(trigger().parentElement!)
    expect(isOpen()).toBe(true)
    fireEvent.mouseLeave(trigger().parentElement!)
    expect(isOpen()).toBe(false)
  })

  it('⚠️ opens on a TAP and STAYS open — the pointer press that focuses it must not un-pin it', () => {
    mount()
    const t = trigger()
    // exactly what a finger produces: pointerdown, focus, click — in that order
    fireEvent.pointerDown(t)
    fireEvent.focus(t)
    fireEvent.click(t)
    expect(isOpen()).toBe(true)
  })

  it('closes on a second tap', () => {
    mount()
    const t = trigger()
    fireEvent.pointerDown(t); fireEvent.focus(t); fireEvent.click(t)
    expect(isOpen()).toBe(true)
    fireEvent.pointerDown(t); fireEvent.click(t)
    expect(isOpen()).toBe(false)
  })

  it('stays open when a hovering mouse leaves a pop it pinned', () => {
    mount()
    const wrap = trigger().parentElement!
    fireEvent.mouseEnter(wrap)
    fireEvent.pointerDown(trigger()); fireEvent.click(trigger())
    fireEvent.mouseLeave(wrap)
    expect(isOpen()).toBe(true)
  })

  it('closes on Escape and on a tap outside', () => {
    mount()
    fireEvent.pointerDown(trigger()); fireEvent.click(trigger())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(isOpen()).toBe(false)

    fireEvent.pointerDown(trigger()); fireEvent.click(trigger())
    expect(isOpen()).toBe(true)
    fireEvent.pointerDown(document.body)
    expect(isOpen()).toBe(false)
  })
})

describe('the Standard column on a real page', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  const open = async (alarmBar: number) => {
    apiGet.mockReset().mockResolvedValue({
      version: 'v1',
      doctrine: { alarmBar, alarmBarRueckzug: null },
    })
    await act(async () => { render(<ConfigProvider><DoctrineSection /></ConfigProvider>) })
    await waitFor(() => expect(document.querySelectorAll('input[type="number"]').length).toBeGreaterThan(0))
  }

  /** The Standard cell of the row whose label is `label`, or '' when it is empty. */
  const standardOf = (label: string) =>
    screen.getByText(label).closest('.adm-set-row')?.querySelector('.adm-set-std')?.textContent ?? null

  it('stays empty while the station runs on the shipped Alarmdruck', async () => {
    await open(SHIPPED_ALARM_BAR)
    expect(standardOf(D.alarmBar)).toBe('')
  })

  it('names the shipped value once the station has changed it', async () => {
    await open(SHIPPED_ALARM_BAR - 40)
    expect(standardOf(D.alarmBar)).toBe(note(SHIPPED_ALARM_BAR))
  })
})

/** «Journal» was one setting behind its own nav stop, its own sheet head and its own column
 *  header. It is a group on Rapport now — so the setting has to BE there, or the merge quietly
 *  deleted the only way to edit the Textbausteine. */
describe('Textbausteine after the Journal page was folded into Rapport', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
    apiGet.mockReset().mockResolvedValue({
      version: 'v1',
      journal: { quickPhrases: ['Wasser marsch', 'Trupp zurück'] },
      report: { hoursRounding: { stepMin: 30, graceMin: 5 }, reversePrintOrder: true, links: [], partnerOrgs: [] },
    })
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('is editable on the Rapport page', async () => {
    // ⚠️ Inside the ConfigGate, exactly as AdminShell renders it. The textarea seeds itself from
    // the draft on its FIRST render, so a Journal group rendered before the document has loaded
    // would seed from the shipped phrases and then save those over the station's own.
    render(<ConfigProvider><ConfigGate><ReportSection /></ConfigGate></ConfigProvider>)
    await waitFor(() => expect(document.querySelector('.adm-textarea-tall')).toBeTruthy())
    const box = document.querySelector<HTMLTextAreaElement>('.adm-textarea-tall')!
    expect(box.value).toBe('Wasser marsch\nTrupp zurück')

    await act(async () => { fireEvent.change(box, { target: { value: 'Wasser marsch\nRohr 1 bereit' } }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    const calls = apiPut.mock.calls
    const sent = calls[calls.length - 1]?.[1] as { journal?: { quickPhrases?: string[] } } | undefined
    expect(sent?.journal?.quickPhrases).toEqual(['Wasser marsch', 'Rohr 1 bereit'])
  })
})

/**
 * ⚠️ The row's HIT AREA, which is not the same thing as its layout.
 *
 * All four cells used to sit inside one <label>, so a click anywhere in the hover band activated
 * the control: reading what the Standard column said about the print order flipped the print
 * order. Only the label TEXT is a target now, and it reaches the control through `for`/id — which
 * is the part that could rot silently, because a label pointing at nothing still LOOKS like a
 * label.
 */
describe('a settings row is clickable on its label and nowhere else', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
    // reversePrintOrder OFF, so this row is the one with something in its Standard cell
    apiGet.mockReset().mockResolvedValue({
      version: 'v1',
      report: { hoursRounding: { stepMin: 30, graceMin: 5 }, reversePrintOrder: false, links: [], partnerOrgs: [] },
    })
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  const box = () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  const row = () => screen.getByText(R.reverseOrder).closest('.adm-set-row')!
  const open = async () => {
    render(<ConfigProvider><ConfigGate><ReportSection /></ConfigGate></ConfigProvider>)
    await waitFor(() => expect(document.querySelector('input[type="checkbox"]')).toBeTruthy())
  }

  it('binds the label to the control by id — no call site passes one', async () => {
    await open()
    expect(screen.getByLabelText(R.reverseOrder)).toBe(box())
    // the row itself is no longer a <label>: it may not wrap the control again
    expect(row().tagName).toBe('DIV')
  })

  it('toggles the checkbox from the label text', async () => {
    await open()
    expect(box().checked).toBe(false)
    await act(async () => { fireEvent.click(screen.getByText(R.reverseOrder)) })
    expect(box().checked).toBe(true)
  })

  it('⚠️ leaves the control alone when the Standard cell is clicked', async () => {
    await open()
    const std = row().querySelector('.adm-set-std')!
    expect(std.textContent).toBe(note(C.standardOn)) // …i.e. this cell has something to read
    await act(async () => { fireEvent.click(std) })
    expect(box().checked).toBe(false)
    expect(document.activeElement).not.toBe(box())
  })
})

/**
 * ⚠️ The one invariant the whole layout stands on, and the one nothing else would catch.
 *
 * A settings row is a `display: contents` box, so its four cells are items of the
 * `.adm-settings` GRID rather than of the row. Put a row — or a group heading, or a note — inside
 * a box of its own (anything that is not itself `display: contents`) and that box becomes the
 * grid item instead: the row collapses into a single column, and every column below it stops
 * lining up. Nothing throws, no test fails, and it
 * looks fine in a diff. So the structure is asserted, on every Station page at once.
 */
describe('the settings grid', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiPut.mockReset().mockImplementation(async (_p: string, body: unknown) => body)
    apiGet.mockReset().mockResolvedValue({
      version: 'v1',
      identity: {}, doctrine: { alarmBar: SHIPPED_ALARM_BAR },
      map: { defaultView: {}, geocoder: {}, externalLinks: [] },
      report: { hoursRounding: { stepMin: 30, graceMin: 5 }, reversePrintOrder: true, links: [], partnerOrgs: [] },
      alarms: { autoArchiveDays: 7, staleIncidentDays: 30, captureWindowHours: 12, webhooks: [], groups: [] },
    })
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  const SECTIONS = [
    ['Doktrin', DoctrineSection], ['Station & Karte', IdentitySection], ['Karte', MapSection],
    ['Rapport', ReportSection], ['Alarme & Einsätze', AlarmsSection],
    ['Fahrzeuge & Symbole', FleetSection],
  ] as const

  /** The two grids a Station row may sit in: the settings table and the record table. A page
   *  may have both (Alarme & Einsätze) or only one (Fahrzeuge & Symbole). */
  const GRIDS = ['adm-settings', 'adm-records']

  /** Wrappers allowed to stand between a grid and a row, because they are `display: contents`
   *  and so are not layout boxes at all. `.adm-formlink` groups ONE record of a list editor
   *  inside a settings sheet; `.adm-rec` does the same in a record table, where the record's
   *  head cell spans its rows (ui · RecordRows).
   *  ⚠️ Anything NOT on this list is a real box and breaks every column below it. */
  const TRANSPARENT = ['adm-formlink', 'adm-rec']

  it.each(SECTIONS)('puts every row of %s directly in the grid', async (_name, Section) => {
    const { container } = render(<ConfigProvider><Section /></ConfigProvider>)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await waitFor(() => expect(container.querySelectorAll(GRIDS.map((g) => `.${g}`).join(', ')).length).toBeGreaterThan(0))
    const cells = Array.from(container.querySelectorAll('.adm-set-row, .adm-set-grp, .adm-set-note'))
    // …otherwise «no strays» would be true of a page that rendered nothing at all
    expect(cells.length).toBeGreaterThan(0)
    const strays = cells
      .filter((el) => {
        const p = el.parentElement
        if (!p) return true
        return !GRIDS.some((g) => p.classList.contains(g))
          && !TRANSPARENT.some((c) => p.classList.contains(c))
      })
      .map((el) => `${el.className} sits in <${el.parentElement?.tagName.toLowerCase()} class="${el.parentElement?.className}">`)
    expect(strays).toEqual([])
  })
})
