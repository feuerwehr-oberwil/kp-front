// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'
import { getMeldungen } from '../../lib/useMeldung'
import { addPerson, emptySuche, personenViews, type BereichView } from '../../lib/suche'
import type { SucheActions } from '../../lib/useSucheActions'
import type { Incident } from '../../types'
import { JournalComposer } from '../JournalComposer'
import { TopBar } from '../TopBar'
import { SucheAskMeldungen } from './SucheAskMeldungen'

// The second walk-through on staging (25.09.2026): what the Suche got wrong once people used it.

afterEach(cleanup)
const C = appConfig.copy.suche
const css = (file: string) => readFileSync(`${process.cwd()}/src/styles/${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const ask = (over: Partial<BereichView> = {}): BereichView => ({
  id: 'b1', label: 'Keller', name: 'Keller', status: 'inArbeit', trupp: 'Trupp 2', truppId: 't2', statusAt: '', fund: false,
  createdAt: '', rows: [], ...over,
})

describe('N13 · an open «abgesucht?» is where the operator already looks', () => {
  it('one Meldeleiste row per question, answered in place, gone once answered', () => {
    const setStatus = vi.fn()
    const actions = { setStatus } as unknown as SucheActions
    const onOpen = vi.fn()
    const { rerender } = render(<SucheAskMeldungen asks={[ask(), ask({ id: 'b2', label: 'Aula', name: 'Aula', trupp: 'Trupp 4', truppId: 't4' })]} actions={actions} onOpen={onOpen} />)
    const rows = getMeldungen().filter((m) => m.kind === 'suche')
    expect(rows.map((m) => m.title)).toEqual(['Trupp 2 raus – Keller abgesucht?', 'Trupp 4 raus – Aula abgesucht?'])
    // no ✕: the answer is the only way to dismiss it
    expect(rows[0].dismiss).toBeUndefined()
    rows[0].actions![0].onClick()
    expect(setStatus).toHaveBeenCalledWith('b1', 'abgesucht', { label: 'Trupp 2', id: 't2' })
    rows[0].actions![1].onClick()
    expect(setStatus).toHaveBeenLastCalledWith('b1', 'teilweise', { label: 'Trupp 2', id: 't2' })
    rows[1].onOpen!.onClick()
    expect(onOpen).toHaveBeenCalledWith('b2')
    // answered (anywhere): the question is no longer derived, and its row goes
    rerender(<SucheAskMeldungen asks={[]} actions={actions} onOpen={onOpen} />)
    expect(getMeldungen().filter((m) => m.kind === 'suche')).toEqual([])
  })

  it('the head chip counts the questions beside the missing', () => {
    const onOpenSuche = vi.fn()
    render(<TopBar incident={{ id: 'i1', title: 'Übung' } as unknown as Incident} recording={false} recStartedAt={null} journalOpen={false}
      onToggleJournal={() => {}} onUndo={() => {}} onRedo={() => {}} canUndo={false} canRedo={false}
      sucheMissing={7} sucheAsks={1} onOpenSuche={onOpenSuche} />)
    const chip = screen.getByRole('button', { name: `${C.title}: 7 vermisst · 1 Frage` })
    expect(chip.querySelector('.tb-suche-ask')?.textContent).toBe('1?')
    fireEvent.click(chip)
    expect(onOpenSuche).toHaveBeenCalled()
  })

  it('a question stands on the chip even with nobody missing', () => {
    render(<TopBar incident={{ id: 'i1', title: 'Übung' } as unknown as Incident} recording={false} recStartedAt={null} journalOpen={false}
      onToggleJournal={() => {}} onUndo={() => {}} onRedo={() => {}} canUndo={false} canRedo={false}
      sucheMissing={0} sucheAsks={2} onOpenSuche={() => {}} />)
    expect(screen.getByRole('button', { name: `${C.title}: 2 Fragen` }).className).toContain('warn')
  })
})

describe('N12 · no chip hides the weather by rule — only the measured ladder does', () => {
  it('no rule in the bar\'s stylesheet hides the weather because a chip is up', () => {
    const rules = [...css('10-journal.css').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, sel, body]) => sel.includes('.tb-weather-wrap') && /display:\s*none/.test(body))
      .map(([, sel]) => sel.trim())
    expect(rules).toEqual(['.topbar.fit-2 .tb-weather-wrap'])
  })
})

describe('the door stands beside Ebenen, on the phone\'s bar too (design «F», 26.09.2026)', () => {
  it('the phone bar keeps the Suche\'s tile, at its very end — after Ebenen on the Karte, after Einpassen on a plan', () => {
    const mobile = css('15-mobile.css')
    expect(mobile).toMatch(/\.vrail-nav > :not\(\.vrail-layers\):not\(\.vrail-views\):not\(\.vrail-fit\):not\(\.vrail-suche\) \{ display: none; \}/)
    const order = (cls: string) => Number(new RegExp(`\\.${cls} \\{ order: (\\d+); \\}`).exec(mobile)?.[1])
    expect(order('vrail-suche')).toBeGreaterThan(order('vrail-layers'))
    // no sheet, no peek line, nothing that hides the tool bar while the Suche is open
    expect(mobile).not.toMatch(/suche-sheet|suche-peek|suche-lift/)
    expect(css('13-incident.css')).not.toMatch(/ui-detent/)
  })
})

describe('the composer\'s Suche chip is read whole', () => {
  it('stands in its own wrapping row, not at the end of the scrolling band', () => {
    const doc = addPerson(emptySuche(), { name: 'Tim Muster' }, { at: '2026-09-25T14:10:00.000Z', newId: (p) => `${p}1`, floorName: String }).doc
    render(<JournalComposer onSubmit={vi.fn()} onClose={vi.fn()}
      suchePersonen={personenViews(doc)} sucheLink={null} onSucheLink={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Tim Mu' } })
    const chip = screen.getByRole('button', { name: /Tim Muster · vermisst → gefunden/ })
    expect(chip.closest('.jc-suche-row')).toBeTruthy()
    expect(chip.closest('.jc-phrases')).toBeNull()
    expect(css('18-audio.css')).toMatch(/\.jc-suche-row \{[^}]*flex-wrap: wrap/)
  })
})
