import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { Overlay } from '../lib/overlays'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'
import { atemschutzDoctrine, getDeploymentConfig } from '../lib/deploymentConfig'
import { DEFAULT_HOURS_ROUNDING } from '../lib/attendanceHours'

// In-app capabilities/help overlay reached from the incident menu ("Funktionen &
// Hilfe"). One scrollable column of feature sections with a sticky TOC + scroll-spy.
// Content is authored as data in appConfig.copy.help.sections (no markdown dependency)
// so it bundles offline; inline markup is **bold** + [[key]] keyboard chips.

/**
 * Wrap every occurrence of `q` in a plain string with <mark>. Case-insensitive and
 * literal — a search box is not a regex prompt, so the query is escaped before use.
 * Returns the string untouched when there is nothing to mark, so the common (unfiltered)
 * render allocates nothing.
 */
function mark(text: string, q: string, keyBase: string): ReactNode {
  if (!q) return text
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    // a zero-length match would spin forever; a query is trimmed but be safe
    if (m[0] === '') { re.lastIndex += 1; continue }
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(<mark key={`${keyBase}-${i++}`} className="help-hit">{m[0]}</mark>)
    last = re.lastIndex
  }
  if (!out.length) return text
  if (last < text.length) out.push(text.slice(last))
  return out
}

// Parse the lightweight inline markup of a help string into React nodes:
//   **text** → bold, [[key]] → keyboard chip, everything else → plain text.
// `q` (the active search) marks the hits in the plain runs AND inside the bold ones. The bold
// runs are the feature names — «**Atemschutz**», «**Ebenen**» — so they are precisely what
// someone searches for; skipping them left a search for "atemschutz" with almost nothing
// marked in the body. Keyboard chips stay untouched: [[Esc]] is a key, not a word.
/**
 * The station's own numbers, for the help strings that would otherwise state a default as if it
 * were the rule. «Überfällig nach ~5 Min.» was not merely generic — it was WRONG: red fires at
 * Intervall + Nachfrist, which is 6 minutes on the shipped defaults and whatever a Wehr set
 * otherwise. A help text that teaches the wrong safety threshold is worse than none.
 *
 * Read per call rather than at module load, so the boot-resolved deployment config applies.
 */
function helpVars(): Record<string, string | number> {
  const az = atemschutzDoctrine()
  const r = getDeploymentConfig().report?.hoursRounding
  return {
    contactMin: az.contactIntervalMin,
    graceSec: az.contactGraceSec,
    // what the operator actually watches for: the moment the card goes red
    overdueMin: Math.round(((az.contactIntervalMin * 60 + az.contactGraceSec) / 60) * 10) / 10,
    pressureStep: az.pressureStep,
    alarmBar: az.alarmBar,
    hoursStep: r?.stepMin ?? DEFAULT_HOURS_ROUNDING.stepMin,
    hoursGrace: r?.graceMin ?? DEFAULT_HOURS_ROUNDING.graceMin,
  }
}

function renderInline(text: string, q = ''): ReactNode[] {
  const out: ReactNode[] = []
  // the station's live numbers land before the markup is parsed, so a placeholder inside a
  // **bold** run works exactly like one outside it
  text = fillTemplate(text, helpVars())
  const re = /\*\*(.+?)\*\*|\[\[(.+?)\]\]/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(mark(text.slice(last, m.index), q, `p${i}`))
    if (m[1] !== undefined) out.push(<b key={i++}>{mark(m[1], q, `b${i}`)}</b>)
    else out.push(<span key={i++} className="help-kbd">{m[2]}</span>)
    last = re.lastIndex
  }
  if (last < text.length) out.push(mark(text.slice(last), q, `p${i}`))
  return out
}

