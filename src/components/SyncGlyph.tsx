import { ShellLoader } from './ShellLoader'

/** Shared sync activity and success states. The busy trail gives way to the existing tick;
 *  the surrounding control keeps the same label and geometry throughout. */
export function SyncGlyph({ done, label }: { done: boolean; label: string }) {
  if (!done) return <span className="sync-glyph" role="img" aria-label={label}><ShellLoader /></span>
  return (
    <svg className="sync-glyph on" viewBox="0 0 24 24" role="img" aria-label={label}>
      <circle className="sync-ring" cx="12" cy="12" r="9" />
      <path className="sync-tick" d="M7.8 12.4l2.9 2.9 5.6-6.1" />
    </svg>
  )
}
