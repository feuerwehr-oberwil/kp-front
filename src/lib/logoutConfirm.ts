import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { confirmDialog } from './ui'

/**
 * «Abmelden» always asks (decided 23.09.2026, option C of the UX review).
 *
 * Signing out is the one act after which this device opens no Einsatz until somebody types a PIN
 * — and with no network, until the network is back, because a sign-in needs the server. It was
 * one tap in the Einsatz-Menü and on the launcher's identity row, next to rows that only open
 * things. So it confirms every time, with ONE card: offline and/or with something not yet sent,
 * the same card adds what that costs on top, rather than a second, rarer dialog nobody learns.
 *
 * ⚠️ Never offered on a link surface (AGENTS.md · «no link surface offers Abmelden») — callers
 * keep their own `linkScoped` gate; this only phrases the ask.
 */
export interface LogoutContext {
  /** `navigator.onLine` at the moment of the tap */
  online: boolean
  /** countable entries still waiting for the server (Verlauf rows, photos/voice memos) */
  unsyncedEntries: number
  /** the Einsatz itself has unsent changes that are not counted as entries (Karte, Pläne, lists) */
  unsyncedOther?: boolean
}

/** What the card says — pure, so the wording per situation is tested without a dialog. */
export function logoutAsk({ online, unsyncedEntries, unsyncedOther }: LogoutContext) {
  const C = appConfig.copy.incidentSwitcher
  const pending = unsyncedEntries === 1 ? C.logoutUnsyncedOne
    : unsyncedEntries > 1 ? fillTemplate(C.logoutUnsyncedMany, { n: unsyncedEntries })
      : unsyncedOther ? C.logoutUnsyncedChanges
        : ''
  const note = [online ? '' : C.logoutOffline, pending].filter(Boolean).join(' ')
  return {
    title: C.logoutTitle,
    message: C.logoutMsg,
    note: note || undefined,
    confirmLabel: C.logout,
    cancelLabel: appConfig.copy.confirm.cancel,
    // danger: the outline-red confirm, and the focus lands on «Abbrechen» (ConfirmCard)
    danger: true,
  }
}

/** Ask, and resolve `true` only when the operator confirmed. */
export function confirmLogout(ctx: LogoutContext): Promise<boolean> {
  return confirmDialog(logoutAsk(ctx))
}
