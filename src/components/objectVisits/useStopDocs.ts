// The other visits at a stop, as documents, for a finished visit's read view (VisitPage ·
// StopCards): the device copy where there is one, else the server's (read-only).

import { useEffect, useState } from 'react'
import { getVisit } from '../../objectVisits/api'
import { stripServer } from '../../objectVisits/doc'
import type { LocalVisit } from '../../objectVisits/store'
import { personName, type VisitDoc } from '../../objectVisits/types'

export interface StopDoc {
  doc: VisitDoc
  /** the account, for «Von» where nobody was typed */
  byName: string | null
}

/** A visit that cannot be read is left out — its card would be empty. */
export function useStopDocs(ids: string[], locals: LocalVisit[]): Map<string, StopDoc> {
  const [remote, setRemote] = useState<Map<string, StopDoc>>(() => new Map())
  const key = ids.join('|')
  useEffect(() => {
    let alive = true
    const missing = key ? key.split('|').filter((id) => !locals.some((l) => l.doc.id === id)) : []
    for (const id of missing) {
      void getVisit(id).then((v) => {
        if (alive) setRemote((m) => new Map(m).set(id, { doc: stripServer(v), byName: personName(v.createdBy) || null }))
      }).catch(() => {})
    }
    return () => { alive = false }
    // the device list changes on every keystroke elsewhere; only a NEW id needs the server
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const out = new Map<string, StopDoc>()
  for (const id of ids) {
    const l = locals.find((x) => x.doc.id === id)
    if (l) out.set(id, { doc: l.doc, byName: personName(l.server?.createdBy ?? null) || null })
    else if (remote.has(id)) out.set(id, remote.get(id)!)
  }
  return out
}
