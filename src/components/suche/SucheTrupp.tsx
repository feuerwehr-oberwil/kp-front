import { appConfig } from '../../config/appConfig'
import s from './Suche.module.css'

/**
 * The Suche's areas under a Trupp's Ziel field (24.09.2026, E6 «Aus dem Trupp»): a pick fills
 * the Ziel with the area's own label («1. OG Trakt 3»), which the Suche then reads back as that
 * area (lib/useSucheTrupps). Typing stays as it always was — a NEW name creates the area.
 * Rendered by the Trupp form only under «Absuchen»; the form owns nothing else of the Suche.
 */
export function ZielChips({ choices, value, onPick }: { choices: readonly string[]; value: string; onPick: (v: string) => void }) {
  const C = appConfig.copy.suche
  return (
    <div className={s.zielChips} role="group" aria-label={C.zielChoices}>
      <span className={s.label}>{C.zielChoices}</span>
      <div className={s.chips}>
        {choices.map((c) => (
          <button key={c} type="button" className={s.chip} aria-pressed={value.trim() === c} onClick={() => onPick(c)}>{c}</button>
        ))}
      </div>
    </div>
  )
}
