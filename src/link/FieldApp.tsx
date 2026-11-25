import { Suspense, lazy } from 'react'
import { Splash } from '../components/Splash'

const App = lazy(() => import('../App'))

/**
 * The field app on a link page, loaded only when the page mounts it – after the exchange opened a
 * session (LinkApp) or a terminal picked its Einsatz (StandingApp). Imported statically, the
 * ~2 MB field bundle held up an expired link's message and a terminal's standby screen (hunt
 * 24.11.2026, performance F3).
 */
export function FieldApp() {
  return <Suspense fallback={<Splash />}><App /></Suspense>
}
