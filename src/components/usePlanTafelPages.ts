// The Tafel's pages on the Plan (docs/board-templates.md): «+ Seite» pre-filled from what the
// Einsatz knows, writing on a page, printing one or all as a PDF, removing one (a tombstone, one
// ↶ step) and landing on it again when ↶ brings it back, and PageUp / PageDown along the strip.
// Each act is ONE ↶ step on the Tafel's own stack. Lifted out of the Whiteboard (sweep A.1,
// 25.10.2026); which page this device looks at is lib/tafelPages · useTafelPage.

import { useEffect, useRef, useState } from 'react'
import { appConfig } from '../config/appConfig'
import type { BoardAnno } from '../types'
import { fillTemplate } from '../lib/format'
import { confirmDialog, toast } from '../lib/ui'
import { serverNow, serverNowIso } from '../lib/serverClock'
import { formAnno, formDelta, formHasContent, newFormPage, type BoardFormData, type FormAnno } from '../lib/boardForm'
import { labelText, type BoardTemplate, type TemplatePage } from '../lib/boardTemplate'
import { SKIZZE, stepPage } from '../lib/tafelPages'
import { isTypingTarget } from '../lib/hotkeys'
import type { useBoardDoc } from './useBoardDoc'
import type { PlanLogExtra, TafelPagesProps } from './Whiteboard'

/** printing a Tafel page found no server (or could not even load its print module): offline */
class OfflineChunk extends Error {}

interface Args {
  /** the Tafel is the open sheet and has its pages (an Einsatz-Link session has none) */
  onTafel: boolean
  pages: FormAnno[]
  /** «Konzept», «Konzept 2» … (lib/boardForm · pageTitles) */
  titles: Map<string, string>
  /** the page this device looks at, and the way to another */
  page: string
  setPageSel: (page: string) => void
  readOnly: boolean
  tafel?: TafelPagesProps
  incidentId?: string
  add: (a: BoardAnno) => void
  patchCommit: ReturnType<typeof useBoardDoc>['patchCommit']
  log: (icon: string, text: string, extra?: PlanLogExtra) => void
  onStepLabel?: (label: string) => void
}

/** The Tafel's page acts; see the file header. */
export function usePlanTafelPages({ onTafel, pages, titles, page, setPageSel, readOnly, tafel, incidentId, add, patchCommit, log, onStepLabel }: Args) {
  const TP = () => appConfig.copy.tafel
  /** «+ Seite»: the page, pre-filled from what the Einsatz knows — or the page itself, when it is
   *  already on the Tafel (one of each; a second «Erste Führung» would only split the record) */
  const addPage = (tpl: BoardTemplate, p: TemplatePage) => {
    const same = pages.filter((x) => x.form.tpl.id === tpl.id && x.form.page.id === p.id)
    // a page of its kind is there: go to it — unless the page may be added again (a second
    // Konzept, the next Rapport: owner, 10.10. evening), which makes a page of its own
    if (same.length && !p.repeatable) { setPageSel(same[0].id); return }
    if (readOnly || !tafel) return
    const a = formAnno(newFormPage(tpl, p, tafel.seed(), serverNowIso()))
    const title = same.length ? `${labelText(p.title)} ${same.length + 1}` : labelText(p.title)
    const line = fillTemplate(TP().pageAdded, { page: title })
    onStepLabel?.(line)
    add(a)
    log('doc', line, { subjectId: a.id })
    setPageSel(a.id)
  }
  const editPage = (id: string, next: BoardFormData) => {
    if (readOnly) return
    onStepLabel?.(fillTemplate(TP().pageEdited, { page: titles.get(id) ?? labelText(next.page.title) }))
    // the audit row names the cells that changed, never the whole page again (review of #338)
    const prev = pages.find((p) => p.id === id)?.form
    patchCommit(id, { form: next }, { form: { page: next.page.id, delta: prev ? formDelta(prev, next) : [] } })
  }
  /** a page with writing on it asks first; ↶ brings it back either way */
  /** «Drucken» on a page (owner): this page or all of them as a PDF — the server draws the
   *  paper (lib/tafelPrint, loaded on the tap); offline that is said calmly, never an error */
  const [printing, setPrinting] = useState(false)
  const printPages = async (list: FormAnno[]) => {
    if (!incidentId || printing || !list.length) return
    setPrinting(true)
    try {
      const { printTafelPages, TafelPrintOffline } = await import('../lib/tafelPrint').catch(() => { throw new OfflineChunk() })
      try {
        await printTafelPages(list, { id: incidentId, title: tafel?.title?.() ?? '' }, tafel?.scene, titles)
      } catch (e) {
        if (e instanceof TafelPrintOffline) throw new OfflineChunk()
        throw e
      }
    } catch (e) {
      if (e instanceof OfflineChunk) toast(TP().printOffline, { icon: 'info' })
      else toast(TP().printFailed, { icon: 'warn', tone: 'warn' })
    } finally {
      setPrinting(false)
    }
  }
  const removePage = async (id: string) => {
    const a = pages.find((x) => x.id === id)
    if (!a || readOnly) return
    const name = titles.get(a.id) ?? labelText(a.form.page.title)
    if (formHasContent(a.form) && !await confirmDialog({
      title: TP().removeTitle, message: fillTemplate(TP().removeMsg, { page: name }),
      confirmLabel: TP().removePage, cancelLabel: appConfig.copy.cancel, danger: true,
    })) return
    const line = fillTemplate(TP().pageRemoved, { page: name })
    onStepLabel?.(line)
    // a TOMBSTONE, not a deletion (re-review of #338): a device still writing on the page must be
    // able to tell whether its writing came after this (lib/mergeWorkspace · resolveTactical).
    // One ↶ step like any edit; findForms no longer shows, prints or offers it.
    patchCommit(a.id, { form: { ...a.form, removedAt: serverNow() } }, { form: { page: a.form.page.id, removed: true } })
    log('trash', line, { subjectId: a.id })
    removedPage.current = a.id
    setPageSel(SKIZZE)
  }
  // …and when ↶ brings it back, the operator lands on it again rather than hunting the strip
  const removedPage = useRef<string | null>(null)
  useEffect(() => {
    const back = removedPage.current
    if (back && pages.some((p) => p.id === back)) { removedPage.current = null; setPageSel(back) }
  }, [pages, setPageSel])
  // PageUp / PageDown walk the strip while no field has the keyboard (no swipe: that pans)
  useEffect(() => {
    if (!onTafel) return
    const order = [SKIZZE, ...pages.map((p) => p.id)]
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'PageUp' && e.key !== 'PageDown') || e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(document.activeElement)) return
      e.preventDefault()
      setPageSel(stepPage(order, page, e.key === 'PageDown' ? 1 : -1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onTafel, pages, page, setPageSel])

  return { addPage, editPage, printPages, printing, removePage }
}
