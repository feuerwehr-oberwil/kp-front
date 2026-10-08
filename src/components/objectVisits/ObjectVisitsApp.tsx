// Objektbesuche — the surface behind the launcher's «Objektbesuche» (docs/object-visits.md).
// Its own lazy chunk (App · lazy), precached like the rest of the field app, so every address
// under /besuche opens offline.
//
// This component owns what every screen of the surface shares: the catalogue (offline copy), the
// visits on this device, the server's visit list (for list progress), the outbox runner, and the
// route. The screens below only render and edit.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconSprite } from '../../lib/icons'
import { useAuth } from '../../lib/auth'
import { objectVisitsConfig } from '../../lib/deploymentConfig'
import { loadCatalogue, loadSummaries, type CatalogueState } from '../../objectVisits/catalogue'
import { OvContext, type OvShared } from './ovContext'
import { navigateTo, ovHref, useOvRoute } from '../../objectVisits/route'
import { listLocalVisits, onVisitChanged, readVisit, type LocalVisit } from '../../objectVisits/store'
import type { VisitSummary } from '../../objectVisits/types'
import { Overview } from './Overview'
import { WorkList } from './WorkList'
import { VisitPage } from './VisitPage'
import { NewVisit } from './NewVisit'
import s from './ObjectVisits.module.css'

export default function ObjectVisitsApp({ onExit, suggestedObjectId = null }: { onExit: () => void; suggestedObjectId?: string | null }) {
  const { user, sessionExpired, logout } = useAuth()
  const route = useOvRoute() ?? { kind: 'overview' as const }
  const [cat, setCat] = useState<CatalogueState | null>(null)
  const [locals, setLocals] = useState<LocalVisit[]>([])
  const [localsOk, setLocalsOk] = useState(true)
  const [localsLoaded, setLocalsLoaded] = useState(false)
  const [summaries, setSummaries] = useState<VisitSummary[] | null>(null)

  const reloadCatalogue = useCallback(() => {
    void loadCatalogue().then(setCat)
    void loadSummaries().then((r) => { if (r) setSummaries(r.list) })
  }, [])
  useEffect(reloadCatalogue, [reloadCatalogue])

  // The device list: read whole once (and on a sequence guard, so a slow scan never lands over a
  // newer one); afterwards each change patches only the visit that changed — a keystroke on a
  // visit page writes its record and must not rescan every visit on the device.
  const scanSeq = useRef(0)
  const reloadLocals = useCallback(() => {
    const my = ++scanSeq.current
    void listLocalVisits().then((r) => {
      if (my !== scanSeq.current) return
      setLocals(r.visits); setLocalsOk(r.ok && r.unreadable === 0); setLocalsLoaded(true)
    })
  }, [])
  useEffect(() => {
    reloadLocals()
    const pending = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    const patch = () => {
      timer = null
      const ids = [...pending]
      pending.clear()
      const seq = scanSeq.current
      void Promise.all(ids.map(async (id) => [id, await readVisit(id)] as const)).then((reads) => {
        if (seq !== scanSeq.current) return // a full scan started meanwhile: it has these too
        if (reads.some(([, r]) => !r.ok)) { reloadLocals(); return }
        setLocals((cur) => {
          let next = cur
          for (const [id, r] of reads) {
            const v = r.ok ? r.value : null
            const at = next.findIndex((x) => x.doc.id === id)
            if (v && at >= 0) next = next.map((x, i) => (i === at ? v : x))
            else if (v) next = [...next, v]
            else if (at >= 0) next = next.filter((_, i) => i !== at)
          }
          return next
        })
      })
    }
    const off = onVisitChanged((id) => {
      pending.add(id)
      if (!timer) timer = setTimeout(patch, 150)
    })
    return () => { off(); if (timer) clearTimeout(timer) }
  }, [reloadLocals])

  // (the outbox runner lives in App: it must run on the launcher too — App · startOutboxRunner)

  const role = user?.role ?? 'viewer'
  // the server's word where it is fresh; the station's config otherwise (a cached catalogue may
  // have been fetched by another account on this kiosk)
  const canCapture = cat && cat.state === 'ready'
    ? cat.catalogue.canCapture
    : objectVisitsConfig().captureRoles.includes(role)

  const value = useMemo<OvShared>(() => ({
    cat, reloadCatalogue, locals, localsLoaded, localsOk, summaries,
    userId: user?.id ?? null,
    canCapture,
    sessionExpired,
    relogin: () => { void logout() },
    go: (r, opts) => navigateTo(ovHref(r), opts),
    exit: onExit,
    suggestedObjectId,
  }), [cat, reloadCatalogue, locals, localsLoaded, localsOk, summaries, user?.id, canCapture, sessionExpired, logout, onExit, suggestedObjectId])

  return (
    <OvContext.Provider value={value}>
      <div className={s.page}>
        <IconSprite />
        {route.kind === 'overview' && <Overview />}
        {route.kind === 'list' && <WorkList listRef={route.ref} />}
        {route.kind === 'new' && <NewVisit objectKey={route.object} workRef={route.ref} />}
        {route.kind === 'visit' && <VisitPage key={route.id} id={route.id} />}
      </div>
    </OvContext.Provider>
  )
}
