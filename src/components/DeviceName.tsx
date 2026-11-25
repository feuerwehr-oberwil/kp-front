import { useState } from 'react'
import { appConfig } from '../config/appConfig'
import { DEVICE_NAME_MAX, setDeviceName, skipDeviceNameAsk, useDeviceName } from '../lib/deviceName'
import { leaveOnEnter } from '../lib/fieldKeys'
import { Sheet } from '../lib/overlays'
import { Button } from './Button'

// «Name dieses Geräts» (owner pick UX journeys B3·47, 25.11.2026 – lib/deviceName): the field in the
// Einstellungen, and the one-time ask at the first login on a device.

/** The name as a one-line field that saves when it is left (Return, Esc or a tap elsewhere) – the
 *  Einstellungen' row. A plain `.ip-input`, not `ClearableInput`: a name is set once, not rewritten. */
export function DeviceNameField() {
  const cp = appConfig.copy.settings
  const { name } = useDeviceName()
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      className="ip-input set-device-name" type="text" autoComplete="off" maxLength={DEVICE_NAME_MAX}
      aria-label={cp.deviceName} placeholder={cp.deviceNamePlaceholder}
      value={draft ?? name ?? ''}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft != null && draft.trim() !== (name ?? '')) setDeviceName(draft); setDraft(null) }}
      onKeyDown={(e) => { leaveOnEnter(e) }}
    />
  )
}

/** The ask at the first login on a device: the name, or «Später» – either way never again (the
 *  Einstellungen still set it). Renders nothing once answered. Mounted by App on home only, never
 *  over an open Einsatz: a fresh tablet picked up for an alarm is not stopped by a form. */
export function DeviceNameAsk() {
  const cp = appConfig.copy.settings
  const { askOpen } = useDeviceName()
  const [draft, setDraft] = useState('')
  if (!askOpen) return null
  const save = () => { if (draft.trim()) setDeviceName(draft); else skipDeviceNameAsk() }
  return (
    <Sheet open fit onClose={skipDeviceNameAsk} title={cp.deviceName}
      footer={(
        <>
          <Button onClick={skipDeviceNameAsk}>{cp.deviceNameLater}</Button>
          <Button variant="primary" disabled={!draft.trim()} onClick={save}>{cp.deviceNameSave}</Button>
        </>
      )}>
      <p className="set-device-ask">{cp.deviceNameAskBody}</p>
      <input
        className="ip-input" type="text" autoComplete="off" maxLength={DEVICE_NAME_MAX} autoFocus
        aria-label={cp.deviceName} placeholder={cp.deviceNamePlaceholder}
        value={draft} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { e.preventDefault(); save() } }}
      />
    </Sheet>
  )
}
