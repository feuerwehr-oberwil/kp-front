// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installHoldTooltip } from './holdTooltip'

// jsdom has no PointerEvent constructor; the listeners only read pointerType/clientX/clientY
function ptr(type: string, target: Element | Document, opts: { pointerType?: string; x?: number; y?: number } = {}) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: opts.x ?? 10, clientY: opts.y ?? 10 })
  Object.defineProperty(e, 'pointerType', { value: opts.pointerType ?? 'touch' })
  target.dispatchEvent(e)
}

let uninstall: () => void
let btn: HTMLButtonElement

beforeEach(() => {
  vi.useFakeTimers()
  uninstall = installHoldTooltip()
  btn = document.createElement('button')
  btn.setAttribute('aria-label', 'Auf Karte setzen')
  btn.innerHTML = '<svg></svg>' // icon-only: no visible text
  document.body.appendChild(btn)
})
afterEach(() => { uninstall(); document.body.innerHTML = ''; vi.useRealTimers() })

const bubble = () => document.querySelector('.hold-tip')

describe('holdTooltip', () => {
  it('a held icon-only button shows its label and the release does not act', () => {
    const onClick = vi.fn()
    btn.addEventListener('click', onClick)
    ptr('pointerdown', btn)
    expect(bubble()).toBeNull() // not yet — a tap must stay a tap
    vi.advanceTimersByTime(520)
    expect(bubble()?.textContent).toBe('Auf Karte setzen')
    ptr('pointerup', btn)
    ptr('click', btn) // the browser's click after release
    expect(onClick).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1200) // the bubble lingers, then goes
    expect(bubble()).toBeNull()
  })

  it('a quick tap fires normally and never shows a bubble', () => {
    const onClick = vi.fn()
    btn.addEventListener('click', onClick)
    ptr('pointerdown', btn)
    vi.advanceTimersByTime(100)
    ptr('pointerup', btn)
    ptr('click', btn)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(bubble()).toBeNull()
  })

  it('movement past the tolerance cancels the press (it is a drag, not a question)', () => {
    ptr('pointerdown', btn, { x: 10, y: 10 })
    ptr('pointermove', btn, { x: 40, y: 10 })
    vi.advanceTimersByTime(600)
    expect(bubble()).toBeNull()
  })

  it('mouse presses are ignored — the hover tooltip already answers there', () => {
    ptr('pointerdown', btn, { pointerType: 'mouse' })
    vi.advanceTimersByTime(600)
    expect(bubble()).toBeNull()
  })

  it('a button with visible text is not claimed — it already says its word', () => {
    const worded = document.createElement('button')
    worded.setAttribute('aria-label', 'Eintrag')
    worded.textContent = 'Eintrag'
    document.body.appendChild(worded)
    ptr('pointerdown', worded)
    vi.advanceTimersByTime(600)
    expect(bubble()).toBeNull()
  })

  // The FKS letter chips: «N» is a full explanation to somebody who learned the sheet and
  // nothing at all to anybody else, which is exactly the gap the bubble exists to close.
  it('[data-holdexplain] IS claimed — its visible text is a code, not a word', () => {
    const chip = document.createElement('button')
    chip.setAttribute('aria-label', 'Nasse Haltelinie')
    chip.setAttribute('data-holdexplain', '')
    chip.textContent = 'N'
    document.body.appendChild(chip)
    ptr('pointerdown', chip)
    vi.advanceTimersByTime(600)
    expect(bubble()?.textContent).toBe('Nasse Haltelinie')
  })

  // Same question, whichever device asks it: a mouse resting on a coded chip gets the same bubble
  // the tablet gets from a hold. The native `title` was the wrong answer — a second late, unstyled,
  // and doubled up with ours on a touchscreen laptop.
  it('a mouse hover explains a [data-holdexplain] chip', () => {
    const chip = document.createElement('button')
    chip.setAttribute('aria-label', 'Gegenfeuer')
    chip.setAttribute('data-holdexplain', '')
    chip.textContent = 'G'
    document.body.appendChild(chip)
    ptr('pointerover', chip, { pointerType: 'mouse' })
    vi.advanceTimersByTime(400)
    expect(bubble()?.textContent).toBe('Gegenfeuer')
    ptr('pointerout', chip, { pointerType: 'mouse' })
    expect(bubble()).toBeNull()
  })

  // design pass C10: a chip group is read by sweeping along it – the 220 ms dwell once, not per chip
  it('after a hover bubble, the next coded chip answers at once; ~300 ms with none open, the wait is back', () => {
    const chip = (label: string, code: string) => {
      const c = document.createElement('button')
      c.setAttribute('aria-label', label)
      c.setAttribute('data-holdexplain', '')
      c.textContent = code
      document.body.appendChild(c)
      return c
    }
    const s = chip('Sicherung', 'S'), n = chip('Nasse Haltelinie', 'N'), g = chip('Gegenfeuer', 'G')
    // a dwell that never showed its bubble does not warm the group
    ptr('pointerover', s, { pointerType: 'mouse' })
    vi.advanceTimersByTime(100)
    ptr('pointerout', s, { pointerType: 'mouse' })
    ptr('pointerover', n, { pointerType: 'mouse' })
    expect(bubble()).toBeNull()
    vi.advanceTimersByTime(220)
    expect(bubble()?.textContent).toBe('Nasse Haltelinie')
    // …one that did: the neighbour answers on arrival
    ptr('pointerout', n, { pointerType: 'mouse' })
    ptr('pointerover', g, { pointerType: 'mouse' })
    expect(bubble()?.textContent).toBe('Gegenfeuer')
    // none open for longer than the warm window: cold again
    ptr('pointerout', g, { pointerType: 'mouse' })
    vi.advanceTimersByTime(301)
    ptr('pointerover', s, { pointerType: 'mouse' })
    expect(bubble()).toBeNull()
    vi.advanceTimersByTime(220)
    expect(bubble()?.textContent).toBe('Sicherung')
  })

  it('an ordinary icon-only button keeps its native tooltip on a mouse', () => {
    ptr('pointerover', btn, { pointerType: 'mouse' })
    vi.advanceTimersByTime(400)
    expect(bubble()).toBeNull()
  })

  it('[data-holdaction] opts out — holding IS that control\'s own gesture', () => {
    btn.setAttribute('data-holdaction', 'true')
    ptr('pointerdown', btn)
    vi.advanceTimersByTime(600)
    expect(bubble()).toBeNull()
  })

  // sweep 28.10.2026 #21: a tap on the ⓘ already shows its help (DockInfo's label IS that help)
  it('a disclosure (aria-expanded) is never claimed — its tap already explains', () => {
    btn.setAttribute('aria-expanded', 'false')
    ptr('pointerdown', btn)
    vi.advanceTimersByTime(600)
    expect(bubble()).toBeNull()
  })

  // Üben feedback (owner 27.11.2026, «Yes, hold names them»): with the words off, Verlauf and the
  // Gebäude-Info / Messungen chips are a glyph alone – their host marks them, and a hold names them
  it('a bare panel door ([data-holdname]) IS claimed – held it names, the release opens nothing; a tap opens', () => {
    const onClick = vi.fn()
    btn.setAttribute('aria-expanded', 'false')
    btn.setAttribute('data-holdname', 'true')
    btn.setAttribute('aria-label', 'Verlauf')
    btn.innerHTML = '<svg></svg><span aria-hidden="true">J</span>' // the corner key letter is no word
    btn.addEventListener('click', onClick)
    ptr('pointerdown', btn)
    vi.advanceTimersByTime(520)
    expect(bubble()?.textContent).toBe('Verlauf')
    ptr('pointerup', btn)
    ptr('click', btn)
    expect(onClick).not.toHaveBeenCalled()
    ptr('pointerdown', btn)
    ptr('pointerup', btn)
    ptr('click', btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('a hold whose release sent no click does not eat the next real tap', () => {
    const onClick = vi.fn()
    btn.addEventListener('click', onClick)
    ptr('pointerdown', btn)
    vi.advanceTimersByTime(520)
    ptr('pointerup', btn) // …and the browser sends no click for the long press
    btn.setAttribute('aria-label', 'Neu') // still eligible or not – the next press is a new gesture
    btn.textContent = 'Neu'
    ptr('pointerdown', btn)
    ptr('pointerup', btn)
    ptr('click', btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
