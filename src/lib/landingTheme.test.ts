// @vitest-environment jsdom
// The public landing pages run a shared plain script outside the React application.
// Exercise it with real DOM controls and isolated OS/storage event sources.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const script = readFileSync('site/theme.js', 'utf8')
const key = 'kp-landing-theme'

function start({ dark = false, saved = null as string | null, blocked = false } = {}) {
  const page = document.implementation.createHTMLDocument()
  const system = Object.assign(new EventTarget(), { matches: dark })
  const browser = Object.assign(new EventTarget(), { matchMedia: () => system })
  const storage = {
    getItem: vi.fn(() => { if (blocked) throw new Error('Blocked'); return saved }),
    setItem: vi.fn((_key: string, value: string) => { if (blocked) throw new Error('Blocked'); saved = value }),
  }
  new Function('window', 'document', 'localStorage', script)(browser, page, storage)
  // Markup arrives after the head script. It is reconciled once parsing finishes.
  page.body.innerHTML = '<button class="theme-toggle" hidden></button><details class="mobile-options"><summary>Options</summary><button class="theme-toggle" hidden></button></details><picture><source data-theme-dark media="(prefers-color-scheme: dark)"><img alt=""></picture>'
  page.dispatchEvent(new Event('DOMContentLoaded'))
  const button = page.querySelector<HTMLButtonElement>('button')!
  const source = page.querySelector('source')!
  return {
    page, button, source, storage,
    systemChange(value: boolean) { system.matches = value; system.dispatchEvent(new Event('change')) },
    storageChange(value: string | null, eventKey: string | null = key) {
      browser.dispatchEvent(Object.assign(new Event('storage'), { key: eventKey, newValue: value }))
    },
  }
}

describe('public landing-page theme', () => {
  it('keeps header and menu controls synchronized, dismissing the menu on Escape or outside taps', () => {
    const view = start()
    const menu = view.page.querySelector('details')!
    const inside = menu.querySelector('button')!
    const summary = menu.querySelector('summary')!
    const focus = vi.spyOn(summary, 'focus')
    menu.open = true
    inside.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(menu.open).toBe(true)
    inside.click()
    expect(view.button.getAttribute('aria-pressed')).toBe('true')
    expect(inside.getAttribute('aria-pressed')).toBe('true')
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(menu.open).toBe(false)
    expect(focus).toHaveBeenCalledOnce()
    menu.open = true
    view.button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(menu.open).toBe(false)
  })

  it('follows live OS changes until the visitor makes a choice', () => {
    const view = start({ dark: true })
    expect(view.page.documentElement.dataset.theme).toBe('dark')
    expect(view.source.media).toBe('all')
    expect(view.button.hidden).toBe(false)
    expect(view.button.getAttribute('aria-pressed')).toBe('true')
    view.systemChange(false)
    expect(view.page.documentElement.dataset.theme).toBe('light')
    expect(view.source.media).toBe('not all')
    expect(view.storage.setItem).not.toHaveBeenCalled()
    view.button.click()
    expect(view.storage.setItem).toHaveBeenCalledWith(key, 'dark')
    view.systemChange(true)
    view.systemChange(false)
    expect(view.page.documentElement.dataset.theme).toBe('dark')
  })

  it('uses a remembered choice before markup is parsed, including after a language change', () => {
    const view = start({ dark: true, saved: 'light' })
    expect(view.page.documentElement.dataset.theme).toBe('light')
    expect(view.button.getAttribute('aria-pressed')).toBe('false')
    expect(view.storage.getItem).toHaveBeenCalledWith(key)
  })

  it('remains usable when storage is blocked or holds an invalid value', () => {
    const blocked = start({ blocked: true })
    blocked.button.click()
    expect(blocked.page.documentElement.dataset.theme).toBe('dark')
    blocked.button.click()
    expect(blocked.page.documentElement.dataset.theme).toBe('light')
    expect(start({ dark: true, saved: 'obsolete' }).page.documentElement.dataset.theme).toBe('dark')
  })

  it('updates an open lightbox and follows choice changes from another language tab', () => {
    const view = start()
    const lightbox = view.source.cloneNode() as HTMLSourceElement
    view.page.body.append(lightbox)
    view.storageChange('dark')
    expect(lightbox.media).toBe('all')
    expect(view.button.getAttribute('aria-pressed')).toBe('true')
    view.storageChange('light', 'unrelated-setting')
    expect(lightbox.media).toBe('all')
    view.storageChange(null)
    expect(lightbox.media).toBe('not all')
    view.systemChange(true)
    expect(lightbox.media).toBe('all')
    view.storageChange('light')
    view.storageChange(null, null)
    expect(lightbox.media).toBe('all')
  })
})
