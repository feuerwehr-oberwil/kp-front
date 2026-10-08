import { Icon } from '../lib/icons'
import { Overlay } from '../lib/overlays'
import { appConfig } from '../config/appConfig'
import { Button } from './Button'

// First-visit welcome for demo instances: a light, one-screen intro of what this is and what a
// visitor can / can't do (the shared-demo contract). Shown once per device (see demoWelcome.ts)
// so it never re-nags. Uses the shared <Overlay> (focus trap, scroll-lock, Esc, backdrop-close).
export function DemoWelcome({ onClose }: { onClose: () => void }) {
  const C = appConfig.copy.demo.welcome
  return (
    <Overlay open onClose={onClose} className="dw-card" backdropClassName="modal-backdrop dw-scrim" ariaLabel={C.title}>
        <button className="ip-x dw-x" onClick={onClose} aria-label={appConfig.copy.closeDialog}><Icon id="close" /></button>
        <div className="dw-head">
          <span className="ip-badge ip-badge-exercise">{appConfig.copy.demo.ribbon}</span>
          <h2 className="dw-title">{C.title}</h2>
        </div>
        <p className="dw-intro">{C.intro}</p>
        <div className="form-warn form-warn-amber dw-warn" role="note"><Icon id="warn" /><span className="form-warn-text">{C.reloadWarn}</span></div>
        <div className="dw-sec">
          <h3>{C.canTitle}</h3>
          <ul>{C.can.map((t) => <li key={t}><Icon id="check" /><span>{t}</span></li>)}</ul>
        </div>
        {/* `dw-cta` has no rule any more: it is the e2e's handle (e2e/helpers · demo.spec) */}
        <Button variant="primary" size="lg" block className="dw-cta" onClick={onClose}>{C.cta}</Button>
        <p className="dw-meta">{C.meta}</p>
    </Overlay>
  )
}
