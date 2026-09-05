// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { FeedbackPrompt } from './FeedbackPrompt'
import { FeedbackSheet } from './FeedbackSheet'
import { appConfig } from '../../config/appConfig'
import { readTrouble, type TroubleEvent } from '../../lib/trouble'
import { submitReport } from '../../lib/feedbackSubmit'
import { MAX_MESSAGE, readDraft, writeDraft } from '../../lib/feedbackDraft'

// The guarantees worth pinning, because breaking any of them turns a helpful prompt into the
// thing the 3am tenet forbids:
//   1. Dismissing starts the cooldown — so this can never become a nag.
//   2. Nothing is transmitted without a deliberate tap on a button that says so.
//   3. When sending fails, the operator is not stranded: copy/mail still work and what they
//      typed is still on screen.

vi.mock('../../lib/feedbackSubmit', () => ({ submitReport: vi.fn(), PHOTO_LIMIT: 2 }))
const mockSubmit = vi.mocked(submitReport)

// The real downscaler needs a canvas jsdom does not have. What these tests are about is where
// the result goes; whether the arithmetic that produced it is right is lib/imagePrep.test.ts.
const prepared = new Blob([new Uint8Array(1234)], { type: 'image/jpeg' })
vi.mock('../../lib/imagePrep', () => ({ prepareFeedbackPhoto: vi.fn(async () => prepared) }))

const cp = appConfig.copy.feedback
const trouble: TroubleEvent = { kind: 'crashLoop', at: 1_800_000_000_000 }

// jsdom's Window defines `localStorage` as a getter-only accessor (spec-accurate, same as a
// real browser), so a plain assignment throws — must replace the property descriptor instead.
function installLocalStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
      removeItem: (k: string) => { store.delete(k) },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage,
  })
}

beforeEach(() => {
  installLocalStorage()
  mockSubmit.mockReset()
  mockSubmit.mockResolvedValue({ ok: true, sent: { tags: { channel: 'report' } } })
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:photo', configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true })
})
afterEach(cleanup)

/** Attach one photo the way the operator does: pick a file. */
async function attachPhoto() {
  const input = document.querySelector('.fb-photo-add input') as HTMLInputElement
  const before = document.querySelectorAll('.fb-photo').length
  Object.defineProperty(input, 'files', {
    value: [new File([new Uint8Array(9)], 'lage.jpg', { type: 'image/jpeg' })],
    configurable: true,
  })
  fireEvent.change(input)
  await waitFor(() => expect(document.querySelectorAll('.fb-photo').length).toBe(before + 1))
}

describe('FeedbackPrompt', () => {
  it('asks about the specific thing that happened, not a generic "any feedback?"', () => {
    render(<FeedbackPrompt trouble={trouble} onOpen={() => {}} onDismiss={() => {}} />)
    expect(screen.getByText(cp.promptFor.crashLoop)).toBeTruthy()
  })

  it('starts the cooldown when dismissed, so the same crash cannot come back next week', () => {
    const onDismiss = vi.fn()
    render(<FeedbackPrompt trouble={trouble} onOpen={() => {}} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByText(cp.promptDismiss))
    expect(onDismiss).toHaveBeenCalled()
    expect(readTrouble().askedAt).toBeTypeOf('number')
  })
})

