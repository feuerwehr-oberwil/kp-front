// The touch answer to the title-tooltip (28.08. field feedback, decision B of
// mockups/atemschutz-kopf-beschriftung.html): every icon-only button in the app already carries
// its word as `aria-label`/`title`, and on a mouse the hover tooltip shows it — but the primary
// devices are tablets, where `title` never appears and an untrained operator is left guessing
// what 👣 or 💧 does. Holding such a button ~350 ms now shows that word as a bubble (with the
// short arm buzz) and does NOT fire the action; releasing early taps as always.
//
// ONE document-level listener rather than a hook per button: the rule is app-wide by design
// («every icon-only button explains itself the same way»), and threading a hook through dozens
// of components would guarantee gaps exactly where nobody thought of it.
//
// What is eligible — decided at press time, from the DOM alone:
//  · a <button> (or role="button") whose accessible name lives ONLY in aria-label/title, i.e.
//    it renders no visible text — a labelled button already says its word;
//  · …or one marked `data-holdexplain`, whose visible text is a CODE and not a word (the FKS
//    letter chips: «S», «N», «G»). Opt-in, so nothing becomes explainable by accident;
//  · not `[data-holdaction]`: controls whose press-and-hold IS a gesture of their own
//    (±steppers via useHoldRepeat, the Eintrag hold via useHoldEntry) opt out at the source;
//  · touch/pen presses only — the mouse keeps its native hover tooltip.
//
// The suppressed tap: once the bubble has shown, the release must not also trigger the button —
// «I asked what it is» and «I did it» cannot be the same gesture. The click that follows
// pointerup is swallowed by a one-shot capture listener; Android's long-press contextmenu is
// suppressed for the same press.

import { buzz } from './haptics'

// 350, not 500 (28.08. field feedback: «takes too long») — the same window the Eintrag hold
// (useHoldEntry · HOLD_MS) uses, so every still hold in the app answers on one beat.
const HOLD_MS = 350
const MOVE_TOL_PX = 8
const LINGER_MS = 1100

function labelOf(el: HTMLElement): string | null {
  const aria = el.getAttribute('aria-label') || el.getAttribute('title')
  if (!aria) return null
  // icon-only means no visible words of its own — an <svg> icon has no textContent.
  //
  // `data-holdexplain` is the opt-in for the other case: a control whose visible text is a CODE
  // rather than a word. An FKS letter chip says «N» — which is a full explanation to somebody who
  // has learned the sheet and nothing at all to anybody else, which is the exact gap this bubble
  // exists to close. A button with a real word still opts out, because it has already answered.
  if ((el.textContent ?? '').trim() !== '' && !el.hasAttribute('data-holdexplain')) return null
  return aria
}

function eligible(target: EventTarget | null): { el: HTMLElement; label: string } | null {
  if (!(target instanceof Element)) return null
  const el = target.closest<HTMLElement>('button, [role="button"]')
  if (!el || el.closest('[data-holdaction]')) return null
  const label = labelOf(el)
  return label ? { el, label } : null
}

function showBubble(el: HTMLElement, label: string): HTMLElement {
  const b = document.createElement('div')
  b.className = 'hold-tip'
  b.textContent = label
  b.setAttribute('role', 'tooltip')
  document.body.appendChild(b)
  const r = el.getBoundingClientRect()
  // above the button, clamped into the viewport; below it when there is no room above
  const bw = b.offsetWidth
  const left = Math.max(6, Math.min(window.innerWidth - bw - 6, r.left + r.width / 2 - bw / 2))
  const top = r.top - b.offsetHeight - 8
  b.style.left = `${Math.round(left)}px`
  b.style.top = `${Math.round(top >= 6 ? top : r.bottom + 8)}px`
  return b
}

/** Install the app-wide hold-tooltip listeners. Returns the uninstaller (for tests / HMR). */
export function installHoldTooltip(): () => void {
  let press: { el: HTMLElement; label: string; x: number; y: number; timer: number } | null = null
  let bubble: HTMLElement | null = null
  let bubbleFor: HTMLElement | null = null // set while the NEXT click must be swallowed
  let lingerTimer = 0

  const dropBubble = () => {
    if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = 0 }
    bubble?.remove()
    bubble = null
  }
  const cancelPress = () => {
    if (press) { clearTimeout(press.timer); press = null }
  }

  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return
    const hit = eligible(e.target)
    if (!hit) return
    dropBubble()
    bubbleFor = null
    const timer = window.setTimeout(() => {
      if (!press) return
      bubble = showBubble(press.el, press.label)
      bubbleFor = press.el
      press = null
      buzz() // the hold latched into an answer — same cue as every other armed hold
    }, HOLD_MS)
    press = { ...hit, x: e.clientX, y: e.clientY, timer }
  }
  const onMove = (e: PointerEvent) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOL_PX) cancelPress()
  }
  const onUp = () => {
    cancelPress()
    if (bubble) lingerTimer = window.setTimeout(dropBubble, LINGER_MS)
  }
  // the release after a shown bubble must not act — swallow exactly that one click
  const onClick = (e: MouseEvent) => {
    if (!bubbleFor) return
    if (e.target instanceof Element && bubbleFor.contains(e.target as Node)) {
      e.preventDefault()
      e.stopPropagation()
    }
    bubbleFor = null
  }
  // Android fires contextmenu on a long press — ours, here, is the tooltip
  const onContextMenu = (e: Event) => {
    if ((press || bubble) && eligible(e.target)) e.preventDefault()
  }

  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('pointermove', onMove, true)
  document.addEventListener('pointerup', onUp, true)
  document.addEventListener('pointercancel', onUp, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('contextmenu', onContextMenu, true)
  return () => {
    cancelPress(); dropBubble(); bubbleFor = null
    document.removeEventListener('pointerdown', onDown, true)
    document.removeEventListener('pointermove', onMove, true)
    document.removeEventListener('pointerup', onUp, true)
    document.removeEventListener('pointercancel', onUp, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('contextmenu', onContextMenu, true)
  }
}
