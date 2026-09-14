// Per-device «seen it» flag for the plan surface's nearby-object banner (Whiteboard ·
// nearbyBanner). The banner says once per Einsatz that the surfaced Einsatzplan belongs to the
// NEAREST object, not to the Einsatzadresse; after ✕ only the amber object chip keeps saying so.
// A tiny device hint, not operational state – so localStorage, mirroring kp.demo.welcomed.
const KEY = 'kp.plan.nearbyBannerDismissed'

/** The key one banner is remembered under: this Einsatz, this surfaced object. */
export const nearbyBannerKey = (incidentId: string, objectId: string) => `${incidentId}:${objectId}`

const read = (): string[] => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[] } catch { return [] }
}

export function nearbyBannerDismissed(key: string): boolean {
  return read().includes(key)
}

/** Remember the ✕ – keeps the last 50 keys so the list never grows without bound. */
export function dismissNearbyBanner(key: string): void {
  try {
    const keys = [...read().filter((k) => k !== key), key].slice(-50)
    localStorage.setItem(KEY, JSON.stringify(keys))
  } catch { /* private mode / storage disabled → the banner simply shows again */ }
}
