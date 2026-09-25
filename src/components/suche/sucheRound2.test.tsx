// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'
import { getMeldungen } from '../../lib/useMeldung'
import { addPerson, emptySuche, personenViews, sucheAppClass, type BereichView } from '../../lib/suche'
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
  id: 'sbg:k1:0', floor: 0, storey: true, status: 'inArbeit', trupp: 'Trupp 2', truppId: 't2', statusAt: '', fund: false,
  short: C.ganzesGeschoss, full: 'EG', rows: [], ...over,
})

describe('N13 · an open «abgesucht?» is where the operator already looks', () => {
  it('one Meldeleiste row per question, answered in place, gone once answered', () => {
    const setStatus = vi.fn()
    const actions = { setStatus } as unknown as SucheActions
    const onOpen = vi.fn()
    const { rerender } = render(<SucheAskMeldungen asks={[ask(), ask({ id: 'b2', full: '1. OG Aula', trupp: 'Trupp 4', truppId: 't4' })]} actions={actions} onOpen={onOpen} />)
    const rows = getMeldungen().filter((m) => m.kind === 'suche')
    expect(rows.map((m) => m.title)).toEqual(['Trupp 2 raus – EG abgesucht?', 'Trupp 4 raus – 1. OG Aula abgesucht?'])
    // no ✕: the answer is the only way to dismiss it
    expect(rows[0].dismiss).toBeUndefined()
    rows[0].actions![0].onClick()
    expect(setStatus).toHaveBeenCalledWith('sbg:k1:0', 'abgesucht', { label: 'Trupp 2', id: 't2' })
    rows[0].actions![1].onClick()
    expect(setStatus).toHaveBeenLastCalledWith('sbg:k1:0', 'teilweise', { label: 'Trupp 2', id: 't2' })
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

describe('the phone sheet and what stands around it', () => {
  it('at peek the tool bar stays; at half and full it steps aside; a tablet has neither', () => {
    expect(sucheAppClass(true, true, 'peek')).toBe(' suche-peek')
    expect(sucheAppClass(true, true, 'half')).toBe(' suche-sheet')
    expect(sucheAppClass(true, true, 'full')).toBe(' suche-sheet')
    expect(sucheAppClass(true, false, 'half')).toBe('')
    expect(sucheAppClass(false, true, 'half')).toBe('')
    // only half/full hide the tools
    const mobile = css('15-mobile.css')
    expect(mobile).toMatch(/\.app\.suche-sheet :is\(\.tool-rail, \.wb-tools/)
    expect(mobile).not.toMatch(/\.app\.suche-peek[^{]*\{\s*display:\s*none/)
  })

  it('N10 · the sheet stands over every floating map chip (wind, compass) and under the top bar', () => {
    const tokens = css('01-tokens.css')
    const z = (name: string) => Number(new RegExp(`--z-${name}:\\s*(\\d+)`).exec(tokens)?.[1])
    expect(z('detent')).toBeGreaterThan(z('map-util-raised'))
    expect(z('detent')).toBeLessThan(z('topbar'))
    expect(css('13-incident.css')).toMatch(/\.ui-detent \{[^}]*z-index: var\(--z-detent\)/)
  })
})

describe('the composer\'s Suche chip is read whole', () => {
  it('stands in its own wrapping row, not at the end of the scrolling band', () => {
    const doc = addPerson(emptySuche(), { name: 'Tim Muster' }, { at: '2026-09-25T14:10:00.000Z', newId: (p) => `${p}1`, floorName: String, stack: 'k1' }).doc
    render(<JournalComposer onSubmit={vi.fn()} onClose={vi.fn()}
      suchePersonen={personenViews(doc)} sucheLink={null} onSucheLink={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Tim Mu' } })
    const chip = screen.getByRole('button', { name: /Tim Muster · vermisst → gefunden/ })
    expect(chip.closest('.jc-suche-row')).toBeTruthy()
    expect(chip.closest('.jc-phrases')).toBeNull()
    expect(css('18-audio.css')).toMatch(/\.jc-suche-row \{[^}]*flex-wrap: wrap/)
  })
})