describe('FeedbackSheet', () => {
  it('shows the operator exactly what would be sent', () => {
    render(<FeedbackSheet trouble={trouble} onClose={() => {}} />)
    // the technical block is on screen, verbatim — the privacy promise is only credible if
    // it can be read
    const block = document.querySelector('.fb-tech-block')?.textContent ?? ''
    expect(block).toContain(appConfig.copy.feedback.tech.version)
    expect(block).toContain(appConfig.copy.feedback.tech.device)
    expect(screen.getByText(cp.techNote)).toBeTruthy()
  })

  it('carries the trouble question through from the prompt', () => {
    render(<FeedbackSheet trouble={trouble} onClose={() => {}} />)
    expect(screen.getByText(cp.promptFor.crashLoop)).toBeTruthy()
  })

  it('sends nothing on its own — every exit needs a deliberate tap', () => {
    render(<FeedbackSheet onClose={() => {}} />)
    // The invariant is NOT "there is no send button" any more; it is that opening, typing
    // and reading never transmit. Four exits (close / copy / mail / send), all of them a tap —
    // split across two rows now, so count both.
    const labels = [...document.querySelectorAll('.fb-alt button, .fb-actions button')]
      .map((b) => b.textContent?.trim())
    expect(labels).toHaveLength(4)
    expect(labels.join(' ')).toContain(cp.copy)
    expect(labels.join(' ')).toContain(cp.mail)
    expect(labels.join(' ')).toContain(cp.send)
    expect(submitReport).not.toHaveBeenCalled()
  })

  it('shows what would be sent without needing a tap to reveal it', () => {
    render(<FeedbackSheet trouble={trouble} onClose={() => {}} />)
    // Open by default: behind a summary the claim is unread at the moment it matters.
    expect(document.querySelector('details.fb-tech')?.hasAttribute('open')).toBe(true)
  })

  it('stops typing at the server cap rather than letting the POST 422', () => {
    render(<FeedbackSheet onClose={() => {}} />)
    const input = document.querySelector('.fb-input') as HTMLTextAreaElement
    // Without this the report is rejected and the operator is told they are offline.
    expect(input.maxLength).toBe(MAX_MESSAGE)
  })

  it('will not send an empty report that carries no trouble either', () => {
    render(<FeedbackSheet onClose={() => {}} />)
    const send = screen.getByText(cp.send).closest('button') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    // ...but a trouble makes even a wordless "yes, this happened to me" worth a row.
    cleanup()
    render(<FeedbackSheet trouble={trouble} onClose={() => {}} />)
    expect((screen.getByText(cp.send).closest('button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not send while the operator is typing', () => {
    render(<FeedbackSheet onClose={() => {}} />)
    fireEvent.change(document.querySelector('.fb-input')!, { target: { value: 'Bildschirm weg' } })
    expect(submitReport).not.toHaveBeenCalled()
  })

  it('starts the cooldown when closed without sending', () => {
    const onClose = vi.fn()
    render(<FeedbackSheet trouble={trouble} onClose={onClose} />)
    fireEvent.click(screen.getByText(cp.close))
    expect(onClose).toHaveBeenCalled()
    expect(readTrouble().askedAt).toBeTypeOf('number')
  })

  it('drops the trouble question when opened from Einstellungen', () => {
    render(<FeedbackSheet onClose={() => {}} />)
    expect(screen.queryByText(cp.promptFor.crashLoop)).toBeNull()
    expect(screen.getByText(cp.intro)).toBeTruthy()
  })
})

describe('FeedbackSheet — direct send', () => {
  it('sends what the operator typed, with the trouble that prompted it', async () => {
    render(<FeedbackSheet trouble={trouble} onClose={() => {}} />)
    fireEvent.change(document.querySelector('.fb-input')!, { target: { value: 'Trupp gesetzt, dann weg' } })
    fireEvent.click(screen.getByText(cp.send))

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledOnce())
    expect(mockSubmit.mock.calls[0][0]).toMatchObject({
      message: 'Trupp gesetzt, dann weg',
      trouble: { kind: 'crashLoop' },
    })
  })

  it('shows what the SERVER says it queued, not what the client hoped it sent', async () => {
    mockSubmit.mockResolvedValue({ ok: true, sent: { tags: { install: 'abc-123' } } })
    render(<FeedbackSheet onClose={() => {}} />)
    fireEvent.change(document.querySelector('.fb-input')!, { target: { value: 'kurz gefragt' } })
    fireEvent.click(screen.getByText(cp.send))

    // The echo is the check: a preview written by the sender proves nothing, one returned by
    // the receiver proves what was actually stored.
    await waitFor(() => expect(screen.getByText(cp.sentTitle)).toBeTruthy())
    expect(document.querySelector('.fb-tech-block')?.textContent).toContain('abc-123')
  })

  it('counts as asked once sent, so the same crash is not asked about again', async () => {
    render(<FeedbackSheet trouble={trouble} onClose={() => {}} />)
    fireEvent.click(screen.getByText(cp.send))
    await waitFor(() => expect(screen.getByText(cp.sentTitle)).toBeTruthy())
    expect(readTrouble().askedAt).toBeTypeOf('number')
  })

  it('falls back to mail when sending fails, keeping what was typed', async () => {
    mockSubmit.mockResolvedValue({ ok: false, reason: 'failed' })
    render(<FeedbackSheet onClose={() => {}} />)
    const input = document.querySelector('.fb-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'wichtiger Text' } })
    fireEvent.click(screen.getByText(cp.send))

    await waitFor(() => expect(screen.getByText(cp.sendFailed)).toBeTruthy())
    // The sheet stays open with the text intact — losing it would be the real failure here.
    expect((document.querySelector('.fb-input') as HTMLTextAreaElement).value).toBe('wichtiger Text')
    // ...and the send button steps aside so the operator isn't invited to retry the route
    // that just failed; mail becomes the primary one instead.
    expect(screen.queryByText(cp.send)).toBeNull()
    expect(document.querySelector('.fb-actions .ip-btn.primary')?.textContent).toContain(cp.mail)
  })

  it('explains a deployment that has outbound switched off, rather than calling it an error', async () => {
    mockSubmit.mockResolvedValue({ ok: false, reason: 'disabled' })
    render(<FeedbackSheet onClose={() => {}} />)
    fireEvent.change(document.querySelector('.fb-input')!, { target: { value: 'geht nicht' } })
    fireEvent.click(screen.getByText(cp.send))

    await waitFor(() => expect(screen.getByText(cp.sendDisabled)).toBeTruthy())
    expect(screen.queryByText(cp.sendFailed)).toBeNull()
  })
})

// A stray tap on the backdrop must not cost the operator their words. It still counts as asked
// — that is the cooldown's job and it is right — but the two behaviours are separable and only
// one of them should be destructive.
describe('FeedbackSheet — the draft', () => {
  it('keeps what was typed when the sheet is closed without sending', () => {
    render(<FeedbackSheet trouble={trouble} onClose={() => {}} />)
    fireEvent.change(document.querySelector('.fb-input')!, { target: { value: 'halber Satz' } })
    fireEvent.click(screen.getByText(cp.close))
    expect(readDraft()).toBe('halber Satz')
  })

  it('restores it the next time the sheet opens', () => {
    writeDraft('halber Satz')
    render(<FeedbackSheet onClose={() => {}} />)
    expect((document.querySelector('.fb-input') as HTMLTextAreaElement).value).toBe('halber Satz')
  })

  it('drops it once the text has actually gone somewhere', async () => {
    render(<FeedbackSheet trouble={trouble} onClose={() => {}} />)
    fireEvent.change(document.querySelector('.fb-input')!, { target: { value: 'ist raus' } })
    fireEvent.click(screen.getByText(cp.send))
    await waitFor(() => expect(screen.getByText(cp.sentTitle)).toBeTruthy())
    expect(readDraft()).toBe('')
  })

  it('keeps it when sending failed — that is exactly when it matters most', async () => {
    mockSubmit.mockResolvedValue({ ok: false, reason: 'failed' })
    render(<FeedbackSheet onClose={() => {}} />)
    fireEvent.change(document.querySelector('.fb-input')!, { target: { value: 'wichtiger Text' } })
    fireEvent.click(screen.getByText(cp.send))
    await waitFor(() => expect(screen.getByText(cp.sendFailed)).toBeTruthy())
    expect(readDraft()).toBe('wichtiger Text')
  })
})

// The photo is the one thing that leaves this app which no scrubber can read, so the rules
// around it are the feature. The failure being guarded against is not a crash but a silent one:
// the sheet's three exits look interchangeable to the operator, two of them physically cannot
// carry a file, and an attached photo that goes out by Kopieren is a picture nobody ever sees.
describe('FeedbackSheet — the attached photo', () => {
  it('shows it, at a size you can recognise, before anything is decided', async () => {
    render(<FeedbackSheet onClose={() => {}} />)
    await attachPhoto()
    // «Das wird mitgeschickt» has to stay literally true once there is a picture in it.
    expect(screen.getByAltText(cp.photoAlt)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: cp.photoRemove }))
    await waitFor(() => expect(screen.queryByAltText(cp.photoAlt)).toBeNull())
  })

  it('stops offering a third one', async () => {
    render(<FeedbackSheet onClose={() => {}} />)
    await attachPhoto()
    await attachPhoto()
    expect(screen.getAllByAltText(cp.photoAlt)).toHaveLength(2)
    expect(document.querySelector('.fb-photo-add')).toBeNull()
  })

  it('travels on the direct route', async () => {
    render(<FeedbackSheet onClose={() => {}} />)
    await attachPhoto()
    fireEvent.change(document.querySelector('.fb-input')!, { target: { value: 'so sah es aus' } })
    fireEvent.click(screen.getByText(cp.send))

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledOnce())
    expect(mockSubmit.mock.calls[0][0]).toMatchObject({ photos: [prepared] })
  })

  it('leaves the payload of an ordinary Rückmeldung alone', async () => {
    // Nearly every report carries no photo, and those must put exactly the body on the wire
    // they did before this existed — a feature almost nobody uses has no business showing up
    // in everybody's queue row.
    render(<FeedbackSheet onClose={() => {}} />)
    fireEvent.change(document.querySelector('.fb-input')!, { target: { value: 'nur Text' } })
    fireEvent.click(screen.getByText(cp.send))

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledOnce())
    expect(mockSubmit.mock.calls[0][0]).not.toHaveProperty('photos')
  })

  it('says so next to the two routes that cannot take it', async () => {
    render(<FeedbackSheet onClose={() => {}} />)
    expect(screen.queryByText(cp.photoOnlyDirect)).toBeNull()
    await attachPhoto()
    // A note, never a disabled button: the TEXT is still worth copying, and on a deployment
    // with outbound switched off Kopieren/E-Mail are the only exits there are.
    expect(screen.getByText(cp.photoOnlyDirect)).toBeTruthy()
    expect(screen.getByText(cp.copy)).toBeTruthy()
  })

  it('is not offered at all once the server has said the direct route is off', async () => {
    mockSubmit.mockResolvedValue({ ok: false, reason: 'disabled' })
    render(<FeedbackSheet onClose={() => {}} />)
    expect(document.querySelector('.fb-photo-add')).toBeTruthy()

    fireEvent.change(document.querySelector('.fb-input')!, { target: { value: 'geht nicht' } })
    fireEvent.click(screen.getByText(cp.send))

    await waitFor(() => expect(screen.getByText(cp.sendDisabled)).toBeTruthy())
    // There is no route left that could carry a file, so the sheet stops implying there is.
    expect(document.querySelector('.fb-photo-add')).toBeNull()
  })

  it('is still offered after a plain failure — that is offline, and offline is normal', async () => {
    mockSubmit.mockResolvedValue({ ok: false, reason: 'failed' })
    render(<FeedbackSheet onClose={() => {}} />)
    fireEvent.change(document.querySelector('.fb-input')!, { target: { value: 'kaputt' } })
    fireEvent.click(screen.getByText(cp.send))

    await waitFor(() => expect(screen.getByText(cp.sendFailed)).toBeTruthy())
    expect(document.querySelector('.fb-photo-add')).toBeTruthy()
  })
})
