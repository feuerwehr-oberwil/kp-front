import { useState } from 'react'
import type { ShareLinkKind } from './viewLink'

/** Transient open-state for the workspace's overlays, popovers and sheets — none of it
 *  synced, all of it purely local UI. Grouped here to keep the workspace component's state
 *  list focused on operational data: the views popover, symbol palette, and the one-off
 *  modal sheets (Einstellungen, Objekt-Picker, Hilfe, Installations-Guide,
 *  Offline-Bereitschaft). The Rapport is NOT one of them — it is a rail surface (`mode`).
 *
 *  The layers `panel` stays in the workspace component: it's cleared alongside the tactical
 *  gesture state (enterReplay, the tool-change effect), so it lives next to that state. */
export function useSheets() {
  const [viewsOpen, setViewsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [installGuideOpen, setInstallGuideOpen] = useState(false)
  const [offlineReadyOpen, setOfflineReadyOpen] = useState(false)
  /** «Weitergeben» — the Einsatz-Link + QR. Not a boolean: which KIND the sheet opens on is
   *  part of the door, not a setting inside it. The Einsatz-Karte means «Ganzer Einsatz»
   *  ('view'), the QR beside the Atemschutz bell means «Nur Atemschutz» ('atemschutz'), and
   *  `null` is closed. */
  const [shareLink, setShareLink] = useState<ShareLinkKind | null>(null)
  return {
    viewsOpen, setViewsOpen,
    paletteOpen, setPaletteOpen,
    settingsOpen, setSettingsOpen,
    pickerOpen, setPickerOpen,
    helpOpen, setHelpOpen,
    installGuideOpen, setInstallGuideOpen,
    offlineReadyOpen, setOfflineReadyOpen,
    shareLink, setShareLink,
  }
}
