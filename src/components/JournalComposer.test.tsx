// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { JournalComposer, type JournalDraft } from './JournalComposer'
import { clearAllDrafts } from '../lib/draftKeep'

afterEach(() => { cleanup(); clearAllDrafts() })

const OPEN = [
  { id: 'p1', text: 'Absperrmaterial Kreuzung, Werkhof Oberwil', urgent: true },
  { id: 'p2', text: 'Patient an Sanität übergeben' },
]

function setup(over: Partial<React.ComponentProps<typeof JournalComposer>> = {}) {
  const onSubmit = vi.fn<(d: JournalDraft) => void>()
  const onLinkPendenz = vi.fn()
  render(<JournalComposer
    onSubmit={onSubmit} onClose={vi.fn()} openPendenzen={OPEN} onLinkPendenz={onLinkPendenz} {...over} />)
  return { onSubmit, onLinkPendenz }
}

const type = (value: string) => fireEvent.change(screen.getByRole('textbox'), { target: { value } })
const ring = () => document.querySelector('.jc-open') as HTMLButtonElement
const send = () => fireEvent.click(screen.getByRole('button', { name: /Erfassen|Eintragen/ }))
const menuRow = async (name: RegExp) => {
  fireEvent.click(ring())
  return await screen.findByRole('menuitem', { name })
}

describe('JournalComposer · the ○ switch', () => {
  it('marks the entry as an open Pendenz', async () => {
    const { onSubmit } = setup()
    type('Werkhof stellt Absperrmaterial')
    fireEvent.click(await menuRow(/^Neue Pendenz$/))
    await waitFor(() => expect(ring().dataset.state).toBe('1'))
    send()
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ pendenz: { urgent: false } })
  })

  it('…or as a dringende one', async () => {
    const { onSubmit } = setup()
    type('Absperrung sofort')
    fireEvent.click(await menuRow(/Dringende Pendenz/))
    await waitFor(() => expect(ring().dataset.state).toBe('2'))
    send()
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ pendenz: { urgent: true } })
  })

  // ⚠️ An ordinary entry must stay ordinary. The switch is opt-in, and a draft that carried
  // `pendenz` without anyone choosing it would put a line nobody raised onto the Rapport.
  it('leaves an untouched entry with no lifecycle at all', () => {
    const { onSubmit } = setup()
    type('Lüfter im EG gestellt')
    send()
    const d = onSubmit.mock.calls[0][0]
    expect(d.pendenz).toBeUndefined()
    expect(d.noteFor).toBeUndefined()
  })

  it('hangs the entry on an open item instead', async () => {
    const { onLinkPendenz } = setup()
    type('Fahrzeug unterwegs')
    fireEvent.click(await menuRow(/Absperrmaterial Kreuzung/))
    expect(onLinkPendenz).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))
  })
})

// The Verlauf is a Funkprotokoll — «wer sagt was zu wem» is the shape of nearly every line in it,
// and today everyone writes that relation differently («meldet», «an», «:», nothing).
describe('JournalComposer · the arrow', () => {
  const VOCAB = [
    { name: 'EL', kind: 'person' as const, word: true },
    { name: 'Sanität', kind: 'partner' as const },
  ]
  const field = () => screen.getByRole('textbox') as HTMLTextAreaElement
  const arrow = () => screen.queryByRole('button', { name: /Pfeil einsetzen – wer an wen/ })
  const back = () => screen.queryByRole('button', { name: /Pfeil einsetzen – wer von wem/ })

  it('is offered once the sentence has named somebody, and writes the character', () => {
    setup({ vocab: VOCAB })
    type('EL')
    fireEvent.click(arrow()!)
    expect(field().value).toBe('EL → ')
  })

  // ⚠️ A Funkprotokoll has both directions, and rewriting «Sanität meldet an EL» as an outgoing
  // order means reversing the sentence that was just heard.
  it('offers the incoming direction too', () => {
    setup({ vocab: VOCAB })
    type('EL')
    fireEvent.click(back()!)
    expect(field().value).toBe('EL ← ')
  })

  it('is not offered before a name, nor twice in a row', () => {
    setup({ vocab: VOCAB })
    type('Rückmeldung')
    expect(arrow()).toBeNull()
    type('EL → ')
    expect(arrow()).toBeNull()
    type('EL ← ')
    expect(arrow()).toBeNull()
  })

  // ⚠️ The space after the name still counts — nobody writes a name and then stops mid-air.
  it('stays through the space after the name', () => {
    setup({ vocab: VOCAB })
    type('EL ')
    expect(arrow()).toBeTruthy()
  })

  // …and goes again once the sentence has moved on: the arrow means «and now the other side», so
  // a chip that never leaves is one more thing competing with the Textbausteine for the row.
  it('goes away once other words follow the name', () => {
    setup({ vocab: VOCAB })
    type('EL → San')
    expect(arrow()).toBeNull()
    type('EL → Sanität: Patient stabil')
    expect(arrow()).toBeNull()
    // …and comes back for the term that ends the sentence
    type('EL → Sanität')
    expect(arrow()).toBeTruthy()
  })
})

