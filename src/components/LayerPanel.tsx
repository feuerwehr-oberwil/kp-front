import { Fragment } from 'react'
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

  return (
    <div className="layers-card">
      <div className="lc-title">
        <Icon id="layers" />{appConfig.copy.panels.layers}
        {onClose && <button type="button" className="lc-x" aria-label={appConfig.copy.closeDialog} onClick={onClose}><Icon id="close" /></button>}
      </div>

      {/* Basiskarte as the panel's first group (radio rows) — the base IS a layer; this
          replaced the separate BaseSwitcher popover so one pinned button covers all of it */}
      {bases.length > 0 && (
        <>
          <div className="lgroup">{appConfig.copy.baseMap}</div>
          {bases.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`lrow ${b.visible ? '' : 'off'}`}
              style={{ appearance: 'none', WebkitAppearance: 'none', border: 'none', width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit' }}
              role="radio"
              aria-checked={b.visible}
              onClick={() => onToggle(b.id)}
            >
              <span className="ic"><Icon id={b.icon} /></span>
              <span className="name">{b.label}</span>
              {b.visible && <span className="eye"><Icon id="check" /></span>}
            </button>
          ))}
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
