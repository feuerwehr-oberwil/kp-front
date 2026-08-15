import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

/**
 * A list of words, edited as chips — Partnerorganisationen, Mittel-Einheiten, the options of a
 * Fahrzeug-Attribut. All of them are `list[str]` in the config document, and until now all of
 * them needed a JSON file and a terminal to change: a Wehr could not add one partner
 * organisation from the browser.
 *
 * Chips rather than rows because the entries are short and the ORDER is the printed order (the
 * Ankreuz-Zeile on the Rapport and on the paper Erfassungsblatt), so seeing them on one line is
 * seeing what the sheet will look like. Enter adds; there is no save button because every page
 * that uses this already carries the autosave status.
 *
 * ⚠️ Duplicates and blanks are dropped on the way in rather than rejected with a message. This
 * is a tick-off list, not a data model: «Polizei» twice is a slip with one obvious intent, and
 * an error state for it would be ceremony over a non-problem.
 */
export function StringList({ value, onChange, ariaLabel, placeholder }: {
  value: string[]
  onChange: (next: string[]) => void
  ariaLabel: string
  placeholder?: string
}) {
  const C = appConfig.copy.admin.stringList
  const [draft, setDraft] = useState('')

  const add = () => {
    const v = draft.trim()
    if (!v) return
    // case-insensitive, because «polizei» and «Polizei» are the same row on a printed sheet
    if (!value.some((x) => x.trim().toLowerCase() === v.toLowerCase())) onChange([...value, v])
    setDraft('')
  }

  return (
    <div className="adm-slist" role="group" aria-label={ariaLabel}>
      {value.map((item, i) => (
        <span className="adm-slist-item" key={`${item}-${i}`}>
          {item}
          <button
            type="button" className="adm-slist-x"
            aria-label={fillTemplate(C.removeItem, { item })}
            title={fillTemplate(C.removeItem, { item })}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="adm-slist-add"
        value={draft}
        placeholder={placeholder ?? C.addPlaceholder}
        aria-label={placeholder ?? C.addPlaceholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add() }
          // ⚠️ Backspace on an EMPTY field removes the last chip — the behaviour every chip
          // input has, and its absence reads as a broken field rather than as a missing feature.
          if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
        }}
        // …and a value typed but never confirmed is still meant: committing on blur is what
        // stops «I typed it and it vanished» after a click on another field.
        onBlur={add}
      />
    </div>
  )
}
