import { useConfig } from './ConfigContext'
import { Card, EmptyState, SettingsNote, SettingsSheet } from './ui'
import { ConfigBackup } from './ConfigBackup'
import { ConfigHistory } from './ConfigHistory'
import { appConfig } from '../config/appConfig'

// System › Sicherung. Reuses the loaded config document from ConfigContext as the export
// source; an import re-seeds every Station page through applyServerConfig.
export function BackupView() {
  const { draft, applyServerConfig } = useConfig()
  const C = appConfig.copy.admin
  const cfg = draft
  // The export/import block is a SHEET of settings rows — «Letzte Änderung» and «Konfiguration»
  // — not prose with two buttons under it (ConfigBackup renders the rows). The page head (h1 +
  // lede) already names the page, so the sheet carries no title of its own; its caption is the
  // sentence that used to stand above the buttons.
  return (
    <div className="adm-editor">
      <SettingsSheet caption={C.backup.caption}>
        {cfg
          ? <ConfigBackup config={cfg} onImported={applyServerConfig} />
          : <SettingsNote><EmptyState message={C.common.configLoading} /></SettingsNote>}
      </SettingsSheet>
      {/* The kept configurations, under the file export they belong with: both answer «how do I
          get the old one back». Until now this page offered only the half that requires having
          thought ahead — the history is the half that works after the fact, and it was
          reachable only over SSH. */}
      <Card title={C.backup.histTitle} caption={C.backup.histCaption}>
        <ConfigHistory onRestored={applyServerConfig} />
      </Card>
    </div>
  )
}
