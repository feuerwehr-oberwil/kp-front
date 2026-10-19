/** The place pin: red, with a white rim and eye, its tip at the bottom centre of a 34 × 44 box.
 *  Used for a dropped pin on the Karte (components/karte) and on the Objektbesuch place card's
 *  mini map (objectVisits/PlaceCard). The caller's `className` sizes and places it. White, not
 *  `--surface`: it is map furniture and keeps its rim on the night map. */
export function MapPin({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 34 44" aria-hidden>
      <path d="M17 43C17 43 3 26 3 16a14 14 0 0 1 28 0c0 10-14 27-14 27z" style={{ fill: 'var(--red)' }} stroke="#fff" strokeWidth="2.5" />
      <circle cx="17" cy="16" r="5" fill="#fff" />
    </svg>
  )
}
