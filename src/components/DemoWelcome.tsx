import { Icon } from '../lib/icons'
import { Overlay } from '../lib/overlays'
import { appConfig } from '../config/appConfig'

// First-visit welcome for demo instances: a light, one-screen intro of what this is and what a
// visitor can / can't do (the local-sandbox contract). Shown once per device (see demoWelcome.ts)
// so it never re-nags. Uses the shared <Overlay> (focus trap, scroll-lock, Esc, backdrop-close).
export function DemoWelcome({ onClose }: { onClose: () => void }) {
  const C = appConfig.copy.demo.welcome
  return (
    <Overlay open onClose={onClose} className="dw-card" backdropClassName="modal-backdrop dw-scrim" ariaLabel={C.title}>
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
    </Overlay>
  )
}
