import s from './RetryButton.module.css'

/**
 * «Erneut laden» on a placeholder that is still loading or has failed — the in-app way out of a
 * stuck asset, so nobody has to reload the whole app mid-Einsatz to get a plan back.
 *
 * `label` is passed in rather than read here: the PDF placeholders and the OSM outline say it in
 * their own copy keys, and this component owns the look and the tap target, not the words.
 *
 * ⚠️ The press stops at the button. These placeholders sit ON the Plan board, whose pan gesture
 * captures the pointer on `pointerdown` (useBoardGestures · panDown) — the release and the click
 * then land on the board, never here. The tap did nothing at all, so a stuck «Gebäudeumrisse
 * werden geladen …» could only be left by reloading the app (sweep 30.10.2026, #11).
 */
export function RetryButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={s.retry} onPointerDown={(e) => e.stopPropagation()} onClick={onClick}>{label}</button>
  )
}
