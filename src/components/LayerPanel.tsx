import { Fragment, useEffect, useRef } from 'react'
import type { LayerDef } from '../types'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from '../lib/format'

interface Props {
  layers: LayerDef[]
  onToggle: (id: LayerDef['id']) => void
  onOpacity: (id: LayerDef['id'], v: number) => void
  /** pre-download the current map area + plans/symbols for offline use (PWA) */
  onDownloadOffline?: () => void
  offlineProgress?: { done: number; total: number } | null
  /** round ✕ in the title row — dock chrome parity with the views popover / tool docks */
  onClose?: () => void
}

export function LayerPanel({ layers, onToggle, onOpacity, onDownloadOffline, offlineProgress, onClose }: Props) {
  const bases = layers.filter((l) => l.base)
  const groups = layers.filter((l) => !l.base).reduce<Record<string, LayerDef[]>>((acc, l) => {
    (acc[l.group] ??= []).push(l)
    return acc
  }, {})

  // opening the panel (e.g. via the [[B]] shortcut) drops focus onto the first layer row so the
  // whole list is immediately Tab/Enter navigable from the keyboard — the rows are real buttons.
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => { cardRef.current?.querySelector<HTMLButtonElement>('.lrow')?.focus() }, [])

  return (
    <div className="layers-card" ref={cardRef}>
      <div className="lc-title">
        <Icon id="layers" />{appConfig.copy.panels.layers}
        {onClose && <button type="button" className="lc-x" aria-label={appConfig.copy.closeDialog} onClick={onClose}><Icon id="close" /></button>}
      </div>

      {/* Basiskarte as the panel's first group — the base IS a layer; this replaced the separate
          BaseSwitcher popover so one pinned button covers all of it. A ONE-OF-N choice between
          three named maps reads as a row of tiles, not as three full-width rows: it says «pick
          one» at a glance and hands ~90px of sheet height back to the layers below it, which
          matters most on the phone, where the sheet is the whole screen. The grid auto-fits, so
          a deployment with two or four bases still lays out. */}
      {bases.length > 0 && (
        <>
          <div className="lgroup">{appConfig.copy.baseMap}</div>
          <div className="lbases" role="radiogroup" aria-label={appConfig.copy.baseMap}>
            {bases.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`lbase ${b.visible ? 'on' : ''}`}
                role="radio"
                aria-checked={b.visible}
                /* the full name stays reachable for anyone who doesn't know the short one */
                title={b.label}
                onClick={() => onToggle(b.id)}
              >
                <span className="lbase-ic"><Icon id={b.icon} /></span>
                <span className="lbase-t">{b.shortLabel ?? b.label}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {Object.entries(groups).map(([group, rows]) => (
        <Fragment key={group}>
          <div className="lgroup">{group}</div>
          {rows.map((l) => (
            <Fragment key={l.id}>
              {/* a real <button> so the toggle is keyboard-operable + focusable; the inline
                  resets strip native button chrome without touching .lrow's :hover rule */}
              <button
                type="button"
                className={`lrow ${l.visible ? '' : 'off'}`}
                style={{ appearance: 'none', WebkitAppearance: 'none', border: 'none', width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit' }}
                aria-pressed={l.visible}
                aria-label={`${l.label} – ${l.visible ? appConfig.copy.layerPanel.stateVisible : appConfig.copy.layerPanel.stateHidden}`}
                onClick={() => onToggle(l.id)}
              >
                <span className="ic"><Icon id={l.icon} /></span>
                <span className="name">{l.label}</span>
                {l.locked && <span className="lock"><Icon id="lock" /></span>}
                <span className="eye"><Icon id={l.visible ? 'eye' : 'eyeoff'} /></span>
              </button>
              {l.opacity !== undefined && l.visible && (
                <div className="opacity" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="range" min={0} max={100} value={l.opacity}
                    onChange={(e) => onOpacity(l.id, Number(e.target.value))}
                  />
                  <span>{l.opacity}%</span>
                </div>
              )}
            </Fragment>
          ))}
        </Fragment>
      ))}

      {onDownloadOffline && (
        <>
          <div className="lgroup">{appConfig.copy.offline.layerGroup}</div>
          <button
            className="offline-dl"
            onClick={onDownloadOffline}
            disabled={!!offlineProgress}
          >
            <Icon id="map" />
            {offlineProgress
              ? fillTemplate(appConfig.copy.offline.loadingShort, { done: offlineProgress.done, total: offlineProgress.total })
              : appConfig.copy.offline.loadMap}
          </button>
          {offlineProgress && (
            <div className="offline-bar">
              <span style={{ width: `${Math.round((offlineProgress.done / Math.max(1, offlineProgress.total)) * 100)}%` }} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
