// DIAGNOSTIC, opt-in (review round 5, 18.10.2026 — remove once the owner's iPhone capture is in):
// `/karte?debug=scroll` shows, live, what decides whether the phone's search sheet or the page moves
// under a finger — what WebKit on Linux cannot show (no native touch scroll, no software keyboard;
// e2e/karte-search-scroll.mjs models both). `?debug=off` ends it. Since round 8 also five quick taps
// on the build line at the foot of the app menu switch it on and off (lib/scrollDebug): the
// INSTALLED app has no address bar, and that is where the owner's search still failed. Sticky on
// the device (localStorage).
//
// The first line says which app it is and its frame (round 8): `app` (standalone: home-screen
// app) or `tab`, innerWidth×innerHeight, the full height the keyboard placement measures from
// (`ref`, lib/iosKeyboard · fullViewHeight, round 9), the document's client height and scroll height,
// the root's computed height and its scrollTop (`html … top`, round 10: the root follows the live
// window, 02-base.css · html[data-typing-lock], so a document that can scroll — what iOS hands a
// drag on to — shows as a height above innerHeight or a top above 0), the screen's height and the
// safe-area insets top/bottom as the CSS reads them.
//
// Lines: the visual viewport (height · offsetTop = iOS's pan · scale) against innerHeight and
// window.scrollY; `data-kb` on the root and on the sheet with its --ks-bottom/--ks-max; the field's
// and the sheet's top ON THE SCREEN (layout px less the pan) — and the sheet's raw rect top: in the
// installed app's collapse (round 9) iOS's rects already include its window scroll, so «less the
// pan» counted it twice (−516 where the frames show −147) — and the list's scrollTop/max; and the
// last touch: where it started, and per touchmove «.» passed, «X» cancelled by a guard, «-» not
// cancelable (iOS is already scrolling). Written to the DOM per frame, never a React render; it
// takes no touches (pointer-events: none) and lies over the top bar, riding with it (--vv-pan).
//
// WHAT MOVED during the last touch (review round 7, owner's video: the sheet slid down with a drag
// on the list while the top bar held — WebKit on Linux runs the same gesture and nothing moves, so
// only this tells which mover it is). From touchstart to a second after the lift («…» while it
// records), then kept on screen until the next touch:
//   «Δ» each box's screen top, lowest/highest against its place at touchstart — the top bar, the
//       sheet, the map — and iOS's pan (vv offsetTop), window.scrollY, innerHeight and the visual
//       viewport's height over the same touch (round 8: an installed app's frame can change size);
//   «scrolled» every element that fired a scroll event in the touch, with its scrollTop range
//       (a scroller carrying the sheet shows here, the list itself as `lc-body`) — read in the
//       event, so it also shows a scroll the page lock undid before the frame (round 10), which
//       «Δ», read per frame, does not;
//   «sheet» the sheet's own pull (inline transform, overlays/swipeDismiss) at its largest, how
//       often `data-kb` flipped and the --ks-bottom range; «ptr» where the pointer went down and
//       whether iOS took the touch over (pointercancel).

import { useEffect, useRef } from 'react'
import { isStandalone } from '../../lib/installPrompt'
import { fullViewHeight } from '../../lib/iosKeyboard'
import { useScrollDebug } from '../../lib/scrollDebug'