// Everything in a section that a search should be able to hit: its heading plus every block's
// text, with the inline markup stripped — searching «Ebenen» has to match «**Ebenen**», and a
// keyboard chip's [[Esc]] has to match «esc».
type HelpSection = (typeof appConfig.copy.help.sections)[number]
function sectionHaystack(s: HelpSection, intro: string): string {
  const parts: string[] = [s.title]
  for (const b of s.blocks) {
    if (b.kind === 'intro') parts.push(intro)
    else if (b.kind === 'list') parts.push(...b.items)
    else if ('text' in b) parts.push(b.text)
  }
  return parts.join(' ').replace(/\*\*|\[\[|\]\]/g, '').toLowerCase()
}

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const C = appConfig.copy.help
  const allSections = C.sections
  const intro = getDeploymentConfig().identity?.helpIntro ?? C.introFallback
  const [query, setQuery] = useState('')
  // The help is long and gets opened WITH a question, not to be read. The filter narrows the
  // TOC and the sections themselves — on a phone the TOC is hidden (see .help-toc in app.css),
  // so filtering the content is the entire search there.
  const haystacks = useMemo(
    () => new Map(allSections.map((s) => [s.id, sectionHaystack(s, intro)])),
    [allSections, intro],
  )
  const q = query.trim().toLowerCase()
  const sections = useMemo(
    () => (q ? allSections.filter((s) => haystacks.get(s.id)?.includes(q)) : allSections),
    [allSections, haystacks, q],
  )
  const [active, setActive] = useState(allSections[0].id)
  const scrollRef = useRef<HTMLDivElement>(null)

  // No Esc listener here: the <Overlay> this renders into already closes on Escape. The duplicate
  // window listener fired onClose a second time on the same key press.

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

  // a narrowed result set starts at ITS top — otherwise the scroller keeps the offset of the
  // unfiltered list and the first hit sits somewhere above the fold
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }) }, [q])

  const go = (id: string) => document.getElementById(`help-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <Overlay open onClose={onClose} className="help-modal" backdropClassName="help-scrim" ariaLabel={C.title}>
        <div className="help-head">
          <span className="help-head-ic"><Icon id="info" /></span>
          <div className="help-head-tt">
            <h2>{C.title}</h2>
            <p>{C.subtitle}</p>
          </div>
          <button className="help-x" onClick={onClose} aria-label={C.close}><Icon id="close" /></button>
        </div>
        {/* the search lives in the HEADER, not above the TOC: the TOC is hidden on a phone,
            and that is exactly where someone is standing with one question and no patience */}
        <div className="help-search">
          <Icon id="search" />
          <input type="search" value={query} placeholder={C.search} aria-label={C.search}
            autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} enterKeyHint="search"
            onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button type="button" className="help-search-x" aria-label={C.searchClear} onClick={() => setQuery('')}>
              <Icon id="close" />
            </button>
          )}
        </div>
        <div className="help-body">
          <nav className="help-toc">
            {/* no heading over an empty list — a lone «Inhalt» label reads like a failed render */}
            {sections.length > 0 && <div className="help-toc-h">{C.contents}</div>}
            {sections.map((s) => (
              <button key={s.id} className={`help-toc-i${active === s.id ? ' on' : ''}`} onClick={() => go(s.id)}>
                <Icon id={s.icon} />{mark(s.title, q, `t${s.id}`)}
              </button>
            ))}
          </nav>
          <div className="help-content" ref={scrollRef}>
            {sections.length === 0 && (
              <div className="help-empty">
                {/* the verdict first and loudest, the way out under it — not the other way round */}
                <p className="help-sub">{fillTemplate(C.searchNone, { q: query.trim() })}</p>
                <p className="help-lead">{C.searchHint}</p>
              </div>
            )}
            {sections.map((s) => (
              <section key={s.id} id={`help-${s.id}`} className="help-sec">
                <h3><Icon id={s.icon} />{mark(s.title, q, 'h')}</h3>
                {s.blocks.map((b, i) => {
                  switch (b.kind) {
                    case 'intro':
                      return <p key={i} className="help-lead">{mark(intro, q, `i${i}`)}</p>
                    case 'lead':
                      return <p key={i} className="help-lead">{renderInline(b.text, q)}</p>
                    case 'sub':
                      return <p key={i} className="help-sub">{renderInline(b.text, q)}</p>
                    case 'note':
                      return <div key={i} className="help-note"><Icon id="info" /><span>{renderInline(b.text, q)}</span></div>
                    case 'list':
                      return (
                        <ul key={i} className="help-list">
                          {b.items.map((it, j) => <li key={j}>{renderInline(it, q)}</li>)}
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
    </Overlay>
  )
}
