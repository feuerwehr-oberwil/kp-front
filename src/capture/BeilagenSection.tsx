// «Beilagen» on the capture page.
// the photos that belong to the RAPPORT — an Ausweis, a Schaden. The poster is where
// the paperwork gets done, so this is where they are added; they print at the end of
// the Rapport, large enough to read (backend/app/report). Only photos, only this
// Einsatz — see the capture router's key set.

import { appConfig } from '../config/appConfig'
import { fillTemplate, stripUnprintable } from '../lib/format'
import { Icon } from '../lib/icons'
import { ShellLoader } from '../components/ShellLoader'
import type { Workspace } from '../lib/incidents'
import type { CaptureAction } from '../lib/captureClient'
import { AccSection } from './AccSection'


/** the shell's wiring for one section (CaptureApp owns which one is open) */
type Shell = { open: boolean; onToggle: () => void; sectionRef: (el: HTMLElement | null) => void }

type Props = Shell & {
  busy: boolean
  attachments: { id: string; url: string; caption?: string }[]
  /** a batch upload is running (CaptureApp · addBeilagen) */
  uploading: boolean
  addBeilagen: (files: File[]) => Promise<void>
  run: (action: CaptureAction) => Promise<Workspace | null>
  savedToast: () => void
}

/** The Beilagen section: the photos with their captions, and the picker. */
export function BeilagenSection({ open, onToggle, sectionRef, busy, attachments, uploading, addBeilagen, run, savedToast }: Props) {
  const C = appConfig.copy.capture
  return (
    <AccSection open={open} label={C.beilagenHead}
      sub={attachments.length ? fillTemplate(C.beilagenCount, { n: attachments.length }) : C.beilagenNone}
      onToggle={onToggle} sectionRef={sectionRef}>
      <div className="cv-beilagen">
        {attachments.length > 0 && (
          <ul className="cv-beilagen-list">
            {attachments.map((a) => (
              <li key={a.id}>
                <img src={a.url} alt="" />
                <input
                  className="cv-input" defaultValue={a.caption ?? ''} placeholder={C.beilagenCaption}
                  aria-label={C.beilagenCaption} disabled={busy}
                  onBlur={(e) => {
                    const caption = stripUnprintable(e.target.value).trim()
                    if (caption === (a.caption ?? '')) return
                    void run({ kind: 'addAttachment', id: a.id, url: a.url, caption: caption || undefined })
                      .then((ok) => { if (ok) savedToast() })
                  }}
                />
                <button type="button" className="cv-btn cv-btn-ghost" aria-label={C.beilagenRemove} title={C.beilagenRemove}
                  disabled={busy} onClick={() => { void run({ kind: 'removeAttachment', id: a.id }).then((ok) => { if (ok) savedToast() }) }}>
                  <Icon id="trash" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className={`cv-btn cv-btn-add cv-beilagen-add${uploading ? ' busy' : ''}`}>
          {/* while the upload runs the control eats taps at 60% opacity — the house busy
              glyph says WHY instead of leaving a silently dead button (App.tsx idiom) */}
          {uploading ? <ShellLoader /> : <Icon id="photo" />}<span>{uploading ? C.beilagenBusy : C.beilagenAdd}</span>
          <input type="file" accept="image/*" multiple disabled={busy || uploading}
            onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; if (files.length) void addBeilagen(files) }} />
        </label>
      </div>
    </AccSection>
  )
}
