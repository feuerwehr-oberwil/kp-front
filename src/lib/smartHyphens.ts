/**
 * Hyphenate a title ONLY where it saves a line (owner, 20.10.2026, Karte Haus round 6: «Lösch-
 * wasserrückhalt / Trink-wasser» – moving «Trinkwasser» down whole made no third line, so it
 * should have stayed whole). CSS cannot say «hyphenate when it is cheaper»: `hyphens: auto` breaks
 * wherever the dictionary allows, `hyphenate-limit-chars` / `text-wrap: pretty` only approximate
 * it. So each title is laid out both ways and keeps the cheaper one:
 *
 * - the same line count with whole words → whole words (`hyphens: manual`, the CSS default);
 * - fewer lines hyphenated, or a word wider than the line on its own (which would otherwise break
 *   mid-letter by `overflow-wrap`) → `hyphens: auto`, set inline on the element.
 *
 * Use it as a ref on the text element – it is a plain ref callback (React 19 cleanup), no hook:
 *
 *   <span className="list-row-title" ref={smartHyphens}>{title}</span>
 *
 * The element's CSS keeps `overflow-wrap: break-word` and leaves `hyphens` at manual. A
 * `-webkit-line-clamp` on it is lifted while measuring (the unclamped text counts).
 *
 * Cheap: ONE ResizeObserver and ONE MutationObserver for every registered element, measured in a
 * batch (three layouts for the whole list, never one per row) – on mount (before paint), when its
 * width or text changes, and once the web fonts have loaded. Never on scroll.
 */

type Hyphens = 'auto' | 'manual'

/** The two layouts of one element, in px: its height with whole words, its height hyphenated,
 *  and whether a single word is wider than the line with whole words. */
export type HyphenLayouts = { wholeWords: number; hyphenated: number; wordOverflows: boolean }

/** The decision, pure: hyphenate only when it saves a line or a word cannot fit on its own.
 *  A pixel of tolerance – sub-pixel heights differ without a line between them. */
export function chooseHyphens({ wholeWords, hyphenated, wordOverflows }: HyphenLayouts): Hyphens {
  return wordOverflows || hyphenated < wholeWords - 1 ? 'auto' : 'manual'
}

// what the last measure saw per element: a new width or text measures again, the same skips
const seen = new WeakMap<HTMLElement, { width: number; text: string }>()
const registered = new Set<HTMLElement>()
const pending = new Set<HTMLElement>()
let watch: { resize: ResizeObserver; mutation: MutationObserver } | null = null
let flushQueued = false

// the inline properties a measure sets for a moment, and puts back
const PROBE = ['display', '-webkit-line-clamp', 'overflow-wrap', 'hyphens', '-webkit-hyphens'] as const

function setHyphens(el: HTMLElement, h: Hyphens) {
  el.style.setProperty('hyphens', h)
  el.style.setProperty('-webkit-hyphens', h)
}

/** Measure every pending element in one batch: write all, read all – three layouts in total. */
function flush() {
  flushQueued = false
  const els = [...pending].filter((el) => el.isConnected)
  pending.clear()
  if (!els.length) return
  const saved = els.map((el) => PROBE.map((p) => el.style.getPropertyValue(p)))
  for (const el of els) {
    el.style.setProperty('display', 'block')
    el.style.setProperty('-webkit-line-clamp', 'none')
    el.style.setProperty('overflow-wrap', 'normal')
    setHyphens(el, 'manual')
  }
  const whole = els.map((el) => {
    const r = el.getBoundingClientRect()
    return { width: r.width, height: r.height, wordOverflows: el.scrollWidth > el.clientWidth + 1 }
  })
  for (const el of els) setHyphens(el, 'auto')
  const hyphenated = els.map((el) => el.getBoundingClientRect().height)
  els.forEach((el, i) => {
    PROBE.forEach((p, j) => (saved[i][j] ? el.style.setProperty(p, saved[i][j]) : el.style.removeProperty(p)))
    const { width, height, wordOverflows } = whole[i]
    const h = chooseHyphens({ wholeWords: height, hyphenated: hyphenated[i], wordOverflows })
    if (h === 'auto') setHyphens(el, 'auto')
    else { el.style.removeProperty('hyphens'); el.style.removeProperty('-webkit-hyphens') }
    el.dataset.hyphens = h
    seen.set(el, { width, text: el.textContent ?? '' })
  })
}

function queue(el: HTMLElement, when: 'now' | 'frame') {
  pending.add(el)
  if (flushQueued) return
  flushQueued = true
  // a microtask still runs before the paint (a mount, a text change); a ResizeObserver callback
  // waits a frame: changing an observed element's height inside it raises the browser's
  // «ResizeObserver loop completed with undelivered notifications» error
  if (when === 'now') queueMicrotask(flush)
  else requestAnimationFrame(flush)
}

function changed(el: HTMLElement, width: number) {
  const last = seen.get(el)
  return !last || Math.abs(last.width - width) > 0.5 || last.text !== (el.textContent ?? '')
}

function observers() {
  if (watch) return watch
  const resize = new ResizeObserver((entries) => {
    for (const e of entries) {
      const el = e.target as HTMLElement
      // its own height change (the decision, a new text) lands here too: only a new width or text counts
      if (changed(el, el.getBoundingClientRect().width)) queue(el, 'frame')
    }
  })
  const mutation = new MutationObserver((records) => {
    for (const r of records) {
      let n: Node | null = r.target
      while (n && !(n instanceof HTMLElement && registered.has(n))) n = n.parentNode
      if (n) queue(n as HTMLElement, 'now')
    }
  })
  // a fallback font lays the text out differently: measure everything again once the real one is in
  document.fonts?.addEventListener('loadingdone', () => {
    for (const el of registered) { seen.delete(el); queue(el, 'frame') }
  })
  return (watch = { resize, mutation })
}

/** The ref callback: registers the element, measures it before its first paint, and unregisters
 *  it on unmount. A no-op where there is no layout (jsdom, SSR). */
export function smartHyphens(el: HTMLElement | null): (() => void) | undefined {
  if (!el || typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') return undefined
  const { resize, mutation } = observers()
  registered.add(el)
  resize.observe(el)
  mutation.observe(el, { childList: true, characterData: true, subtree: true })
  queue(el, 'now')
  return () => {
    registered.delete(el)
    pending.delete(el)
    resize.unobserve(el)
    // a MutationObserver cannot drop one target: its records for a gone element find no host
  }
}
