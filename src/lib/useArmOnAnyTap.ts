import { useEffect } from 'react'
import { appConfig } from '../config/appConfig'
import { armOnAnyTap } from './alarm'
import { toast } from './ui'

/**
 * The first tap anywhere arms the alarm tone (owner pick UX journeys M·3, 25.11.2026 –
 * lib/alarm · armOnAnyTap), and «Alarmton an» says it happened. App mounts it with `enabled` =
 * somebody is signed in: the PIN pad's taps are no place for that toast.
 */
export function useArmOnAnyTap(enabled: boolean): void {
  useEffect(() => (enabled ? armOnAnyTap(() => toast(appConfig.copy.karte.device.alarm.toneArmed, { icon: 'bell' })) : undefined), [enabled])
}