// ⚠️ NOT a return of the static chip strip that was dropped on 02.07.: these exist only while the
// field is empty, and the row they sit in was standing empty anyway.
describe('JournalComposer · what an empty field offers', () => {
  const VOCAB = [{ name: 'EL', kind: 'person' as const, word: true }]
  const TL = [{ id: 'e1', t: '22:00', at: '2026-08-17T20:00:00.000Z', icon: 'type', text: 'Polizei aufgeboten', kind: 'journal' as const, surface: 'map' as const }]

  it('leads with the post and adds what this Einsatz keeps writing', () => {
    setup({ vocab: VOCAB, timeline: TL })
    const chips = [...document.querySelectorAll('.jc-phrases button')].map((b) => b.textContent)
    expect(chips[0]).toBe('EL →')
    expect(chips).toContain('Polizei aufgeboten')
  })

  // ⚠️ The row STAYS after its own first tap — «EL →» is exactly the moment the second chip becomes
  // useful, and a row that empties itself offers help once and then takes it away.
  it('writes the opener and keeps the row, so the next chip appends to it', () => {
    setup({ vocab: VOCAB, timeline: TL })
    const field = () => screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.click(screen.getByRole('button', { name: 'EL →' }))
    expect(field().value).toBe('EL → ')
    expect(document.querySelector('.jc-phrase-starter')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Polizei aufgeboten' }))
    expect(field().value).toBe('EL → Polizei aufgeboten')
  })

  // …and the first keystroke is what hands the row over to the ordinary suggestions
  it('gives way as soon as somebody types, and comes back on an emptied field', () => {
    setup({ vocab: VOCAB, timeline: TL })
    type('Lüfter')
    expect(document.querySelector('.jc-phrase-starter')).toBeNull()
    type('')
    expect(document.querySelector('.jc-phrase-starter')).toBeTruthy()
  })

  // a Meldung is an ordinary entry with a link — same row, same chips
  it('offers them while writing a Meldung too', () => {
    setup({ vocab: VOCAB, timeline: TL, noteOn: { id: 'p1', text: 'Absperrmaterial' } })
    expect(document.querySelector('.jc-phrase-starter')).toBeTruthy()
  })
})

// ⚠️ There is no «Eintrag · Erinnerung» mode any more: a due time is a property of ANY entry, so
// «Auftrag erteilt» and «um 22:10 nachfassen» are one row rather than two rows about one thing.
describe('JournalComposer · the clock', () => {
  const clock = () => document.querySelector('.jc-due-btn') as HTMLButtonElement
  const dueRow = async (name: RegExp) => {
    fireEvent.click(clock())
    return await screen.findByRole('menuitem', { name })
  }

  it('gives an ordinary entry a due time — with its Art and its media intact', async () => {
    const { onSubmit } = setup()
    type('Lüfter im Treppenhaus prüfen')
    fireEvent.click(screen.getByRole('button', { name: 'Auftrag' }))
    fireEvent.click(await dueRow(/in 10 min/))
    send()
    const d = onSubmit.mock.calls[0][0]
    expect(d.entryType).toBe('auftrag')
    expect(Date.parse(d.dueAt!)).toBeGreaterThan(Date.now())
  })

  // ⚠️ A Fälligkeit on a line nobody can tick off would fire a banner with no way to answer it,
  // so the clock opens the ring — and closing the ring takes the clock with it.
  it('opens the ring with it, and drops the time when the ring is closed again', async () => {
    const { onSubmit } = setup()
    type('Lüfter prüfen')
    fireEvent.click(await dueRow(/in 30 min/))
    await waitFor(() => expect(ring().dataset.state).toBe('1'))

    fireEvent.click(ring())
    fireEvent.click(await screen.findByRole('menuitem', { name: /Nicht offen halten/ }))
    send()
    const d = onSubmit.mock.calls[0][0]
    expect(d.dueAt).toBeUndefined()
    expect(d.pendenz).toBeUndefined()
  })

  it('leaves an untouched entry without one', () => {
    const { onSubmit } = setup()
    type('Lüfter im EG gestellt')
    send()
    expect(onSubmit.mock.calls[0][0].dueAt).toBeUndefined()
  })

  // ⚠️ It mounted and was invisible once: a dialog without `ui-dialog` is positioned by nothing
  // and stacks below the sheet that opened it (see 08-toasts.css). «Uhrzeit» then did nothing at
  // all, and the DOM said everything was fine — so the class contract is what gets asserted.
  it('«Uhrzeit …» opens a dialog that is actually positioned and above the sheet', async () => {
    setup()
    type('Lüfter prüfen')
    fireEvent.click(await dueRow(/Uhrzeit/))
    const card = await screen.findByRole('dialog', { name: /Uhrzeit/ })
    // ⚠️ the positioning class is the whole point of the assertion — the card was in the DOM
    // before this fix too, sitting unstyled at the top of <body> under the sheet
    expect(card.className).toContain('ui-dialog')
    expect(card.querySelector('.jc-time')).toBeTruthy() // …and it carries the ± stepper
  })

  // ⚠️ The day is picked, not inferred. «HH:MM, and if that is already past, tomorrow» was right
  // most of the time and silent the rest — on the one surface where a Wiedervorlage set for the
  // wrong day is a check nobody makes.
  it('carries a day, refuses a moment that has passed, and saves the one that was picked', async () => {
    // ⚠️ The clock is PINNED. The dialog opens at now+5 min, so a run at 23:58 opens it on
    // tomorrow and «eine Stunde zurück» lands in the future — the test would pass all day and
    // fail on the night shift, which is when this app is used.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(2026, 7, 17, 14, 0, 0))
    const { onSubmit } = setup()
    type('Lüfter prüfen')
    fireEvent.click(await dueRow(/Uhrzeit/))
    const card = await screen.findByRole('dialog', { name: /Uhrzeit/ })
    const ok = () => screen.getByRole('button', { name: /Übernehmen/ }) as HTMLButtonElement

    // ⚠️ NOT «Heute»: the default is now+5 min, so a test running at 23:58 opens the dialog on
    // tomorrow — the assertion has to be about the day row existing, not about which day it is.
    expect(card.querySelector('.jc-exact-day')).toBeTruthy()
    expect(ok().disabled).toBe(false)

    // an hour back is today, an hour ago — the dialog says so and refuses to save it.
    // (the ± steppers are hold-to-repeat, so they act on pointerdown, not on click)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Stunde −' }), { pointerId: 1, button: 0 })
    expect(card.querySelector('.jc-exact-preview.is-past')).toBeTruthy()
    expect(ok().disabled).toBe(true)

    // …and a day forward makes the same clock time a real Wiedervorlage again
    fireEvent.click(screen.getByRole('button', { name: 'Einen Tag vor' }))
    expect(ok().disabled).toBe(false)
    fireEvent.click(ok())
    send()
    const due = Date.parse(onSubmit.mock.calls[0][0].dueAt!)
    expect(due).toBeGreaterThan(Date.now())
    expect(due).toBeLessThan(Date.now() + 48 * 3600_000)
    vi.useRealTimers()
  })
})

describe('JournalComposer · writing a Meldung', () => {
  const noteOn = { id: 'p1', text: 'Absperrmaterial Kreuzung, Werkhof Oberwil' }

  it('names what it is and what it is about, and submits as a note', () => {
    const { onSubmit } = setup({ noteOn })
    expect(screen.getByText('Meldung')).toBeTruthy()
    expect(screen.getByText(noteOn.text)).toBeTruthy()
    type('Werkhof meldet: Fahrzeug unterwegs')
    send()
    const d = onSubmit.mock.calls[0][0]
    expect(d.noteFor).toEqual({ id: 'p1' })
    expect(d.pendenz).toBeUndefined()
  })

  // ⚠️ The ring stays, and is the ONE place «what is this line?» is asked — with the SAME rows it
  // offers anywhere else. Realising halfway through a sentence that it is its own thing after all
  // is normal, and it used to take two steps.
  it('keeps the ○ switch, and asks the same question it asks everywhere', async () => {
    const onClearNote = vi.fn()
    const { onLinkPendenz } = setup({ noteOn, onClearNote })
    fireEvent.click(ring())
    expect(await screen.findByRole('menuitem', { name: /Verknüpfung lösen/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /^Neue Pendenz$/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Dringende Pendenz/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', { name: /Patient an Sanität/ }))
    expect(onLinkPendenz).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }))
  })

  // ⚠️ …and «Neue Pendenz» UNLINKS on the way. `submit` reads `noteFor` before `pendenz`, so a
  // draft still carrying the link would file the line as a Meldung and drop the choice silently.
  it('turning a Meldung into its own item lets the link go first', async () => {
    const onClearNote = vi.fn()
    setup({ noteOn, onClearNote })
    fireEvent.click(ring())
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Neue Pendenz$/ }))
    expect(onClearNote).toHaveBeenCalled()
  })

  it('…and lets go of the link entirely', async () => {
    const onClearNote = vi.fn()
    setup({ noteOn, onClearNote })
    fireEvent.click(ring())
    fireEvent.click(await screen.findByRole('menuitem', { name: /Verknüpfung lösen/ }))
    expect(onClearNote).toHaveBeenCalled()
  })
})

