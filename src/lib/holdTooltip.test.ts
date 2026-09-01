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

  it('[data-holdaction] opts out — holding IS that control\'s own gesture', () => {
    btn.setAttribute('data-holdaction', 'true')
    ptr('pointerdown', btn)
    vi.advanceTimersByTime(600)
    expect(bubble()).toBeNull()
  })
})
