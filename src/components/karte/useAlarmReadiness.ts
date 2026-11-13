// The facts «Alarm auf diesem Gerät» is judged on (karte/AlarmReadiness rows, the Einstellungen'
// «Dieses Gerät» summary – panels/SettingsSheet · DeviceSection): re-read whenever something that
// moves them happens. The rules themselves are lib/alarmReadiness.

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../lib/auth'
import { getInstallPlatform, isStandalone, onInstallStateChange } from '../../lib/installPrompt'
import { onReadinessStore, readReadinessStore, readinessRows, type ReadinessStore } from '../../lib/alarmReadiness'
import { pushAvailable } from '../../lib/push'

export const permissionNow = (): NotificationPermission | 'unsupported' =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission

/** The facts, re-read whenever something that moves them happens: the device record, the
 *  install state, the page coming back (the person may have allowed notifications in the
 *  system settings meanwhile), or a fix this surface ran. */
export function useAlarmReadiness() {
  const { user } = useAuth()
  // the clock the rows are judged against — moved on every re-read, never read in render
  const [now, setNow] = useState(() => Date.now())
  const refresh = useCallback(() => setNow(Date.now()), [])
  const [store, setStore] = useState<ReadinessStore>(readReadinessStore)
  const [available, setAvailable] = useState<boolean | null>(null)
  useEffect(() => onReadinessStore(() => { setStore(readReadinessStore()); refresh() }), [refresh])
  useEffect(() => onInstallStateChange(refresh), [refresh])
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh])
  useEffect(() => {
    let alive = true
    void pushAvailable().then((v) => { if (alive) setAvailable(v) })
    return () => { alive = false }
  }, [])
  const sessionUntil = user?.session_until ? new Date(user.session_until).getTime() : null
  const rows = readinessRows({
    now, standalone: isStandalone(), platform: getInstallPlatform(), permission: permissionNow(),
    subscribedAt: store.subscribedAt, sessionUntil: Number.isFinite(sessionUntil) ? sessionUntil : null,
  })
  return { now, rows, store, available, refresh, linkSession: !!user?.link_scoped }
}

