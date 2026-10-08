// Small shared pieces of the Objektbesuche surface: the head, a section eyebrow, dates, photos.

import type { ReactNode } from 'react'
import { Icon } from '../../lib/icons'
import { IconButton } from '../Button'
import { appConfig } from '../../config/appConfig'
import { usePhotoUrl } from './ovFormat'
import s from './ObjectVisits.module.css'

export function Head({ title, sub, subNode, onBack, actions }: {
  title: string
  sub?: string | null
  /** a second line that is a control of its own (the visit's status line) — replaces `sub` */
  subNode?: ReactNode
  onBack?: () => void
  actions?: ReactNode
}) {
  const C = appConfig.copy.objectVisits
  return (
    <div className={s.headBar}>
      <header className={s.head}>
        {onBack && (
          <IconButton label={C.back} onClick={onBack}>
            <Icon id="chevron-left" />
          </IconButton>
        )}
        <div className={s.headTitles}>
          <h1>{title}</h1>
          {subNode ?? (sub && <p>{sub}</p>)}
        </div>
        {actions}
      </header>
    </div>
  )
}

export function Section({ title, count, aside, children }: { title: string; count?: number; aside?: string; children?: ReactNode }) {
  return (
    <>
      <h2 className={s.sec}>
        {title}
        {count != null && count > 0 && <span className={s.count}>{count}</span>}
        {aside && <span className={s.mono}>{aside}</span>}
      </h2>
      {children}
    </>
  )
}

export function Thumb({ visitId, attId, alt, pending }: { visitId: string; attId: string; alt: string; pending?: boolean }) {
  const { url } = usePhotoUrl(visitId, attId)
  const C = appConfig.copy.objectVisits
  return (
    <span className={s.thumb}>
      {url && <img src={url} alt={alt} loading="lazy" />}
      {pending && (
        <span className={s.thumbBadge} title={C.photoPending} aria-label={C.photoPending}><Icon id="upload" /></span>
      )}
    </span>
  )
}
