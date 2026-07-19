import { useEffect, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import {
  canPromptNative, getInstallPlatform, isInstalled, isStandalone,
  onInstallStateChange, promptNativeInstall,
} from '../lib/installPrompt'

// Platform-detected "Als App installieren" guide: shows ONLY the steps for THIS device
// (recognition over recall) — a real one-tap install button where the browser exposes the
// API (Chromium's beforeinstallprompt), written share-sheet/menu steps everywhere else (iOS
// has no install API at all). Opened from the InstallBanner or the IncidentSwitcher menu.

/** '{share}' in a step renders the iOS share glyph inline — the operator matches the SHAPE
 *  in the toolbar, not a described word. */
function renderStep(step: string) {
  return step.split('{share}').flatMap((part, i) =>
    i === 0 ? [part] : [<Icon key={i} id="share-ios" />, part])
}

export function InstallGuide({ onClose }: { onClose: () => void }) {
  const [, bump] = useState(0)
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState(false)
  useEffect(() => onInstallStateChange(() => bump((v) => v + 1)), [])

  const C = appConfig.copy.install
  const platform = getInstallPlatform()
  const guide = platform === 'ios' ? C.ios
    : platform === 'android' ? C.android
    : platform === 'desktop-chromium' ? C.desktop
    : platform === 'mac-safari' ? C.macSafari
    : null

  const onNative = async () => {
    setBusy(true)
    try {
      if (await promptNativeInstall() === 'accepted') setAccepted(true)
    } finally { setBusy(false) }
  }

  return (
    <div className="ip-ovl" onClick={onClose}>
      <div className="ip-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="ip-head">
          <h2>{C.title}</h2>
          <button className="ip-x" onClick={onClose} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
        </div>
        <div className="ip-body">
          {isStandalone() || isInstalled() || accepted ? (
            <div className="ig-done"><Icon id="check" /> {accepted || isInstalled() ? C.installed : C.alreadyStandalone}</div>
          ) : (
            <>
              <p className="ig-why">{C.why}</p>
              {guide == null ? (
                <p className="ig-note">{C.unsupported}</p>
              ) : (
                <>
                  {canPromptNative() && (
                    <>
                      <button className="ig-install" onClick={() => { void onNative() }} disabled={busy}>
                        <Icon id="snapshot" /> {C.nativeButton}
                      </button>
                      <p className="ig-native-hint">{C.nativeHint}</p>
                      <div className="ig-or">{C.manualIntro}</div>
                    </>
                  )}
                  <p className="ig-intro">{guide.intro}</p>
                  <ol className="ig-steps">
                    {guide.steps.map((s, i) => <li key={i}><span className="ig-step-text">{renderStep(s)}</span></li>)}
                  </ol>
                  {guide.note && <p className="ig-note">{guide.note}</p>}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
