import { useEffect, useState } from 'react'

// True on phone-sized screens (≤ 600px). On phones the app is a live VIEWER + field
// capture: the tactical editing tools are locked (see `tacticalLocked` in App), but a
// editor can still view the live Lage and add journal entries / photos / voice memos.
// Reactive to resize + orientation change.
const QUERY = '(max-width: 600px)'

export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(QUERY).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(QUERY)
    const on = () => setIsPhone(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return isPhone
}
