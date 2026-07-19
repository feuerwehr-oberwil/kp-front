import { useRef, useState } from 'react'
import { apiUpload, apiDelete, ApiError } from '../lib/api'
import { appConfig } from '../config/appConfig'
import type { DeploymentConfig, DeploymentAssets } from '../lib/deploymentConfig'

// Logo + favicon uploads (Batch A · A2). Each slot shows a live preview of the current
// asset, an upload control, and a remove action. On any change the parent is handed the
// fresh config projection so it can re-seed the editor and re-apply branding live.

type Slot = 'logo' | 'favicon'

const ACCEPT = 'image/svg+xml,image/png,image/jpeg,image/webp,image/x-icon,.ico,.svg,.png,.jpg,.jpeg,.webp'

// The build-time default both slots fall back to when no asset is uploaded — the app's bundled
// brandmark, matching the LoginScreen logo fallback and the index.html favicon.
const DEFAULT_ASSET = '/favicon.svg'

function BrandingSlot({ slot, label, hint, url, onApplied }: {
  slot: Slot
  label: string
  hint: string
  url: string | null | undefined
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

  const onRemove = async () => {
    if (!window.confirm(C.removeConfirm)) return
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
          accept={ACCEPT}
          className="adm-brand-file"
          disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPick(f) }}
        />
        <button type="button" className="btn adm-int-btn" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? C.uploading : C.upload}
        </button>
        {url && (
          <button type="button" className="btn adm-int-btn" disabled={busy} onClick={() => void onRemove()}>
            {C.remove}
          </button>
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
      <BrandingSlot
        slot="favicon"
        label={C.favicon}
        hint={C.faviconHint}
        url={assets?.favicon}
        onApplied={onApplied}
      />
      <p className="adm-card-cap">
        {C.iconsNote}
      </p>
    </>
  )
}
