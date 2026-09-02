import { appConfig } from '../config/appConfig'
import { useMeldung } from '../lib/useMeldung'

// Published while the session cookie has expired mid-Einsatz (lib/auth · sessionExpired, set by
// api.ts's SESSION_EXPIRED_EVENT on a 401 refresh). Until 02.09. every request failed silently
// behind a badge that said «wird erneut versucht», and the only way back was Einsatz-Menü →
// Abmelden → PIN — with nothing pointing there. The row says what is standing still and that
// nothing is lost; its one button IS the way back. No ✕: the message is true until the operator
// has signed in, and signing in is what withdraws it (auth · login clears the flag).
export function SessionExpiredMeldung({ onRelogin }: { onRelogin: () => void }) {
  // read per-render (not module-load) so the resolved locale is applied — see config/copy
  const C = appConfig.copy.session
  useMeldung({
    id: 'session',
    kind: 'session',
    tone: 'warn',
    icon: 'warn',
    title: C.expiredTitle,
    sub: C.expiredHint,
    actions: [{ label: C.relogin, icon: 'logout', primary: true, onClick: onRelogin }],
  })
  return null
}
