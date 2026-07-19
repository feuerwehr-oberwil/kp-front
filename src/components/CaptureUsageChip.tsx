import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

/** Cross-visibility QR → KP: informational chip on the QR-writable surfaces (Anwesenheit,
 *  Mittel, Einsatzrapport) — «QR: N Einträge · zuletzt HH:MM» tells the tablet operator the
 *  poster self-reporting is in use, so nobody needs paper sheets. Renders nothing until the
 *  first QR write; deliberately NOT shown in the incident status/dropdown area. */
export interface CaptureUsage {
  writes: number
  lastAt: string | null
}

export function CaptureUsageChip({ usage }: { usage?: CaptureUsage | null }) {
  if (!usage || usage.writes <= 0) return null
  const C = appConfig.copy.capture
  const d = usage.lastAt ? new Date(usage.lastAt) : null
  const t = d && Number.isFinite(d.getTime())
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : '—'
  const text = usage.writes === 1
    ? fillTemplate(C.usageChipOne, { t })
    : fillTemplate(C.usageChip, { n: usage.writes, t })
  return <span className="capture-usage-chip">{text}</span>
}
