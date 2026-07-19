import { useConfig } from './ConfigContext'
import { Card } from './ui'
import { ConfigBackup } from './ConfigBackup'
import { appConfig } from '../config/appConfig'

// System › Sicherung. Reuses the loaded config document from ConfigContext as the export
// source; an import re-seeds every Station page through applyServerConfig.
export function BackupView() {
  const { draft, applyServerConfig } = useConfig()
  const C = appConfig.copy.admin
  const cfg = draft
  // Single-card page — the page head (h1 + lede) already names it, so the Card is a plain
  // panel (no title) to avoid a duplicate heading. The caption moves in as the intro line.
  return (
    <div className="adm-editor">
      <Card>
        <p className="adm-card-cap">{C.backup.caption}</p>
        {cfg
          ? <ConfigBackup config={cfg} onImported={applyServerConfig} />
          : <div className="adm-state">{C.common.configLoading}</div>}
      </Card>
    </div>
  )
}
