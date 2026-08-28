import { useRef, useState } from 'react'
import { apiUpload, apiDelete, ApiError } from '../lib/api'
import { appConfig } from '../config/appConfig'
import type { DeploymentConfig, DeploymentAssets } from '../lib/deploymentConfig'
import { ConfirmButton } from './ui'

// Logo + favicon uploads (Batch A · A2). Each slot shows a live preview of the current
// asset, an upload control, and a remove action. On any change the parent is handed the
// fresh config projection so it can re-seed the editor and re-apply branding live.

type Slot = 'logo' | 'favicon' | 'reportLogo' | 'iconPng192' | 'iconPng512'

const ACCEPT = 'image/svg+xml,image/png,image/jpeg,image/webp,image/x-icon,.ico,.svg,.png,.jpg,.jpeg,.webp'

// The install icons go into a manifest that declares them `image/png` at a fixed size, so
// the picker offers only PNG here (the backend checks the bytes and the dimensions too).
const ACCEPT_PNG = 'image/png,.png'

// The build-time default both slots fall back to when no asset is uploaded — the app's bundled
// brandmark, matching the LoginScreen logo fallback and the index.html favicon.
const DEFAULT_ASSET = '/favicon.svg'

function BrandingSlot({ slot, label, hint, url, accept = ACCEPT, onApplied }: {
  slot: Slot
  label: string
  hint: string
  url: string | null | undefined
  /** file-picker filter; the install-icon slots narrow it to PNG */
  accept?: string
  onApplied: (cfg: DeploymentConfig) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const C = appConfig.copy.admin.branding

  const onPick = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const cfg = await apiUpload<DeploymentConfig>(`/api/branding/${slot}`, form)
      onApplied(cfg)
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.detail : C.uploadFailed)
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = '' // allow re-picking the same file
    }
  }

  // ⚠️ No `window.confirm()`. An installed iOS PWA may suppress one without a trace, and a
  // suppressed confirm returns false — so the button simply did nothing, for ever, on the device
  // the Verwaltung is most often opened from. The ask is `ConfirmButton` (admin/ui) like the rest
  // of the shell; the heavier Sheet is reserved for the full-document writes (ConfigBackup).
  const onRemove = async () => {
    setBusy(true)
    setError(null)
    try {
      const cfg = await apiDelete<DeploymentConfig>(`/api/branding/${slot}`)
      onApplied(cfg)
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.detail : C.removeFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="adm-field">
      <span className="adm-field-label">
        {label}
        <span className="adm-field-hint">{hint}</span>
      </span>
      <div className="adm-brand-row">
        <span className="adm-brand-preview" aria-hidden>
          <img src={url || DEFAULT_ASSET} alt="" className="adm-brand-img" />
        </span>
        {!url && <span className="adm-brand-default">{C.usingDefault}</span>}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="adm-brand-file"
          disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPick(f) }}
        />
        <button type="button" className="btn adm-int-btn" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? C.uploading : C.upload}
        </button>
        {url && (
          <ConfirmButton label={C.remove} question={C.removeConfirm} disabled={busy}
            onConfirm={() => void onRemove()} />
        )}
      </div>
      {error && <span className="adm-save-err">{error}</span>}
    </div>
  )
}

export function BrandingFields({ assets, onApplied }: {
  assets: DeploymentAssets | null | undefined
  onApplied: (cfg: DeploymentConfig) => void
}) {
  const C = appConfig.copy.admin.branding
  return (
    <>
      <BrandingSlot
        slot="logo"
        label={C.logo}
        hint={C.logoHint}
        url={assets?.logo}
        onApplied={onApplied}
      />
      {/* Its own slot, not a reuse of the logo: the app's brandmark is read on a screen at a
          glance, the rapport's on paper by a Gemeinde or a Versicherung — and a mark carrying
          the station's full name reads badly in a header but right on a letterhead. Falls back
          to the logo above when empty, so one upload is still enough. */}
      <BrandingSlot
        slot="reportLogo"
        label={C.reportLogo}
        hint={C.reportLogoHint}
        url={assets?.reportLogo}
        onApplied={onApplied}
      />
      <BrandingSlot
        slot="favicon"
        label={C.favicon}
        hint={C.faviconHint}
        url={assets?.favicon}
        onApplied={onApplied}
      />
      {/* The installed PWA's home-screen icon. Served through the per-deployment
          /manifest.webmanifest (backend/app/webmanifest.py) together with appName and the
          accent colour — the last surface that was still ours rather than the station's. */}
      <BrandingSlot
        slot="iconPng192"
        label={C.appIcon192}
        hint={C.appIcon192Hint}
        url={assets?.iconPng192}
        accept={ACCEPT_PNG}
        onApplied={onApplied}
      />
      <BrandingSlot
        slot="iconPng512"
        label={C.appIcon512}
        hint={C.appIcon512Hint}
        url={assets?.iconPng512}
        accept={ACCEPT_PNG}
        onApplied={onApplied}
      />
      <p className="adm-card-cap">
        {C.iconsNote}
      </p>
    </>
  )
}
