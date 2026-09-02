import s from './RetryButton.module.css'

/**
 * «Erneut laden» on a placeholder that is still loading or has failed — the in-app way out of a
 * stuck asset, so nobody has to reload the whole app mid-Einsatz to get a plan back.
 *
 * `label` is passed in rather than read here: the PDF placeholders and the OSM outline say it in
 * their own copy keys, and this component owns the look and the tap target, not the words.
 */
export function RetryButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={s.retry} onClick={onClick}>{label}</button>
  )
}
