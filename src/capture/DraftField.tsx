// The capture page's debounced text field (Angaben · Kontaktperson, Telefon, Kurzbericht).

import { useEffect, useRef, useState } from 'react'
import { stripUnprintable } from '../lib/format'
import { clearDraft, makeDebouncedFlush, restoreDraft, saveDraft } from '../lib/captureDraft'

// Text fields save on blur AND ~1s after typing pauses, plus a sessionStorage draft per
// incident+field — a phone lock mid-sentence must not lose the Kurzbericht. The draft clears
// once the server accepted the text; a restored draft is unsaved by definition (drafts clear
// on success), so it flushes right after mount.
export function DraftField({ incidentId, field, saved, commit, textarea, number, tel, className, placeholder, ariaLabel, autoCapitalize, enterKeyHint }: {
  incidentId: string
  field: string
  /** current server value ('' = unset) */
  saved: string
  /** flush the raw text; resolves true when the server (or a no-op) accepted it */
  commit: (raw: string) => Promise<boolean>
  textarea?: boolean
  number?: boolean
  tel?: boolean
  className: string
  placeholder: string
  ariaLabel: string
  autoCapitalize?: string
  enterKeyHint?: 'done' | 'search'
}) {
  const [text, setText] = useState(() => restoreDraft(sessionStorage, incidentId, field, saved))
  const commitRef = useRef(commit)
  useEffect(() => { commitRef.current = commit }) // the flusher outlives renders — call the fresh closure
  const [flusher] = useState(() => makeDebouncedFlush<string>(1000, async (raw) => {
    if (await commitRef.current(raw)) clearDraft(sessionStorage, incidentId, field)
  }))
  useEffect(() => {
    if (text !== saved) flusher.push(text) // restored draft → persist it
    return () => { void flusher.flushNow() } // unmount (accordion collapse) must not drop text
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const onChange = (raw: string) => {
    // one guard for every free-text field the poster owns (Kurzbericht, Bemerkungen,
    // Bildlegenden): the rapport is set in Helvetica and prints an emoji as a black box —
    // lib/format · stripUnprintable
    const v = stripUnprintable(raw)
    setText(v)
    saveDraft(sessionStorage, incidentId, field, v)
    flusher.push(v)
  }
  const shared = {
    className, placeholder, value: text, 'aria-label': ariaLabel,
    onBlur: () => { void flusher.flushNow() },
  }
  if (textarea) {
    return <textarea {...shared} rows={3} autoCapitalize={autoCapitalize} enterKeyHint={enterKeyHint}
      onChange={(e) => onChange(e.target.value)} />
  }
  return (
    <input {...shared} type={number ? 'number' : tel ? 'tel' : 'text'} min={number ? 0 : undefined}
      inputMode={number ? 'numeric' : tel ? 'tel' : undefined}
      autoCapitalize={autoCapitalize} autoCorrect="off" autoComplete="off" spellCheck={false}
      enterKeyHint={enterKeyHint} onChange={(e) => onChange(e.target.value)} />
  )
}
