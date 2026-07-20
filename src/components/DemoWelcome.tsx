import { useEffect } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'

// First-visit welcome for demo instances: a light, one-screen intro of what this is and what a
// visitor can / can't do (the local-sandbox contract). Shown once per device (see demoWelcome.ts)
// so it never re-nags. Reuses the shared .modal-backdrop scrim; dismissed by the CTA, the ×,
// clicking the scrim, or Esc.
export function DemoWelcome({ onClose }: { onClose: () => void }) {
  const C = appConfig.copy.demo.welcome
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop dw-scrim" onClick={onClose}>
      <div className="dw-card" role="dialog" aria-modal="true" aria-label={C.title} onClick={(e) => e.stopPropagation()}>
        <button className="dw-x" onClick={onClose} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
        <div className="dw-head">
          <span className="dw-badge">{appConfig.copy.demo.ribbon}</span>
          <h2 className="dw-title">{C.title}</h2>
        </div>
        <p className="dw-intro">{C.intro}</p>
        <div className="dw-warn" role="note"><Icon id="warn" /><span>{C.reloadWarn}</span></div>
        <div className="dw-sec">
          <h3><Icon id="check" />{C.canTitle}</h3>
          <ul>{C.can.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
        <div className="dw-sec dw-know">
          <h3><Icon id="info" />{C.knowTitle}</h3>
          <ul>{C.know.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
        <button className="dw-cta" onClick={onClose}>{C.cta}</button>
      </div>
    </div>
  )
}