describe('JournalComposer · the half-written draft', () => {
  const closeX = () => screen.getByRole('button', { name: /schliessen|close/i })

  // ⚠️ This overlay closes on a backdrop press, and on a tablet the sheet is mostly backdrop.
  // ⚠️ …and the WHOLE draft survives, not only the sentence. Keeping `text` alone meant the ring,
  // the Art and the attachments were dropped with nothing said, and the sheet came back looking
  // like an ordinary entry.
  it('hands back the sentence, the Art and the ring after any close', async () => {
    setup()
    type('Halb geschriebener Satz')
    fireEvent.click(screen.getByRole('button', { name: 'Auftrag' }))
    fireEvent.click(await menuRow(/Dringende Pendenz/))
    await waitFor(() => expect(ring().dataset.state).toBe('2'))
    cleanup()

    const { onSubmit } = setup()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Halb geschriebener Satz')
    expect(ring().dataset.state).toBe('2')
    send()
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ entryType: 'auftrag', pendenz: { urgent: true } })
  })

  // ⚠️ The ✕ CLOSES. It used to discard the draft — the one ✕ in the app that destroyed what had
  // been typed, with no confirm and no undo, wearing the same glyph as every other close.
  it('the ✕ closes without throwing the draft away', () => {
    setup()
    type('Halb geschriebener Satz')
    fireEvent.click(closeX())
    cleanup()
    setup()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Halb geschriebener Satz')
  })

  // …and filing the row is what empties it, so the next entry starts on a blank sheet
  it('a sent entry leaves nothing behind', () => {
    setup()
    type('Lüfter im EG gestellt')
    send()
    cleanup()
    setup()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    expect(ring().dataset.state).toBe('0')
  })
})

