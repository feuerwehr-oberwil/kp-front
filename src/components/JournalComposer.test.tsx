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

  // ⚠️ The ring stays, and is the ONE place «what is this line?» is asked — but in this mode it
  // offers no «Neue Pendenz» and no urgency: this entry already belongs to something, and a
  // switch on one Meldung that re-ranks the whole item is not what it looks like.
  it('keeps the ○ switch, offering re-target and unlink but no new item', async () => {
    const onClearNote = vi.fn()
    const { onLinkPendenz } = setup({ noteOn, onClearNote })
    fireEvent.click(ring())
    expect(await screen.findByRole('menuitem', { name: /Verknüpfung lösen/ })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /^Neue Pendenz$/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Dringende Pendenz/ })).toBeNull()

    fireEvent.click(screen.getByRole('menuitem', { name: /Patient an Sanität/ }))
    expect(onLinkPendenz).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }))
  })

  it('…and lets go of the link entirely', async () => {
    const onClearNote = vi.fn()
    setup({ noteOn, onClearNote })
    fireEvent.click(ring())
    fireEvent.click(await screen.findByRole('menuitem', { name: /Verknüpfung lösen/ }))
    expect(onClearNote).toHaveBeenCalled()
  })
})

describe('JournalComposer · the half-written sentence', () => {
  // ⚠️ This overlay closes on a backdrop press, and on a tablet the sheet is mostly backdrop.
  // Only the ✕ may throw the text away.
  it('survives a close that was not the ✕, and the ✕ discards it', () => {
    setup()
    type('Halb geschriebener Satz')
    cleanup()
    setup()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Halb geschriebener Satz')

    fireEvent.click(screen.getByRole('button', { name: /schliessen|close/i }))
    cleanup()
    setup()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
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
