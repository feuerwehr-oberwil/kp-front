import { Icon } from '../lib/icons'
import { cx } from '../lib/cx'

/**
 * THE ⓘ toggle — «show me what this means» (29.09.2026, sweep C2). A grey icon button, 36px to
 * the eye and 44px to the finger (`.ui-info`, 13-incident.css); OPEN is the blue wash with a
 * `--blue-strong` glyph, the «open / armed» look of the floating pieces. A disclosure is neither
 * a choice (the `--sel` fill) nor a place (the ink pill), and never the station red: the QR-Bogen's
 * ⓘ turned `--accent` while its help was open, and Georef filled it the choice blue.
 *
 * Inline vs. floating text stays with the host, as before. The dark tool docks keep their own
 * on-ink ⓘ (DockInfo) — a grey chip on a dark dock is not the same button there.
 */
export function InfoToggle({ open, onToggle, label, title, className }: {
  open: boolean
  onToggle: () => void
  /** the accessible name — what the help explains */
  label: string
  /** tooltip, if it differs from the name */
  title?: string
  /** placement only (margin, order) — never a skin */
  className?: string
}) {
  return (
    <button
      type="button" className={cx('ui-info', open && 'on', className)}
      aria-expanded={open} aria-label={label} title={title ?? label}
      onClick={onToggle}
    ><Icon id="info" /></button>
  )
}
