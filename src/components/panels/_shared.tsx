// Shared primitives for the incident panels: the Modal shell + two formatting/coord
// helpers used by more than one panel. Split out of the former IncidentPanels.tsx.
import { Sheet } from '../../lib/overlays'

// `fit` = height hugs the content (capped), for short one-off modals that would otherwise
// leave a big empty bottom in the uniform 800px frame. Backed by the shared <Sheet> primitive
// (Base UI Dialog + focus trap/restore/scroll-lock), so every consumer gets that for free.
export function Modal({ title, onClose, children, wide, fit }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean; fit?: boolean }) {
  return (
    <Sheet open onClose={onClose} title={title} wide={wide} fit={fit}>
      {children}
    </Sheet>
  )
}

export function fmtWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

/** 0/0 = "no location" (Divera's convention; legacy rows stored it verbatim) — treat it
 *  like a missing coordinate everywhere, so the wizard/banner fall back to the address
 *  geocoder and the deployment's default view instead of pinning Null Island. */
export function realCoord(lng?: number | null, lat?: number | null): [number, number] | null {
  return lng != null && lat != null && (lng !== 0 || lat !== 0) ? [lng, lat] : null
}
