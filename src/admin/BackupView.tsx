import { useConfig } from './ConfigContext'
import { Card, EmptyState } from './ui'
import { ConfigBackup } from './ConfigBackup'
import { ConfigHistory } from './ConfigHistory'
import { appConfig } from '../config/appConfig'

// System › Sicherung. Reuses the loaded config document from ConfigContext as the export
// source; an import re-seeds every Station page through applyServerConfig.
export function BackupView() {
  const { draft, applyServerConfig } = useConfig()
  const C = appConfig.copy.admin
  const cfg = draft
  // Single-card page — the page head (h1 + lede) already names it, so the Card is a plain
  // panel (no title) to avoid a duplicate heading. The caption is the CARD's, so it renders in
  // the header at the same offset as every other captioned card, not as the first body child.
  return (
    <div className="adm-editor">
      <Card caption={C.backup.caption}>
        {cfg
          ? <ConfigBackup config={cfg} onImported={applyServerConfig} />
          : <EmptyState message={C.common.configLoading} />}
      </Card>
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
