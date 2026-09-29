import { appConfig } from '../../config/appConfig'
import s from './Suche.module.css'

/**
 * The Suche's areas under a Trupp's Ziel field (24.09.2026, E6 «Aus dem Trupp»): a pick fills
 * the Ziel with the area's own label («1. OG Trakt 3»), which the Suche then reads back as that
 * area (lib/useSucheTrupps) when the Auftrag is «Absuchen». Typing stays as it always was — a NEW
 * name creates the area.
 * ⚠️ SHORTCUTS, never answers (29.09.2026, sweep 3 T12): a pick fills the field and the chip is
 * never drawn as chosen — the field holds the answer, and «2. OG ✕» over a filled «2. OG» chip was
 * one answer shown by two controls. The same row under the same condition on the Trupp form and
 * the Auftrag sheet (every Auftrag), and no label of its own: «Ziel» over the field already says
 * what the chips fill (the sheet's `bare`, 27.09.2026, is now the only look).
 */
export function ZielChips({ choices, onPick }: { choices: readonly string[]; onPick: (v: string) => void }) {
  const C = appConfig.copy.suche
  return (
    <div className={s.zielChips} role="group" aria-label={C.zielChoices}>
      <div className={s.chips}>
        {choices.map((c) => (
          <button key={c} type="button" className={s.chip} onClick={() => onPick(c)}>{c}</button>
        ))}
      </div>
    </div>
  )
}
