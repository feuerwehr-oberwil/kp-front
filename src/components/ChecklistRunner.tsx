import { Icon } from '../lib/icons'
import type { ChecklistTemplate, Item, Phase, TemplateState } from '../lib/checklists'
import { phaseItems, phaseProgress, templateProgress } from '../lib/checklists'
import { cx } from '../lib/cx'
import { Segmented } from './Segmented'
import { formatTime } from '../lib/format'
import { appConfig } from '../config/appConfig'
import s from './Checklists.module.css'

// Ticks store a full ISO timestamp (append-only record); show only HH:MM inline. Guard
// against any legacy tick that already held a display string.
const tickTime = (t: string) => (t.includes('T') ? formatTime(new Date(t)) : t)

// Action / rapport checklist: phases → checkable items, branch toggles, per-phase
// and overall progress. Gloved-friendly: big tap targets. Ticking writes to the
// per-incident state (presence in `ticks` = checked); milestone ticks also surface
// in the Verlauf + audit trail (handled by the onTick callback in App).

const actionIcon: Record<NonNullable<Item['action']>, string> = {
  journal: 'history',
  plan: 'doc',
  draw: 'pen',
}

function Bar({ done, total, pct }: { done: number; total: number; pct: number }) {
  return (
    <div className={s['cl-bar']} title={`${done}/${total}`}>
      <span className={s['cl-bar-fill']} style={{ width: `${pct}%` }} />
    </div>
  )
}

function ItemRow({
  item, checked, tickInfo, canTick, onToggle, onAction,
}: {
  item: Item
  checked: boolean
  tickInfo?: { t: string; by?: string }
  canTick: boolean
  onToggle: () => void
  onAction?: (a: NonNullable<Item['action']>) => void
}) {
  const CL = appConfig.copy.checklists
  return (
    <div className={cx(s['cl-item'], checked && s.done)}>
      <button
        className={s['cl-check']}
        role="checkbox"
        aria-checked={checked}
        aria-label={item.text}
        disabled={!canTick}
        onClick={onToggle}
      >
        {checked && <Icon id="check" />}
      </button>
      <div
        className={cx(s['cl-item-body'], canTick && s['cl-item-tap'])}
        onClick={canTick ? onToggle : undefined}
      >
        <div className={s['cl-item-text']}>{item.text}</div>
        <div className={s['cl-item-meta']}>
          {item.when && <span className={s['cl-when']}>{item.when}</span>}
          {item.milestone && <span className={s['cl-milestone']} title={CL.milestoneTitle}><Icon id="flag" /></span>}
          {checked && tickInfo && (
            <span className={s['cl-tickinfo']}>
              {tickTime(tickInfo.t)}{tickInfo.by ? ` · ${tickInfo.by}` : ''}
            </span>
          )}
        </div>
      </div>
      {item.action && onAction && (
        <button className={s['cl-deeplink']} onClick={() => onAction(item.action!)} title={CL.actionLabels[item.action]}>
          <Icon id={actionIcon[item.action]} />
          <span>{CL.actionLabels[item.action]}</span>
          <Icon id="chevron" />
        </button>
      )}
    </div>
  )
}

function PhaseBlock({
  phase, state, canTick, onToggle, onBranch, onAction,
}: {
  phase: Phase
  state: TemplateState
  canTick: boolean
  onToggle: (item: Item) => void
  onBranch: (phaseId: string, branchId: string) => void
  onAction: (item: Item, a: NonNullable<Item['action']>) => void
}) {
  const CL = appConfig.copy.checklists
  const activeBranch = state.activeBranch?.[phase.id]
  const items = phaseItems(phase, activeBranch)
  const pr = phaseProgress(phase, state)
  const ticks = state.ticks ?? {}
  return (
    <section className={s['cl-phase']}>
      <header className={s['cl-phase-head']}>
        <div className={s['cl-phase-titles']}>
          <h3>{phase.title}</h3>
          {phase.role && <span className={s['cl-role']}>{phase.role}</span>}
        </div>
        <span className={s['cl-phase-count']}>{pr.done}/{pr.total}</span>
      </header>
      {pr.total > 0 && <Bar {...pr} />}
      {phase.note && <p className={s['cl-note']}>{phase.note}</p>}

      {phase.branches?.length ? (
        <Segmented
          ariaLabel={CL.variantLabel}
          value={activeBranch}
          onChange={(id) => onBranch(phase.id, id)}
          options={phase.branches.map((b) => ({
            value: b.id,
            label: b.title,
            disabled: !canTick && activeBranch !== b.id,
          }))}
        />
      ) : null}

      <div className={s['cl-items']}>
        {items.map((it) => (
          <ItemRow
            key={it.id}
            item={it}
            checked={!!ticks[it.id]}
            tickInfo={ticks[it.id]}
            canTick={canTick}
            onToggle={() => onToggle(it)}
            onAction={(a) => onAction(it, a)}
          />
        ))}
        {!items.length && phase.branches?.length && (
          <p className={s['cl-empty-hint']}>{CL.pickVariant}</p>
        )}
      </div>
    </section>
  )
}

export function ChecklistRunner({
  template, state, canTick, onToggle, onBranch, onAction,
}: {
  template: ChecklistTemplate
  state: TemplateState
  canTick: boolean
  onToggle: (item: Item) => void
  onBranch: (phaseId: string, branchId: string) => void
  onAction: (item: Item, a: NonNullable<Item['action']>) => void
}) {
  const CL = appConfig.copy.checklists
  const overall = templateProgress(template, state)
  return (
    <div className={s['cl-runner']}>
      <header className={s['cl-runner-head']}>
        <div className={s['cl-runner-titles']}>
          <h2>{template.title}</h2>
          {template.subtitle && <p>{template.subtitle}</p>}
        </div>
        <div className={s['cl-overall']}>
          <span className={s['cl-overall-num']}>{overall.pct}%</span>
          <Bar {...overall} />
          <span className={s['cl-overall-sub']}>{overall.done}/{overall.total} {CL.done}</span>
        </div>
      </header>
      {(template.phases ?? []).map((p) => (
        <PhaseBlock
          key={p.id}
          phase={p}
          state={state}
          canTick={canTick}
          onToggle={onToggle}
          onBranch={onBranch}
          onAction={onAction}
        />
      ))}
      <footer className={s['cl-runner-foot']}>{template.source}</footer>
    </div>
  )
}
