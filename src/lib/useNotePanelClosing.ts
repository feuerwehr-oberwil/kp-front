import { useEffect } from 'react'

interface NotePanelClosing<T extends string> {
  selectedId: string | null
  tool: T
  /** the surface's rest tool (`'select'` on the Karte, `'pan'` on the Plan) */
  rest: T
  notePanelId: string | null
  setNotePanelId: (id: string | null) => void
  notePlacedId: string | null
  setNotePlacedId: (id: string | null) => void
}

/** When a note's detail panel closes on its own — the same three rules on the Karte
 *  (useMapActions) and the Plan (Whiteboard), which each own the panel state itself. */
export function useNotePanelClosing<T extends string>({ selectedId, tool, rest, notePanelId, setNotePanelId, notePlacedId, setNotePlacedId }: NotePanelClosing<T>) {
  // the panel belongs to the SELECTED note: deselecting (empty map, Esc, picking something
  // else) closes it too, so a stray panel can never outlive the thing it describes
  useEffect(() => { if (notePanelId && selectedId !== notePanelId) setNotePanelId(null) }, [selectedId, notePanelId, setNotePanelId])
  // reaching for a tool means you are done reading this note — the panel should not sit there
  // while you place the next thing (selection alone doesn't change until that thing lands)
  useEffect(() => { if (tool !== rest) setNotePanelId(null) }, [tool, rest, setNotePanelId])
  // the «just placed» mark lives exactly as long as that panel does
  useEffect(() => { if (notePlacedId && notePanelId !== notePlacedId) setNotePlacedId(null) }, [notePanelId, notePlacedId, setNotePlacedId])
}
