import { useEffect } from 'react'
import { appConfig } from '../config/appConfig'
import { armOnAnyTap } from './alarm'
import { layerOpen } from './overlays/layer'
import { toast } from './ui'

/**
 * The first tap anywhere arms the alarm tone (owner pick UX journeys M·3, 25.11.2026 –
 * lib/alarm · armOnAnyTap), and «Alarmton an» says it happened – only while no layer is open
 * (overlays/layer · layerOpen): a tap that opened a sheet or the composer gets no pill over it
 * (F8). App mounts it with `enabled` = somebody is signed in: the PIN pad's taps are no place
 * for that toast.
 */
export function useArmOnAnyTap(enabled: boolean): void {
  useEffect(() => (enabled ? armOnAnyTap(() => {
    if (!layerOpen()) toast(appConfig.copy.karte.device.alarm.toneArmed, { icon: 'bell' })
  }) : undefined), [enabled])
}
