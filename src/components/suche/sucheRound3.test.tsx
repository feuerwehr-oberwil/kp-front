// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { appConfig } from '../../config/appConfig'
import {
  addPerson, bereichStatusOf, composerFoundLink, emptySuche, personGefunden, personKorrigiert, personView, personenViews,
  setBereichStatus, storeyBereichId, sucheChangeWords, sucheLinkLabel, sucheSurfaceFor, truppFloor,
  type SucheCx, type SucheStack,
} from '../../lib/suche'
import { fitHead, headCrowded, HEAD_FIT_STEPS } from '../../lib/useHeadFit'
import { useSucheActions } from '../../lib/useSucheActions'
import { floorLabel } from '../../lib/whiteboard'
import type { SucheDoc } from '../../types'
import { JournalComposer } from '../JournalComposer'
import { SuchePanel, type SucheTab } from './SuchePanel'

// The third walk-through on staging (25.09.2026): the Suche in a busy Einsatz, beside the Karte's
// Grundgerüst, on every width.

afterEach(cleanup)
const C = appConfig.copy.suche
const css = (file: string) => readFileSync(`${process.cwd()}/src/${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const stack: SucheStack = { key: 'k1', floors: [0, 1, 2, 3], floorName: floorLabel }
let n = 0
const cx = (at = '2026-09-25T19:10:00.000Z'): SucheCx => ({ at, newId: (p) => `${p}${++n}`, floorName: floorLabel, stack: 'k1' })
const klasse = () => addPerson(emptySuche(), { name: 'Klasse 4b', count: 8, floor: 2 }, cx())

describe('F6 · the composer never marks a whole group found in silence', () => {
  it('a group\'s chip NAMES the count — from the sentence, else one', () => {
    const k = klasse()
    const three = personGefunden(k.doc, k.person.id, { n: 3 }, cx()).doc
    const v = personenViews(three)[0]
    expect(v.missing).toBe(5)
    const said = composerFoundLink('Klasse 4b: 2 Kinder am Sammelplatz', v)
    expect(said).toMatchObject({ kind: 'gefunden', n: 2, of: 5 })
    expect(sucheLinkLabel(said)).toBe('Klasse 4b · 2 von 5 gefunden')
    expect(sucheChangeWords(said)).toBe('2 von Klasse 4b gefunden')
    // «4b» is the group's own name, not a count; nothing said → one
    expect(composerFoundLink('Klasse 4b', v)).toMatchObject({ n: 1, of: 5 })
    // more than are missing is not a count for this group
    expect(composerFoundLink('Klasse 4b 12 Personen', v)).toMatchObject({ n: 1 })
    // …and the find writes exactly that many
    const after = personGefunden(three, k.person.id, { n: said.kind === 'gefunden' ? said.n : undefined }, cx()).doc
    expect(personenViews(after)[0]).toMatchObject({ found: 5, missing: 3 })
  })

  it('one person stays «vermisst → gefunden»', () => {
    const a = addPerson(emptySuche(), { name: 'Tim Muster' }, cx())
    const l = composerFoundLink('Tim Muster 3. OG', personView(a.person))
    expect(l).toEqual({ kind: 'gefunden', personId: a.person.id, label: 'Tim Muster' })
  })

  it('the composer shows the count on the chip', () => {
    const k = klasse()
    render(<JournalComposer onSubmit={vi.fn()} onClose={vi.fn()} suchePersonen={personenViews(k.doc)} sucheLink={null} onSucheLink={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Klasse 4b 2' } })
    expect(screen.getByRole('button', { name: /Klasse 4b · 2 von 8 gefunden/ })).toBeTruthy()
  })
})

describe('F7 · «Fund melden» starts from where the Trupp is, and from one', () => {
  it('the storey of the Trupp\'s area, else its Ziel, else its marker — never «zuletzt gesehen»', () => {
    const a = setBereichStatus(klasse().doc, storeyBereichId(3, 'k1'), 'inArbeit', { label: 'Trupp 2', id: 't2' }, cx())
    expect(truppFloor(a.doc, 't2', stack, '1. OG', 0)).toBe(3)
    expect(truppFloor(emptySuche(), 't2', stack, '1. OG Aula', 0)).toBe(1)
    expect(truppFloor(emptySuche(), 't2', stack, undefined, 0)).toBe(0)
    expect(truppFloor(emptySuche(), 't2', stack)).toBeUndefined()
  })

  it('the form takes the Trupp\'s storey and counts from one', () => {
    const k = klasse()
    let last: SucheDoc = k.doc
    function Harness() {
      const [doc, setDoc] = useState(k.doc)
      const [tab, setTab] = useState<SucheTab>('personen')
      const actions = useSucheActions({ suche: doc, setRaw: (d) => { setDoc(d); last = d }, canEdit: true, log: () => {}, emit: () => {}, floorName: floorLabel, stack: 'k1' })
      return <SuchePanel doc={doc} floors={stack.floors} floorName={floorLabel} stackKey="k1" canEdit actions={actions}
        trupps={[{ id: 't2', label: 'Trupp 2', short: 'T2' }]} placed={[]} tab={tab} onTab={setTab} uebergabe={[]}
        focus={{ fund: { truppId: 't2', floor: 3 }, nonce: 1 }} onExit={() => {}} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /Klasse 4b/ }))
    expect(within(screen.getByRole('group', { name: C.wieViele })).getByText('1')).toBeTruthy()
    expect(within(screen.getByRole('group', { name: C.wo })).getByRole('button', { name: '3. OG' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: C.submitGefunden }))
    expect(personenViews(last)[0]).toMatchObject({ found: 1, missing: 7, foundFloor: 3 })
  })
})

describe('the found place can be corrected', () => {
  it('«Korrigieren» moves the latest find, its row says so, and the «Fund» moves with it', () => {
    const a = addPerson(emptySuche(), { name: 'Tim Muster', floor: 2 }, cx())
    const g = personGefunden(a.doc, a.person.id, { floor: 3, wo: 'Zimmer 304', trupp: 'Trupp 1' }, cx())
    const b3 = { id: storeyBereichId(3, 'k1'), floor: 3, stack: 'k1', createdAt: '', log: [] }
    const b2 = { id: storeyBereichId(2, 'k1'), floor: 2, stack: 'k1', createdAt: '', log: [] }
    const doc0 = { ...g.doc, bereiche: [b3, b2] }
    expect(bereichStatusOf(b3, doc0).fund).toBe(true)
    const k = personKorrigiert(doc0, a.person.id, { name: 'Tim Muster', floor: 2, foundFloor: 2, foundWo: 'Zimmer 204' }, cx())
    expect(k.rows[0].text).toBe('Korrigiert: Tim Muster · zuletzt 2. OG · gefunden 3. OG Zimmer 304 → Tim Muster · zuletzt 2. OG · gefunden 2. OG Zimmer 204')
    expect(personView(k.doc.personen[0])).toMatchObject({ foundFloor: 2, foundWo: 'Zimmer 204', status: 'gefunden' })
    expect(bereichStatusOf(b3, k.doc).fund).toBe(false)
    expect(bereichStatusOf(b2, k.doc).fund).toBe(true)
  })

  it('the form offers the found place once somebody was found', () => {
    const a = addPerson(emptySuche(), { name: 'Tim Muster', floor: 2 }, cx())
    const g = personGefunden(a.doc, a.person.id, { floor: 3, wo: 'Zimmer 304' }, cx())
    let last: SucheDoc = g.doc
    function Harness() {
      const [doc, setDoc] = useState(g.doc)
      const [tab, setTab] = useState<SucheTab>('personen')
      const actions = useSucheActions({ suche: doc, setRaw: (d) => { setDoc(d); last = d }, canEdit: true, log: () => {}, emit: () => {}, floorName: floorLabel, stack: 'k1' })
      return <SuchePanel doc={doc} floors={stack.floors} floorName={floorLabel} stackKey="k1" canEdit actions={actions}
        trupps={[]} placed={[]} tab={tab} onTab={setTab} uebergabe={[]} focus={{ personId: a.person.id, nonce: 1 }} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: C.korrigierenBtn }))
    fireEvent.change(screen.getByLabelText(`${C.korrigierenGefunden} – ${C.woGenau}`), { target: { value: 'Zimmer 305' } })
    fireEvent.click(screen.getByRole('button', { name: C.submitKorrigieren }))
    expect(personView(last.personen[0]).foundWo).toBe('Zimmer 305')
  })
})

describe('F12 · the Suche opens where you are', () => {
  it('on the Karte or a plan it stays; elsewhere the Gebäude, or the Karte without one', () => {
    expect(sucheSurfaceFor('map', true)).toBeNull()
    expect(sucheSurfaceFor('plans', true)).toBeNull()
    expect(sucheSurfaceFor('atemschutz', true)).toBe('gebaeude')
    expect(sucheSurfaceFor('rapport', false)).toBe('karte')
  })
})

describe('F9 · N13 · N25 · nothing shares a corner with the Suche', () => {
  it('the storey badge has its own line, away from the tile\'s corner and «Geschoss entfernen»', () => {
    const rule = /\.wb-floor-suche \{([^}]*)\}/.exec(css('styles/09-whiteboard.css'))![1]
    expect(rule).toMatch(/position: absolute/)
    expect(rule).toMatch(/top: 40px/)
    // …and it is rendered beside the label, not inside its row
    const tsx = readFileSync(`${process.cwd()}/src/components/Whiteboard.tsx`, 'utf8')
    const label = tsx.slice(tsx.indexOf('<div className="wb-floor-label">'), tsx.indexOf('</div>', tsx.indexOf('<div className="wb-floor-label">')))
    expect(label).not.toContain('wb-floor-suche')
  })

  it('the Meldeleiste and the Grundgerüst card stop at the dock\'s edge; the phone strip stands on the peek line', () => {
    const suche = css('components/suche/Suche.module.css')
    expect(suche).toMatch(/:global\(:root:has\(\[data-suche-dock\]\)\) :global\(\.ml\) \{\s*right: calc\(var\(--vrail-w, 60px\) \+ 26px \+ var\(--suche-dock-w, 340px\) \+ 12px\)/)
    expect(suche).toMatch(/:global\(\.app:has\(\[data-suche-dock\]\)\) :global\(\.lgg:not\(\.lgg-phone\)\) \{[^}]*right: calc\(var\(--vrail-w, 60px\) \+ 26px \+ var\(--suche-dock-w, 340px\) \+ 12px\)/)
    expect(css('styles/15-mobile.css')).toMatch(/\.lgg\.lgg-phone \{[^}]*bottom: calc\(var\(--rail-h\) \* 2 \+ 28px \+ var\(--suche-lift, 0px\)/)
  })
})

describe('N12 · N23 · the head collapses by priority, and the Einsatz pill never gives', () => {
  it('steps until it fits, keeping every lower step; nothing when it fits', () => {
    const bar = document.createElement('div')
    let room = 3
    expect(fitHead(bar, () => room-- > 0)).toBe(3)
    expect([...bar.classList]).toEqual(['fit-1', 'fit-2', 'fit-3'])
    expect(fitHead(bar, () => false)).toBe(0)
    expect(bar.classList.length).toBe(0)
    expect(fitHead(bar, () => true)).toBe(HEAD_FIT_STEPS.length)
  })

  it('the ladder\'s order IS the priority: weather, Einsatzdauer, vermisst, …, the pill\'s title last but the icons', () => {
    const j = css('styles/10-journal.css')
    const first = (sel: string) => { const m = new RegExp(`\\.topbar\\.fit-(\\d+)[^{]*${sel}`).exec(j); return m ? Number(m[1]) : NaN }
    const order = [first('tb-weather-temp'), first('tb-weather-wrap'), first('tb-einsatzuhr'), first('tb-suche-full'), first('tb-az-name'), first('ip-switch-title')]
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every(Number.isFinite)).toBe(true)
    // the closed/lock chip (#235) gives its words with the title, never before the weather
    expect(first('tb-mode')).toBe(first('ip-switch-title'))
  })

  it('a squeezed pill counts as crowded: the ÜBUNG marker truncated, or the title below its floor', () => {
    document.body.innerHTML = '<div class="topbar"><button class="ip-switch-btn"><span class="ip-badge ip-badge-exercise">ÜBUNG</span><span class="ip-switch-title">Test</span></button></div>'
    const bar = document.querySelector<HTMLElement>('.topbar')!
    const badge = document.querySelector<HTMLElement>('.ip-badge')!
    const size = (el: HTMLElement, scroll: number, client: number) => {
      Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scroll })
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: client })
      Object.defineProperty(el, 'offsetParent', { configurable: true, value: document.body })
    }
    size(bar, 300, 300)
    size(badge, 52, 52)
    expect(headCrowded(bar)).toBe(false)
    size(badge, 52, 14) // «Ü…»
    expect(headCrowded(bar)).toBe(true)
  })
})
