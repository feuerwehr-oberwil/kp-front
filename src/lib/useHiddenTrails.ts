import { useState } from 'react'

/** Per-team trail visibility on one surface (MapView, Whiteboard): the marker ids whose trail is
 *  hidden this session, default all shown. The eye in a selected team's action bar hides only
 *  THAT team's trail — there is no global Spuren toggle — and the record itself is never touched. */
export function useHiddenTrails() {
  const [hiddenTrails, setHiddenTrails] = useState<ReadonlySet<string>>(new Set())
  const toggleTrail = (id: string) => setHiddenTrails((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  return { hiddenTrails, toggleTrail }
}
