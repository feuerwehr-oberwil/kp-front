import { createContext, useContext, useEffect } from 'react'

/** One part of «Dieses Gerät» as the Einstellungen' summary row reads it (SettingsSheet ·
 *  DeviceSection): green, a hint, or the operator is needed. */
export type DevicePartState = 'ok' | 'warn' | 'red'

/** What the Offline part of «Dieses Gerät» reports up to the sheet that folds it – the probing
 *  readiness block (OfflineReadiness in an Einsatz, KarteDeviceRows on home) is the caller's, so
 *  the state travels by context rather than through every caller. Outside the sheet: a no-op. */
export const OfflineStateContext = createContext<(s: DevicePartState) => void>(() => {})

/** Report the Offline part's state once it is known (null while still probing). */
export function useReportOfflineState(state: DevicePartState | null): void {
  const report = useContext(OfflineStateContext)
  useEffect(() => { if (state) report(state) }, [state, report])
}
