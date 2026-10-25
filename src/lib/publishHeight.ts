/**
 * A ref callback that keeps its element's height on `:root` as the custom property `name` (in px)
 * while the element is mounted, and removes it on unmount (React 19 runs the returned cleanup).
 * For a floating card the toast lane has to stand under (08-toasts · `.toaster`). Create it once
 * at module level – a new callback per render would re-run the observer each time.
 */
export function publishHeight(name: string): (el: HTMLElement | null) => (() => void) | undefined {
  return (el) => {
    if (!el) return
    const root = document.documentElement.style
    const put = () => root.setProperty(name, `${Math.ceil(el.getBoundingClientRect().height)}px`)
    put()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(put)
    ro?.observe(el)
    return () => { ro?.disconnect(); root.removeProperty(name) }
  }
}