const r = (n: number | undefined) => (n == null ? '–' : String(Math.round(n)))
const named = (el: Element | null) => (el ? `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0].slice(0, 18)}` : ''}` : '–')

export function KarteScrollDebug() {
  const on = useScrollDebug()
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (!on) return
    let frame = 0
    let touch = { from: '–', moves: '' }
    // the last touch's movers (head of this file): live while the finger is down, kept after
    const sheetEl = () => document.querySelector<HTMLElement>('[data-karte-keysheet]')
    const screenTop = (sel: string) => {
      const el = document.querySelector(sel)
      return el ? el.getBoundingClientRect().top - (window.visualViewport?.offsetTop ?? 0) : null
    }
    type Range = { at: number; lo: number; hi: number }
    const range = (at: number | null): Range | null => (at == null ? null : { at, lo: 0, hi: 0 })
    const widen = (rg: Range | null, now: number | null) => { if (rg && now != null) { rg.lo = Math.min(rg.lo, now - rg.at); rg.hi = Math.max(rg.hi, now - rg.at) } }
    const fresh = () => ({
      down: false, bar: range(screenTop('.topbar')), sheet: range(screenTop('[data-karte-keysheet]')), map: range(screenTop('.maplibregl-map')),
      pan: range(window.visualViewport?.offsetTop ?? 0), sy: range(window.scrollY),
      inner: range(window.innerHeight), vvh: range(window.visualViewport?.height ?? null),
      scrolled: new Map<string, { lo: number; hi: number }>(), pull: 0, kbFlips: 0, kb: !!sheetEl()?.hasAttribute('data-kb'),
      ks: { lo: Infinity, hi: -Infinity }, ptr: '–', cancel: false,
    })
    let moved = fresh()
    // iOS sends pointerdown BEFORE touchstart: kept here, handed to the touch when it starts
    let ptr = '–'
    const sample = () => {
      widen(moved.bar, screenTop('.topbar')); widen(moved.sheet, screenTop('[data-karte-keysheet]')); widen(moved.map, screenTop('.maplibregl-map'))
      widen(moved.pan, window.visualViewport?.offsetTop ?? 0); widen(moved.sy, window.scrollY)
      widen(moved.inner, window.innerHeight); widen(moved.vvh, window.visualViewport?.height ?? null)
      const sh = sheetEl()
      if (sh) {
        const m = /translateY\((-?[\d.]+)px\)/.exec(sh.style.transform)
        if (m) moved.pull = Math.max(moved.pull, Number(m[1]))
        const kb = sh.hasAttribute('data-kb')
        if (kb !== moved.kb) { moved.kb = kb; moved.kbFlips++ }
        const ks = parseFloat(sh.style.getPropertyValue('--ks-bottom'))
        if (Number.isFinite(ks)) { moved.ks.lo = Math.min(moved.ks.lo, ks); moved.ks.hi = Math.max(moved.ks.hi, ks) }
      }
    }
    const start = (e: TouchEvent) => {
      touch = { from: named(e.target instanceof Element ? e.target : null), moves: '' }
      moved = fresh()
      moved.ptr = ptr
      moved.down = true
    }
    // on window, bubbling: after the document-level guards (useTypingLock, useMobileScrollLock) decided
    const move = (e: TouchEvent) => { if (touch.moves.length < 40) touch.moves += !e.cancelable ? '-' : e.defaultPrevented ? 'X' : '.'; sample() }
    // …and for a second after the lift: momentum, a snap back and iOS's own settling land there
    let after: ReturnType<typeof setTimeout> | undefined
    const end = () => { sample(); const was = moved; clearTimeout(after); after = setTimeout(() => { was.down = false }, 1000) }
    const scrolled = (e: Event) => {
      if (!moved.down) return
      const t = e.target
      const el = t instanceof Element ? t : t === document ? document.scrollingElement : null
      const name = t === window.visualViewport ? 'vv' : el ? `${named(el)}${el.id ? `#${el.id}` : ''}` : '?'
      const top = t === window.visualViewport ? Math.round(window.visualViewport?.offsetTop ?? 0) : Math.round(el?.scrollTop ?? 0)
      const was = moved.scrolled.get(name)
      moved.scrolled.set(name, was ? { lo: Math.min(was.lo, top), hi: Math.max(was.hi, top) } : { lo: top, hi: top })
      // no «Δ» sample here: inside the event the lock has not undone the scroll yet (round 10,
      // lib/iosKeyboard · useTypingLock) — «Δ» is read per frame, what the screen shows
    }
    const down = (e: PointerEvent) => { if (e.pointerType === 'touch') ptr = named(e.target instanceof Element ? e.target : null) }
    const cancel = () => { moved.cancel = true }
    const d = (rg: Range | null) => (rg ? (rg.lo === 0 && rg.hi === 0 ? '0' : `${r(rg.lo)}/+${r(rg.hi)}`) : '–')
    // the safe-area insets as the CSS reads them: a probe that takes no room and no touch
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)'
    document.body.appendChild(probe)
    const app = isStandalone() ? 'app' : 'tab'
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const el = ref.current
      if (!el) return
      const vv = window.visualViewport
      const pan = vv?.offsetTop ?? 0
      const sheet = document.querySelector<HTMLElement>('[data-karte-keysheet]')
      const field = sheet?.querySelector('input')
      const list = sheet?.querySelector<HTMLElement>('.lc-body')
      const top = (n: Element | null | undefined) => (n ? r(n.getBoundingClientRect().top - pan) : '–')
      const doc = document.scrollingElement ?? document.documentElement
      const inset = getComputedStyle(probe)
      el.textContent = [
        `${app} ${window.innerWidth}×${window.innerHeight} · ref ${fullViewHeight()} · doc ${doc.clientHeight}/${doc.scrollHeight} · html ${r(parseFloat(getComputedStyle(document.documentElement).height) || undefined)} top ${r(document.documentElement.scrollTop)} · screen ${window.screen?.height ?? '–'} · safe ${r(parseFloat(inset.paddingTop))}/${r(parseFloat(inset.paddingBottom))}`,
        `vv h ${r(vv?.height)} pan ${r(pan)} ×${vv?.scale?.toFixed(2) ?? '–'} · inner ${window.innerHeight} · scrollY ${r(window.scrollY)}`,
        `kb root ${document.documentElement.hasAttribute('data-kb') ? 'on' : 'off'} · sheet ${sheet?.hasAttribute('data-kb') ? `on ${sheet.style.getPropertyValue('--ks-bottom')}/${sheet.style.getPropertyValue('--ks-max')}` : 'off'}`,
        `screen top: sheet ${top(sheet)} (rect ${sheet ? r(sheet.getBoundingClientRect().top) : '–'}) field ${top(field)} · list ${list ? `${r(list.scrollTop)}/${r(list.scrollHeight - list.clientHeight)}` : '–'}`,
        `focus ${named(document.activeElement)}`,
        `touch ${touch.from} ${touch.moves}`,
        `Δ${moved.down ? '…' : ''} bar ${d(moved.bar)} sheet ${d(moved.sheet)} map ${d(moved.map)} · pan ${d(moved.pan)} scrollY ${d(moved.sy)} · inner ${d(moved.inner)} vv h ${d(moved.vvh)}`,
        `scrolled ${[...moved.scrolled].map(([k, v]) => `${k} ${v.lo}…${v.hi}`).join(', ') || '–'}`,
        `sheet pull ${r(moved.pull)} · kb flips ${moved.kbFlips} · ks ${Number.isFinite(moved.ks.lo) ? `${r(moved.ks.lo)}…${r(moved.ks.hi)}` : '–'} · ptr ${moved.ptr}${moved.cancel ? ' cancel' : ''}`,
      ].join('\n')
      if (moved.down) sample()
    }
    document.addEventListener('touchstart', start, { passive: true, capture: true })
    window.addEventListener('touchmove', move, { passive: true })
    window.addEventListener('touchend', end, { passive: true })
    window.addEventListener('touchcancel', end, { passive: true })
    // scroll events do not bubble: caught on the way down, every scroller in the document
    document.addEventListener('scroll', scrolled, { passive: true, capture: true })
    window.visualViewport?.addEventListener('scroll', scrolled)
    document.addEventListener('pointerdown', down, { passive: true, capture: true })
    document.addEventListener('pointercancel', cancel, { passive: true, capture: true })
    draw()
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(after)
      probe.remove()
      document.removeEventListener('touchstart', start, { capture: true })
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', end)
      window.removeEventListener('touchcancel', end)
      document.removeEventListener('scroll', scrolled, { capture: true })
      window.visualViewport?.removeEventListener('scroll', scrolled)
      document.removeEventListener('pointerdown', down, { capture: true })
      document.removeEventListener('pointercancel', cancel, { capture: true })
    }
  }, [on])
  if (!on) return null
  return (
    <pre ref={ref} aria-hidden="true" data-debug-scroll=""
      style={{ position: 'fixed', left: 4, right: 4, top: 'calc(env(safe-area-inset-top) + 2px)', transform: 'translateY(var(--vv-pan, 0px))', zIndex: 2147483647, margin: 0, padding: '4px 6px',
        font: '10px/1.35 ui-monospace, Menlo, monospace', color: '#0f0', background: 'rgba(0,0,0,.78)', borderRadius: 6, pointerEvents: 'none', whiteSpace: 'pre-wrap' }} />
  )
}
