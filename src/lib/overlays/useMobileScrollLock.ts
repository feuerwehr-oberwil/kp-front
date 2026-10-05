import { useEffect } from 'react'
import { useIsPhone } from '../useIsPhone'

/** Trap touch scrolling in the open sheet and its portalled pickers, without making them inert. */
export function useMobileScrollLock(open: boolean) {
  const phone = useIsPhone()
  useEffect(() => {
    if (!open || !phone) return
    let x = 0, y = 0
    const start = (e: TouchEvent) => {
      x = e.touches[0]?.clientX ?? 0
      y = e.touches[0]?.clientY ?? 0
    }
    const move = (e: TouchEvent) => {
      const touch = e.touches[0]
      if (!touch || e.touches.length !== 1) return
      const dx = x - touch.clientX, dy = y - touch.clientY
      x = touch.clientX; y = touch.clientY
      const horizontal = Math.abs(dx) > Math.abs(dy)
      const delta = horizontal ? dx : dy
      const target = e.target instanceof Element ? e.target : null
      // The pickers portal beside the dialog, so they share its scrolling allowance.
      if (target?.closest('[role="dialog"], [role="menu"], [role="listbox"], .combo-menu')) {
        let node = target as HTMLElement | null
        while (node && node !== document.body) {
          const css = getComputedStyle(node)
          const overflow = horizontal ? css.overflowX : css.overflowY
          const pos = horizontal ? node.scrollLeft : node.scrollTop
          const max = horizontal ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight
          if (/(auto|scroll)/.test(overflow) && max > 0 && ((delta < 0 && pos > 0) || (delta > 0 && pos < max))) return
          node = node.parentElement
        }
      }
      if (e.cancelable) e.preventDefault()
    }
    document.addEventListener('touchstart', start, { passive: true })
    document.addEventListener('touchmove', move, { passive: false })
    return () => {
      document.removeEventListener('touchstart', start)
      document.removeEventListener('touchmove', move)
    }
  }, [open, phone])
}
