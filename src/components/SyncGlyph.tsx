/**
 * The sync glyph: one SVG that spins as an open arc and then closes into a full ring with a
 * tick drawn through it. Deliberately ONE element rather than a spinner swapped for a check —
 * the ring is the same circle throughout, so the eye follows it from "working" to "done"
 * instead of seeing two unrelated icons flash past.
 *
 * The house "this ran and it worked" vocabulary: «Jetzt synchronisieren» (IncidentSwitcher),
 * the Offline-Bereitschaft load, the Anwesenheit roster reload. Styles live in
 * src/styles/13-incident.css (.sync-glyph/.sync-ring/.sync-tick), including the
 * prefers-reduced-motion branch that keeps the states but drops the motion.
 *
 * The circle is r=9 → circumference ≈ 56.5; the dash values in .sync-ring/.sync-tick are cut
 * to that, so changing the radius means re-cutting them.
 */
export function SyncGlyph({ done, label }: { done: boolean; label: string }) {
  return (
    <svg className={`sync-glyph${done ? ' on' : ''}`} viewBox="0 0 24 24" role="img" aria-label={label}>
      <circle className="sync-ring" cx="12" cy="12" r="9" />
      <path className="sync-tick" d="M7.8 12.4l2.9 2.9 5.6-6.1" />
    </svg>
  )
}
