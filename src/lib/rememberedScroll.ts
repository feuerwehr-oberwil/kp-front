import { useLayoutEffect, useRef } from 'react'

/* Where each list was left (05.10.2026, owner: «remember the checklist scroll position on closing
   an open checklist»). Per Einsatz and per list — the open checklist's pane and the picker each
   keep their own offset, so closing a list onto the picker and opening it again lands both where
   the reader was — the chooser above all («to quickly go through potentially similar checklists»:
   back from one list, the neighbouring one is right under the thumb). In memory only: it is a reading position for this session, not a
   record; a reload starts at the top. Module scope because the surface unmounts whenever another tab is
   shown (IncidentWorkspace · mode). Used by the Einsatz Checkliste (ChecklistsView, keys per Einsatz)
   and the Karte's Checkliste surface (ChecklistLibrary, `lib|…` keys). */
const scrollMemory = new Map<string, number>()
/** the scroller's offset under `key`: restored when the key (or the element) appears, saved on
 *  every scroll. The returned ref goes on the element that scrolls. */
export function useRememberedScroll<T extends HTMLElement>(key: string | null) {
  const ref = useRef<T>(null)
  // what was last restored: only a NEW element or a NEW key puts the offset back — a tick
  // re-renders the pane and must not jump it
  const restored = useRef<{ node: T | null; key: string | null }>({ node: null, key: null })
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || key === null) return
    if (restored.current.node !== node || restored.current.key !== key) {
      node.scrollTop = scrollMemory.get(key) ?? 0
      restored.current = { node, key }
    }
    const save = () => scrollMemory.set(key, node.scrollTop)
    node.addEventListener('scroll', save, { passive: true })
    return () => node.removeEventListener('scroll', save)
  })
  return ref
}