// ── the sheet gives things up in a decided order ──────────────────────────────────────────
// jsdom has no layout, so the two numbers the ladder reads are stood in for. What is tested here
// is the WIRING — that the card's own overflow is what flips the class; the rule itself is
// lib/composerFit.
describe('JournalComposer · what gives way when the room runs out', () => {
  const layout = (scrollH: number, clientH: number) => {
    for (const [prop, v] of [['scrollHeight', scrollH], ['clientHeight', clientH]] as const) {
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => v })
    }
  }
  afterEach(() => {
    for (const prop of ['scrollHeight', 'clientHeight']) {
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value: 0 })
    }
  })

  it('collapses Art and media into one symbol row rather than scrolling the sheet', async () => {
    layout(386, 340) // the full sheet in what a keyboard leaves of a small screen
    setup()
    await waitFor(() => expect(document.querySelector('.journal-composer')?.className).toContain('is-compact'))
    // …and the words are still what the row is CALLED, whatever it now shows
    expect(screen.getByRole('button', { name: 'Sofortmassnahme' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Foto' })).toBeTruthy()
  })

  it('leaves the sheet alone while it fits', async () => {
    layout(386, 420)
    setup()
    await waitFor(() => expect(document.querySelector('.jc-controls')).toBeTruthy())
    expect(document.querySelector('.journal-composer')?.className).not.toContain('is-compact')
  })
})

describe('JournalComposer · «Wer» is read off the sentence', () => {
  it('takes the first vocabulary name, with no field asking for one', () => {
    const { onSubmit } = setup({ vocab: [{ name: 'Werkhof Oberwil', kind: 'partner' }] })
    type('Werkhof Oberwil stellt Absperrmaterial')
    send()
    expect(onSubmit.mock.calls[0][0].assignee).toBe('Werkhof Oberwil')
  })
})
