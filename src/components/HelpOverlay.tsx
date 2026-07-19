import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from '../lib/deploymentConfig'

// In-app capabilities/help overlay reached from the incident menu ("Funktionen &
// Hilfe"). One scrollable column of feature sections with a sticky TOC + scroll-spy.
// Content is authored as data in appConfig.copy.help.sections (no markdown dependency)
// so it bundles offline; inline markup is **bold** + [[key]] keyboard chips.

// Parse the lightweight inline markup of a help string into React nodes:
//   **text** → bold, [[key]] → keyboard chip, everything else → plain text.
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /\*\*(.+?)\*\*|\[\[(.+?)\]\]/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1] !== undefined) out.push(<b key={i++}>{m[1]}</b>)
    else out.push(<span key={i++} className="help-kbd">{m[2]}</span>)
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const C = appConfig.copy.help
  const sections = C.sections
  const intro = getDeploymentConfig().identity?.helpIntro ?? C.introFallback
  const [active, setActive] = useState(sections[0].id)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // scroll-spy — highlight the TOC entry of the section nearest the top of the scroller
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (vis[0]) setActive(vis[0].target.id)
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    )
    sections.forEach((s) => { const el = document.getElementById(`help-${s.id}`); if (el) obs.observe(el) })
    return () => obs.disconnect()
  }, [sections])

  const go = (id: string) => document.getElementById(`help-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className="help-scrim" onClick={onClose}>
      <div className="help-modal" role="dialog" aria-modal="true" aria-label={C.title} onClick={(e) => e.stopPropagation()}>
        <div className="help-head">
          <span className="help-head-ic"><Icon id="info" /></span>
          <div className="help-head-tt">
            <h2>{C.title}</h2>
            <p>{C.subtitle}</p>
          </div>
          <button className="help-x" onClick={onClose} aria-label={C.close}><Icon id="close" /></button>
        </div>
        <div className="help-body">
          <nav className="help-toc">
            <div className="help-toc-h">{C.contents}</div>
            {sections.map((s) => (
              <button key={s.id} className={`help-toc-i${active === s.id ? ' on' : ''}`} onClick={() => go(s.id)}>
                <Icon id={s.icon} />{s.title}
              </button>
            ))}
          </nav>
          <div className="help-content" ref={scrollRef}>
            {sections.map((s) => (
              <section key={s.id} id={`help-${s.id}`} className="help-sec">
                <h3><Icon id={s.icon} />{s.title}</h3>
                {s.blocks.map((b, i) => {
                  switch (b.kind) {
                    case 'intro':
                      return <p key={i} className="help-lead">{intro}</p>
                    case 'lead':
                      return <p key={i} className="help-lead">{renderInline(b.text)}</p>
                    case 'sub':
                      return <p key={i} className="help-sub">{renderInline(b.text)}</p>
                    case 'note':
                      return <div key={i} className="help-note"><Icon id="info" /><span>{renderInline(b.text)}</span></div>
                    case 'list':
                      return (
                        <ul key={i} className="help-list">
                          {b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}
                        </ul>
                      )
                    default:
                      return null
                  }
                })}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
